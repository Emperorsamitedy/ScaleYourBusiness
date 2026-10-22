// Segments feed proposal generation — Phase 4 Session E (P4-14).
//
// A win-back for the lapsed, a thank-you for the best: PROPOSALS with
// evidence, through every Phase 3 gate — the owner's hard limits (rule
// 14), suppression learning (P3-28), the outbound posture from their
// own 6.4b answer, and the per-contact consent gate (rule 19) that
// decided who may be emailed before the proposal was written. Nothing
// here sends anything: sending is Session F's executor, and approving
// one of these queues a campaign for drafting in the owner's voice.
//
// One proposal per segment per month, keyed by originating_finding, so
// re-running is idempotent at zero model cost. The proposal carries
// contact IDS only — never a name or an address (rule 22: the record is
// hashes and ids). It is labelled irreversible ("hard") before approval,
// because the send it leads to can't be recalled (P4-15).

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, proposals } from "../../db/schema";
import type { LimitLlm } from "../proposals/hard-limits";
import { checkHardLimits, ensureHardLimits, limitCaption } from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal } from "../proposals/service";
import { suppressedKinds } from "../trust/suppression";
import type { ScenarioBlock } from "../diagnosis/recommendations";
import type { SimulationAttachment } from "../simulate/scenario";
import { attachSimulation } from "../simulate/scenario";
import { outboundPosture } from "./contacts";
import type { Segment } from "./segments";
import { computeSegments } from "./segments";

export const SEGMENT_MODULE = "crm";
export const SEGMENT_KIND = "customer_email";
export const SEGMENT_PROPOSAL_EXPIRY_DAYS = 14;

export class SegmentProposalError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "SegmentProposalError";
    this.status = status;
  }
}

export interface SegmentProposalOutcome {
  created: ProposalRow[];
  blocked: ProposalRow[];
  skipped: { segment: string; reason: string }[];
}

function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

interface Campaign {
  segment: Segment["key"];
  ref: string;
  summary: (n: number) => string;
  what: string;
  base: string;
  upside: string;
}

const CAMPAIGNS: Record<"lapsed" | "vip", Campaign> = {
  lapsed: {
    segment: "lapsed",
    ref: "winback",
    summary: (n) => `Win back ${n} lapsed customer${n === 1 ? "" : "s"} who said yes to email`,
    what: "One email, in your voice, to customers who have not bought in six months and gave explicit consent to hear from you.",
    base: "Some of them come back; the readback counts the orders that follow.",
    upside: "A lapsed customer is cheaper to win back than a stranger is to win.",
  },
  vip: {
    segment: "vip",
    ref: "vip",
    summary: (n) => `Thank your ${n} best customer${n === 1 ? "" : "s"}`,
    what: "One email, in your voice, thanking the customers who buy most often or spend most — no offer attached unless you add one.",
    base: "They feel seen; the readback watches whether they keep buying.",
    upside: "The customers most worth keeping are the ones most worth thanking.",
  },
};

/**
 * Propose a campaign per qualifying segment, once per month. Honest
 * about every skip: posture, suppression, nobody emailable, already
 * proposed.
 */
