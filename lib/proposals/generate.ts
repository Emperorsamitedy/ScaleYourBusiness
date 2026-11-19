// Proposal generation v1 — Phase 3 Session A (P3-04).
//
// The diagnosis already framed and worded every recommendation
// (CALIBRATED prompts, findings pointing at evidence, scenarios whose
// numbers came out of deterministic arithmetic). Generation re-writes
// none of it. What it adds:
//   · classify each recommendation into the closed ACTION_KINDS set —
//     Haiku, a classification, not prose; injectable seam like P3-03's
//   · run rule 14, and record the proposal — pending, or born blocked
//     with the owner's own words as the caption
//   · turn open interrupt-severity anomalies into investigate proposals
//     from a deterministic template: no model call at all
//
// Dedupe is by originating_finding ("report:<id>:rec:<n>" /
// "anomaly:<id>"), checked BEFORE classification so a re-run costs no
// model calls for work already done. A recommendation the owner already
// declined on the report is skipped — the decline is a decision, and
// re-proposing it would be nagging (P3-28 formalises this).

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { anomalies, businessProfiles, diagnosisReports, proposals } from "../../db/schema";
import { readAnswer } from "../llm/answer";
import { anthropicClient } from "../llm/client";
import { buildCallRecord, recordLlmCall } from "../llm/cost-log";
import type { StoredRecommendation } from "../report/service";
import type { ActionKind, HardLimit, LimitLlm } from "./hard-limits";
import {
  ACTION_KINDS,
  checkHardLimits,
  ensureHardLimits,
  limitCaption,
  liveLimitLlm,
} from "./hard-limits";
import type { ProposalRow } from "./service";
import { createProposal } from "./service";
import { suppressedKinds } from "../trust/suppression";

export const PROPOSAL_EXPIRY_DAYS = 14;
export const CLASSIFY_MODEL = "claude-haiku-5-5";

/** The classification seam — text in, one ACTION_KINDS member out. */
export type ClassifyLlm = (args: {
  system: string;
  user: string;
  accountId: string;
}) => Promise<{ text: string }>;

const CLASSIFY_SCHEMA = {
  type: "object" as const,
  properties: { kind: { type: "string" as const, enum: [...ACTION_KINDS] } },
  required: ["kind"],
  additionalProperties: false,
};

/** Exported for the live check (npm run verify:models). */
export const CLASSIFY_SYSTEM = `You classify a business recommendation into exactly one action kind. The kinds:
${ACTION_KINDS.map((k) => `  · ${k}`).join("\n")}

Pick the kind that names what the recommendation would DO if acted on — not its goal. A price rise is price_increase even if the goal is margin. Anything that is purely internal process is operations_change. Return JSON only: {"kind": "<one of the kinds>"}`;

export const liveClassifyLlm: ClassifyLlm = async ({ system, user, accountId }) => {
  const started = Date.now();
  const response = await anthropicClient().messages.create({
    model: CLASSIFY_MODEL,
    // Thinking counts toward max_tokens: 100 left no room before the one-word kind.
    max_tokens: 1_000,
    system,
    output_config: {
      // One enum value out of a closed set is classification: the lowest effort.
      effort: "low",
      format: { type: "json_schema", schema: CLASSIFY_SCHEMA },
    },
    messages: [{ role: "user", content: user }],
  });
  const record = buildCallRecord({
    workload: "parser",
    account_id: accountId,
    model: CLASSIFY_MODEL,
    duration_ms: Date.now() - started,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
  });
  await recordLlmCall(record);
  // A refusal comes back as no text: coerceKind gives null and the
  // recommendation is skipped as unclassifiable, never given a guessed kind.
  const { text } = readAnswer(response, record);
  return { text };
};

