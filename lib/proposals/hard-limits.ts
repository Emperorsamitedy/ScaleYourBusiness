// Hard limits — Phase 3 Session A (P3-03), rule 14.
//
// 13.5's free text ("What would you never want the business to do?")
// lands in goals.owner_boundaries. It is parsed ONCE — Haiku, the
// extraction workload, same routing as the answer parser — into
// structured limits stored as the derived fact goals.hard_limits, with
// derived_from and method on the source (rule 6). Re-parse happens only
// when the boundaries fact itself changes; the parse never runs per
// proposal.
//
// At generation time the check is PURE CODE: a limit code names the
// action kinds it forbids, in the registry below. No model call decides
// whether "never discount" means never discount — that judgement was
// made once, at extraction, and is on the record.
//
// A limit Haiku cannot map to a code is NEVER dropped: it becomes a
// "manual" limit that rides along on every proposal card for the human
// to weigh. Silent narrowing of the owner's words would be a quiet lie.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { createField } from "../core/field";
import { confidence } from "../core/confidence";
import type { Confidence } from "../core/confidence";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { ModelRefusalError, readAnswer } from "../llm/answer";
import { anthropicClient } from "../llm/client";
import type { LlmCallRecord } from "../llm/cost-log";
import { buildCallRecord, recordLlmCall } from "../llm/cost-log";
import { readCurrentField, writeField } from "../profile/field-store";
import { businessProfiles } from "../../db/schema";

export const HARD_LIMITS_KEY = "goals.hard_limits";
export const BOUNDARIES_KEY = "goals.owner_boundaries";
export const LIMIT_EXTRACTION_METHOD = "haiku-limit-extraction-v1";
export const LIMIT_MODEL = "claude-haiku-5-5";

/**
 * An interpretation of the owner's own written boundary: below precise
 * owner input (0.75), well above an unconfirmed conversational guess
 * (0.45) — and every card shows the verbatim quote anyway.
 */
export const LIMIT_CONFIDENCE: Confidence = confidence(0.7);

/**
 * The closed set of action kinds proposal generation may emit (P3-04
 * imports this — the generator cannot invent a kind the limits cannot
 * see). Coarse on purpose: a kind exists here only if an owner boundary
 * could plausibly forbid it.
 */