export async function proposeFromSegments(
  profileId: string,
  opts: {
    now?: Date;
    limitLlm?: LimitLlm;
    /** Feature 36: one segment only, when the owner proposes it from the simulator. */
    only?: "lapsed" | "vip";
    /** Feature 36: the simulated scenario that proposal carries. */
    simulation?: SimulationAttachment;
  } = {},
): Promise<SegmentProposalOutcome> {
  const now = opts.now ?? new Date();
  const out: SegmentProposalOutcome = { created: [], blocked: [], skipped: [] };

  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) throw new SegmentProposalError("no such profile", 404);

  const posture = await outboundPosture(profileId);
  if (posture === "disabled") {
    out.skipped.push({
      segment: "all",
      reason:
        'your own answer on customer consent (6.4b) was "no consent" — outbound email stays off until your data says otherwise',
    });
    return out;
  }

  const report = await computeSegments(profile.account_id, now);
  const { limits } = await ensureHardLimits(profileId, opts.limitLlm);
  const suppressed = await suppressedKinds(profileId);
  const existing = await db
    .select({ ref: proposals.originating_finding })
    .from(proposals)
    .where(and(eq(proposals.profile_id, profileId), eq(proposals.module, SEGMENT_MODULE)));
  const seen = new Set(existing.map((r) => r.ref));

  for (const campaign of Object.values(CAMPAIGNS)) {
    if (opts.only !== undefined && campaign.segment !== opts.only) continue;
    const segment = report.segments.find((s) => s.key === campaign.segment)!;
    const ref = `crm:${campaign.ref}:${monthKey(now)}`;
    if (seen.has(ref)) {
      out.skipped.push({ segment: segment.key, reason: "already proposed this month" });
      continue;
    }
    if (segment.emailable_ids.length === 0) {
      out.skipped.push({
        segment: segment.key,
        reason:
          segment.contact_ids.length === 0
            ? "nobody is in this segment"
            : `${segment.contact_ids.length} in the segment, none with explicit email consent — nothing to send to`,
      });
      continue;
    }
    const suppression = suppressed.get(SEGMENT_KIND);
    if (suppression) {
      out.skipped.push({
        segment: segment.key,
        reason: `you've declined customer email ${suppression.rejections} times — I've stopped proposing it`,
      });
      continue;
    }
    const verdict = checkHardLimits(limits, SEGMENT_KIND);
    const n = segment.emailable_ids.length;
    const row = await createProposal({
      profile_id: profileId,
      module: SEGMENT_MODULE,
      originating_finding: ref,
      action: {
        kind: SEGMENT_KIND,
        summary: campaign.summary(n),
        detail: {
          segment: segment.key,
          label: segment.label,
          what: campaign.what,
          contact_ids: segment.emailable_ids,
          in_segment: segment.contact_ids.length,
          excluded: segment.excluded,
          evidence: segment.evidence,
          posture,
          sending:
            "Nothing sends on approval. Approving lets me draft the email; nothing sends until you approve the finished email itself, and then every recipient's consent is checked again at the moment it goes.",
          manual_limits: verdict.manual.map((l) => l.quote),
        },
      },
      scenario: attachSimulation(
        {
          assumptions: [
            {
              statement: `${n} recipients hold explicit consent and no suppression, decided per contact at proposal time; re-decided at send time`,
              value: null,
              source_field: null,
              sensitivity: "low",
            },
            ...segment.evidence.map((e) => ({
              statement: e,
              value: null,
              source_field: null,
              sensitivity: "low" as const,
            })),
          ],
          base_case: {
            case: "base",
            statement: campaign.base,
            profit_delta_monthly: null,
            formula: null,
          },
          downside_case: {
            case: "downside",
            statement:
              "Nobody answers, and a few unsubscribe — honoured immediately and permanently.",
            profit_delta_monthly: null,
            formula: null,
          },
          upside_case: {
            case: "upside",
            statement: campaign.upside,
            profit_delta_monthly: null,
            formula: null,
          },
          breakeven_condition:
            "not computed — no per-customer revenue series exists yet to compute it from",
        } as ScenarioBlock,
        opts.simulation,
      ) as never,
      // P4-15: labelled irreversible BEFORE approval (rule 16) — the engine
      // refuses to send a campaign approved as undoable.
      reversibility: {
        level: "hard",
        if_you_change_your_mind:
          "Irreversible once sent: a sent email can't be recalled. Until then, decline it here, don't approve the email itself, or press the emergency stop.",
      },
      expires_at: new Date(now.getTime() + SEGMENT_PROPOSAL_EXPIRY_DAYS * 86_400_000).toISOString(),
      blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
    });
    (verdict.verdict === "blocked" ? out.blocked : out.created).push(row);
  }
  console.log(
    JSON.stringify({
      event: "segment_proposals",
      profile_id: profileId,
      account_id: profile.account_id,
      created: out.created.length,
      blocked: out.blocked.length,
      skipped: out.skipped.map((s) => `${s.segment}: ${s.reason}`),
    }),
  );
  return out;
}