/** null = unclassifiable; the caller SKIPS rather than guessing a kind. */
export function coerceKind(text: string): ActionKind | null {
  try {
    const parsed = JSON.parse(text) as { kind?: unknown };
    if (
      typeof parsed.kind === "string" &&
      (ACTION_KINDS as readonly string[]).includes(parsed.kind)
    ) {
      return parsed.kind as ActionKind;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export interface GenerationOutcome {
  created: ProposalRow[];
  /** Born blocked (rule 14) — the restraint view's rows. */
  blocked: ProposalRow[];
  skipped: { ref: string; reason: string }[];
}

export interface GenerateOptions {
  classify?: ClassifyLlm;
  limitLlm?: LimitLlm;
  now?: Date;
}

function expiry(now: Date): string {
  return new Date(now.getTime() + PROPOSAL_EXPIRY_DAYS * 86_400_000).toISOString();
}

/** A qualitative scenario for anomaly investigations — no invented numbers. */
function anomalyScenario(detail: string) {
  const outcome = (c: "base" | "downside" | "upside", statement: string) => ({
    case: c,
    statement,
    profit_delta_monthly: null,
    formula: null,
  });
  return {
    assumptions: [
      { statement: detail, value: null, source_field: null, sensitivity: "high" as const },
    ],
    base_case: outcome("base", "The cause is found and named within a day of looking."),
    downside_case: outcome("downside", "The dip is real and continues while uninvestigated."),
    upside_case: outcome("upside", "It is a data artefact and the series is corrected."),
    breakeven_condition: "not applicable: investigating changes nothing by itself",
  };
}

/**
 * Generate proposals for a profile from its latest diagnosis report and
 * its open interrupt anomalies. Idempotent per source: re-running skips
 * everything already proposed, at zero model cost.
 */
export async function generateProposals(
  profileId: string,
  opts: GenerateOptions = {},
): Promise<GenerationOutcome> {
  const classify = opts.classify ?? liveClassifyLlm;
  const now = opts.now ?? new Date();
  const out: GenerationOutcome = { created: [], blocked: [], skipped: [] };

  const [report] = await db
    .select({ id: diagnosisReports.id, recommendations: diagnosisReports.recommendations })
    .from(diagnosisReports)
    .where(eq(diagnosisReports.profile_id, profileId))
    .orderBy(desc(diagnosisReports.generated_at))
    .limit(1);

  const openInterrupts = await db
    .select()
    .from(anomalies)
    .where(
      and(
        eq(anomalies.profile_id, profileId),
        eq(anomalies.severity, "interrupt"),
        isNull(anomalies.resolved_at),
      ),
    );

  if (!report && openInterrupts.length === 0) {
    out.skipped.push({ ref: "profile", reason: "no diagnosis report and no open interrupts" });
    return out;
  }

  const existingRows = await db
    .select({ ref: proposals.originating_finding })
    .from(proposals)
    .where(eq(proposals.profile_id, profileId));
  const existing = new Set(existingRows.map((r) => r.ref).filter(Boolean));

  const { limits } = await ensureHardLimits(profileId, opts.limitLlm ?? liveLimitLlm);
  // P3-28: kinds the owner has declined three times are not proposed
  // again — checked after classification, so the skip can say why.
  const suppressed = await suppressedKinds(profileId);

  const [acct] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  const accountId = acct?.account_id ?? profileId;

  const record = async (args: {
    ref: string;
    kind: ActionKind;
    summary: string;
    detail: unknown;
    scenario: unknown;
    reversibility: { level: "easy" | "moderate" | "hard"; if_you_change_your_mind: string };
  }) => {
    const verdict = checkHardLimits(limits, args.kind);
    const manual = verdict.manual.map((l: HardLimit) => l.quote);
    const row = await createProposal({
      profile_id: profileId,
      module: "diagnosis",
      originating_finding: args.ref,
      action: {
        kind: args.kind,
        summary: args.summary,
        detail: { ...(args.detail as object), manual_limits: manual },
      },
      scenario: args.scenario as never,
      reversibility: args.reversibility,
      expires_at: expiry(now),
      blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
    });
    (verdict.verdict === "blocked" ? out.blocked : out.created).push(row);
  };

  if (report) {
    const recs = report.recommendations as StoredRecommendation[];
    for (const [i, rec] of recs.entries()) {
      const ref = `report:${report.id}:rec:${i}`;
      if (existing.has(ref)) {
        out.skipped.push({ ref, reason: "already proposed" });
        continue;
      }
      if (rec.status === "rejected") {
        out.skipped.push({ ref, reason: "owner declined this on the report" });
        continue;
      }
      const { text } = await classify({
        system: CLASSIFY_SYSTEM,
        user: `${rec.title}\n\n${rec.rationale}`,
        accountId,
      });
      const kind = coerceKind(text);
      if (kind === null) {
        out.skipped.push({ ref, reason: "unclassifiable: not proposing on a guess" });
        continue;
      }
      const suppression = suppressed.get(kind);
      if (suppression) {
        out.skipped.push({
          ref,
          reason: `you've declined ${kind.replace(/_/g, " ")} ${suppression.rejections} times: I've stopped proposing it`,
        });
        continue;
      }
      await record({
        ref,
        kind,
        summary: rec.title,
        detail: { rationale: rec.rationale, sensitivity_callouts: rec.sensitivity_callouts },
        scenario: rec.scenario,
        reversibility: rec.reversibility,
      });
    }
  }

  for (const a of openInterrupts) {
    const ref = `anomaly:${a.id}`;
    if (existing.has(ref)) {
      out.skipped.push({ ref, reason: "already proposed" });
      continue;
    }
    await record({
      ref,
      kind: "operations_change",
      summary: `Investigate: ${a.detail}`,
      detail: { metric_key: a.metric_key, direction: a.direction, run_days: a.run_days },
      scenario: anomalyScenario(a.detail),
      reversibility: {
        level: "easy",
        if_you_change_your_mind: "An investigation changes nothing by itself. Stop any time.",
      },
    });
  }

  return out;
}