export const ACTION_KINDS = [
  "price_increase",
  "price_decrease",
  "discount_or_promotion",
  "paid_ads_start_or_increase",
  "paid_ads_decrease_or_pause",
  "content_publishing",
  "cold_outreach",
  "channel_expansion",
  "offer_change",
  "operations_change",
  /** Phase 4 (P4-05): answers the business will give customers in public. */
  "support_knowledge",
  /** Phase 4 (P4-14): email to customers who gave explicit consent — not cold outreach. */
  "customer_email",
  /**
   * Phase 5 (P5-16): a follow-up on a deal that has gone quiet, drafted for
   * the owner to send themselves, to a contact with explicit consent — not
   * cold outreach.
   */
  "deal_followup",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * Phase 5 (P5-03, rule 27): proposal kinds that only record the owner's
 * intent. No executor exists for them and the due runner leaves them
 * unrouted, so approving one writes the decision and nothing else. They sit
 * outside ACTION_KINDS on purpose: the diagnosis classifier and the alert
 * review can never emit one; only the module that owns it makes it, with
 * its arithmetic. They still pass through the hard-limit check, so the
 * owner's manual limits ride along, and a code that names one blocks it.
 */
export const NOTE_KINDS = ["stock_reorder_note"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
/** Every kind a proposal can carry through the hard-limit check. */
export type ProposalKind = ActionKind | NoteKind;

/** code → the action kinds it forbids. The whole of rule 14's arithmetic. */
export const LIMIT_TAXONOMY = {
  no_discounts: {
    description: "never discount, run sales, or issue coupons",
    forbids: ["discount_or_promotion"] as readonly ActionKind[],
  },
  no_price_increase: {
    description: "never raise prices on existing customers or offers",
    forbids: ["price_increase"] as readonly ActionKind[],
  },
  no_paid_ads: {
    description: "never buy paid advertising",
    forbids: ["paid_ads_start_or_increase"] as readonly ActionKind[],
  },
  no_cold_outreach: {
    description: "never send cold emails or unsolicited messages",
    forbids: ["cold_outreach"] as readonly ActionKind[],
  },
  no_new_platforms: {
    description: "never expand onto platforms the owner has ruled out",
    forbids: ["channel_expansion"] as readonly ActionKind[],
  },
} as const;
export type LimitCode = keyof typeof LIMIT_TAXONOMY;

export interface HardLimit {
  /** A taxonomy code, or "other" for a boundary no code covers. */
  code: LimitCode | "other";
  /** The owner's words, verbatim — every surface shows these, not the code. */
  quote: string;
  /** auto: machine-checked at generation. manual: shown to the human, never auto-blocked. */
  enforcement: "auto" | "manual";
}

export type LimitVerdict =
  | { verdict: "pass"; manual: HardLimit[] }
  | { verdict: "blocked"; limit: HardLimit; manual: HardLimit[] };

/**
 * The deterministic check (rule 14). First auto limit whose registry
 * entry forbids this action kind blocks it; manual limits always ride
 * along for the card, whichever way the verdict goes.
 */
export function checkHardLimits(limits: readonly HardLimit[], kind: ProposalKind): LimitVerdict {
  const manual = limits.filter((l) => l.enforcement === "manual");
  for (const limit of limits) {
    if (limit.enforcement !== "auto" || limit.code === "other") continue;
    if ((LIMIT_TAXONOMY[limit.code].forbids as readonly ProposalKind[]).includes(kind)) {
      return { verdict: "blocked", limit, manual };
    }
  }
  return { verdict: "pass", manual };
}

/** Owner-facing caption for a blocked proposal — what blocked_by_limit stores. */
export function limitCaption(limit: HardLimit): string {
  return `13.5: ${limit.quote}`;
}

/* ── extraction: free text → HardLimit[], once ── */

/** The LLM seam, injectable like the parser's — deterministic tests, live verify. */
export type LimitLlm = (args: {
  system: string;
  user: string;
  accountId: string;
}) => Promise<{ text: string; calls: LlmCallRecord[] }>;

const LIMIT_SCHEMA = {
  type: "object" as const,
  properties: {
    limits: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          code: { type: "string" as const },
          quote: { type: "string" as const },
        },
        required: ["code", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["limits"],
  additionalProperties: false,
};

/** Exported for the live check (npm run verify:models). */
export const LIMIT_SYSTEM = `You extract hard limits from a small-business owner's answer to: "What would you never want the business to do, regardless of results?"

A hard limit is something the owner rules out absolutely. For each one, return:
- code: the best match from this list, or "other" if none genuinely fits:
${Object.entries(LIMIT_TAXONOMY)
  .map(([code, t]) => `  · ${code} — ${t.description}`)
  .join("\n")}
- quote: the owner's own words for that limit, verbatim from their answer.

Rules: never merge two limits into one; never invent a limit the owner did not state; if the answer states no limits ("nothing really", "can't think of any"), return an empty list. Return JSON only: {"limits": [{"code", "quote"}]}`;

export const liveLimitLlm: LimitLlm = async ({ system, user, accountId }) => {
  const started = Date.now();
  const response = await anthropicClient().messages.create({
    model: LIMIT_MODEL,
    // Room for medium-effort thinking ahead of the limits and their quotes.
    max_tokens: 3_000,
    system,
    output_config: {
      // Medium, not low: this is the one judgement behind rule 14 — which
      // action kinds the owner's words forbid — made once per answer and
      // then enforced by code, so a mis-mapping would quietly unblock
      // proposals. Parse-once, so the extra thinking costs almost nothing.
      effort: "medium",
      format: { type: "json_schema", schema: LIMIT_SCHEMA },
    },
    messages: [{ role: "user", content: user }],
  });
  const record = buildCallRecord({
    workload: "parser",
    account_id: accountId,
    model: LIMIT_MODEL,
    duration_ms: Date.now() - started,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
  });
  await recordLlmCall(record);
  // A refusal throws: no hard_limits fact is written from a decline.
  const { text, refusal } = readAnswer(response, record);
  if (refusal !== null) throw new ModelRefusalError(record, refusal);
  return { text, calls: [record] };
};

/** Validate and coerce the model's JSON — unknown codes degrade to manual "other". */
export function coerceLimits(text: string): HardLimit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("limit extraction returned non-JSON");
  }
  const raw = (parsed as { limits?: unknown }).limits;
  if (!Array.isArray(raw)) throw new Error("limit extraction returned no limits array");
  const limits: HardLimit[] = [];
  for (const entry of raw) {
    const e = entry as { code?: unknown; quote?: unknown };
    if (typeof e.quote !== "string" || e.quote.trim() === "") continue;
    const code =
      typeof e.code === "string" && e.code in LIMIT_TAXONOMY ? (e.code as LimitCode) : "other";
    limits.push({
      code,
      quote: e.quote.trim(),
      enforcement: code === "other" ? "manual" : "auto",
    });
  }
  return limits;
}

export interface EnsureOutcome {
  limits: HardLimit[];
  /** "reused" | "parsed" | "no_boundaries" — how we got here, for telemetry. */
  via: "reused" | "parsed" | "no_boundaries";
}

async function accountIdOf(profileId: string): Promise<string> {
  const [row] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!row) throw new Error(`no such profile ${profileId}`);
  return row.account_id;
}

/**
 * The parse-once contract. Boundaries unanswered → no limits and no
 * fact written (a gap is a finding, not a fabrication). A current
 * hard_limits fact recorded after the current boundaries fact → reused
 * without any model call. Otherwise: one Haiku extraction, written as
 * an inferred fact whose source names the boundaries field and the
 * method (rule 6), superseding the previous parse (rule 3).
 */
export async function ensureHardLimits(
  profileId: string,
  llm: LimitLlm = liveLimitLlm,
): Promise<EnsureOutcome> {
  const boundaries = await readCurrentField<string>(profileId, BOUNDARIES_KEY);
  if (!boundaries || boundaries.status !== "answered" || typeof boundaries.value !== "string") {
    return { limits: [], via: "no_boundaries" };
  }

  const existing = await readCurrentField<HardLimit[]>(profileId, HARD_LIMITS_KEY);
  if (
    existing &&
    existing.status === "inferred" &&
    Array.isArray(existing.value) &&
    existing.recorded_at >= boundaries.recorded_at
  ) {
    return { limits: existing.value, via: "reused" };
  }

  const accountId = await accountIdOf(profileId);
  const { text } = await llm({
    system: LIMIT_SYSTEM,
    user: boundaries.value,
    accountId,
  });
  const limits = coerceLimits(text);

  const field = createField<HardLimit[]>({
    id: fieldId(HARD_LIMITS_KEY),
    value: limits,
    status: "inferred",
    confidence: LIMIT_CONFIDENCE,
    source: {
      kind: "inferred",
      derived_from: [fieldId(BOUNDARIES_KEY)],
      method: LIMIT_EXTRACTION_METHOD,
    },
    observed_at: boundaries.observed_at,
    recorded_at: isoDateTime(new Date().toISOString()),
    note: null,
  });
  await writeField(profileId, field);
  return { limits, via: "parsed" };
}
