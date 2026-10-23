// The content calendar — Phase 3 Session C (P3-15).
//
// A plan is a PROPOSAL like any other: it goes through the Session A
// pipeline, gets the rule-14 check, renders in the queue with its
// evidence, and drafts nothing until approved. The calendar itself is
// deterministic — which channels exist, what cadence suits each, which
// goal each slot serves — because scheduling is arithmetic over the
// profile, not taste (CLAUDE.md cost rule). The words come later
// (P3-16), per item, after the owner has said yes to the plan.
//
// Only channels the owner ALREADY runs are planned onto. Expansion to
// a new platform is a different proposal kind (channel_expansion) with
// its own 13.5 exposure — a calendar never smuggles a new platform in.

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { channels, offers, proposals } from "../../db/schema";
import { readCurrentField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { checkHardLimits, ensureHardLimits, limitCaption } from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal } from "../proposals/service";
import { listGoals } from "./goals";
import { evidenceAssumption, performanceEvidence } from "./performance";
import { enumCode } from "../core/enum-value";
import type { ScenarioBlock } from "../diagnosis/recommendations";
import type { SimulationAttachment } from "../simulate/scenario";
import { attachSimulation } from "../simulate/scenario";
// watch.ts imports ContentError back from here; both are used only at call time, so the cycle is safe.
import { assertNotWatching } from "./watch";

export class ContentError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ContentError";
    this.status = status;
  }
}

export interface ChannelView {
  channel_id: string;
  type: string | null;
  platform: string | null;
  label: string;
}

export async function listChannels(profileId: string): Promise<ChannelView[]> {
  const spine = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.profile_id, profileId))
    .orderBy(channels.created_at);
  const views: ChannelView[] = [];
  for (const row of spine) {
    const type = await readCurrentField<unknown>(profileId, `channels.${row.id}.type`);
    const platform = await readCurrentField<unknown>(profileId, `channels.${row.id}.platform`);
    const t = enumCode(type?.value);
    const p = enumCode(platform?.value);
    views.push({ channel_id: row.id, type: t, platform: p, label: p ?? t ?? "channel" });
  }
  return views;
}

/** Weekly cadence per channel type — deliberate, small, sustainable. Read by the simulator (lib/simulate). */
export const CADENCE: Readonly<Record<string, { per_week: number; format: PlanFormat }>> = {
  social_organic: { per_week: 3, format: "short_video" },
  email: { per_week: 1, format: "email" },
  website: { per_week: 1, format: "post" },
  direct_message: { per_week: 1, format: "post" },
};

export type PlanFormat = "post" | "email" | "short_video";

export interface PlannedItem {
  date: string; // YYYY-MM-DD
  channel_id: string;
  channel_label: string;
  format: PlanFormat;
  goal_id: string | null;
  focus: string;
  brief: string;
  /** Field keys and entity ids this slot rests on. */
  evidence: string[];
}

/** Offsets from the Monday start: Mon/Wed/Fri first, then Tue/Thu/Sat/Sun. */
const WEEK_SLOTS = [0, 2, 4, 1, 3, 5, 6];

async function topOffer(
  profileId: string,
): Promise<{ offer_id: string; name: string; evidence: string[] } | null> {
  const spine = await db
    .select({ id: offers.id })
    .from(offers)
    .where(eq(offers.profile_id, profileId))
    .orderBy(offers.created_at);
  let best: { offer_id: string; name: string; volume: number; evidence: string[] } | null = null;
  for (const row of spine) {
    const name = await readCurrentField<string>(profileId, `offers.${row.id}.name`);
    const volume = await readCurrentField<number>(profileId, `offers.${row.id}.volume_period`);
    const label = typeof name?.value === "string" ? name.value : "the flagship";
    const v = typeof volume?.value === "number" ? volume.value : -1;
    const evidence = [
      `offers.${row.id}.name`,
      ...(v >= 0 ? [`offers.${row.id}.volume_period`] : []),
    ];
    if (!best || v > best.volume) best = { offer_id: row.id, name: label, volume: v, evidence };
  }
  return best ? { offer_id: best.offer_id, name: best.name, evidence: best.evidence } : null;
}

export interface PlanArgs {
  weeks?: number;
  now?: Date;
  limitLlm?: LimitLlm;
  /** Feature 36: proposed from the campaign simulator — its scenario rides along. */
  simulation?: SimulationAttachment;
}

/** A calendar proposal (its slots in detail.items), not a shot list or a per-item publish. */
function isPlanAction(action: unknown): boolean {
  const a = action as { kind?: unknown; detail?: { items?: unknown } } | null;
  return a?.kind === "content_publishing" && Array.isArray(a.detail?.items);
}

/**
 * Propose a content calendar. One proposal, all slots in its detail;
 * the queue renders it; approval hands it to produce (P3-16/produce.ts).
 */
export async function proposeContentPlan(
  profileId: string,
  args: PlanArgs = {},
): Promise<ProposalRow> {
  const weeks = args.weeks ?? 2;
  const now = args.now ?? new Date();

  // The watch blocks proposing, as for every other generator (rule 15;
  // review 2026-10-23, #21): a watched business gets no calendar yet.
  await assertNotWatching(profileId, now);
  // One calendar waiting at a time: a second "plan" (or "Propose this" on
  // the simulator, twice) is the same proposal, not a duplicate in the queue.
  const waiting = await db
    .select({ id: proposals.id, action: proposals.action })
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        eq(proposals.module, "content"),
        eq(proposals.status, "pending"),
      ),
    );
  if (waiting.some((p) => isPlanAction(p.action))) {
    throw new ContentError(
      "a content calendar is already waiting in your queue — approve or decline that one first",
      409,
    );
  }

  const allChannels = await listChannels(profileId);
  const plannable = allChannels.filter((c) => c.type !== null && c.type in CADENCE);
  if (plannable.length === 0) {
    throw new ContentError(
      "no plannable channels on the profile — the calendar only plans onto channels you already run",
      422,
    );
  }

  const goals = (await listGoals(profileId)).filter((g) => g.statement !== null);
  const focus = await topOffer(profileId);

  // Start next Monday — a plan that starts mid-week starts ragged.
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() + ((8 - start.getUTCDay()) % 7 || 7));

  const items: PlannedItem[] = [];
  for (let week = 0; week < weeks; week++) {
    for (const channel of plannable) {
      const cadence = CADENCE[channel.type as keyof typeof CADENCE];
      if (!cadence) continue;
      for (let slot = 0; slot < cadence.per_week; slot++) {
        const day = new Date(start);
        day.setUTCDate(day.getUTCDate() + week * 7 + (WEEK_SLOTS[slot] ?? 0));
        const goal = goals[items.length % Math.max(goals.length, 1)] ?? null;
        items.push({
          date: day.toISOString().slice(0, 10),
          channel_id: channel.channel_id,
          channel_label: channel.label,
          format: cadence.format,
          goal_id: goal?.goal_id ?? null,
          focus: focus?.name ?? "the business itself",
          brief:
            cadence.format === "email"
              ? `One useful email about ${focus?.name ?? "the business"}, serving: ${goal?.statement ?? "the owner's stated direction"}.`
              : cadence.format === "short_video"
                ? `A short vertical video about ${focus?.name ?? "the business"} — real footage, owner's voice.`
                : `A post about ${focus?.name ?? "the business"}, in the owner's voice.`,
          evidence: [
            `channels.${channel.channel_id}.type`,
            ...(goal ? [`goals.${goal.goal_id}.statement`] : []),
            ...(focus?.evidence ?? []),
          ],
        });
      }
    }
  }

  const { limits } = await ensureHardLimits(profileId, args.limitLlm);
  const verdict = checkHardLimits(limits, "content_publishing");
  // P3-23c: what performed before, when enough has been measured per post.
  const performed = await performanceEvidence(profileId);

  const planScenario: ScenarioBlock = {
    assumptions: [
      ...(performed ? [evidenceAssumption(performed)] : []),
      {
        statement: `${plannable.length} plannable channel(s) on the profile`,
        value: null,
        source_field: `channels.${plannable[0]?.channel_id}.type`,
        sensitivity: "high",
      },
      ...(focus
        ? [
            {
              statement: `${focus.name} is the strongest offer on current numbers`,
              value: null,
              source_field: focus.evidence[focus.evidence.length - 1] ?? null,
              sensitivity: "medium" as const,
            },
          ]
        : []),
    ],
    base_case: {
      case: "base",
      statement: "Consistent presence on channels you already run, at a sustainable cadence.",
      profit_delta_monthly: null,
      formula: null,
    },
    downside_case: {
      case: "downside",
      statement:
        "The time spent drafting reviews is the whole cost — drafts you decline cost nothing else.",
      profit_delta_monthly: null,
      formula: null,
    },
    upside_case: {
      case: "upside",
      statement: "A working cadence the readback (Session E) can finally measure per post.",
      profit_delta_monthly: null,
      formula: null,
    },
    breakeven_condition:
      "no spend — the cost is your review time, and every draft waits for your yes",
  };

  return createProposal({
    profile_id: profileId,
    module: "content",
    action: {
      kind: "content_publishing",
      summary: `A ${weeks}-week content calendar: ${items.length} pieces across ${plannable.length} channel${plannable.length === 1 ? "" : "s"}`,
      detail: {
        items,
        manual_limits: verdict.manual.map((l) => l.quote),
        rationale: `Every slot serves a stated goal and leans on ${focus?.name ?? "the business"}; nothing publishes anywhere you don't already run.`,
        ...(performed ? { performance: performed } : {}),
      },
    },
    scenario: attachSimulation(planScenario, args.simulation) as never,
    reversibility: {
      level: "easy",
      if_you_change_your_mind: "Drafts are drafts. Delete any of them; nothing has been published.",
    },
    expires_at: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
    blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
  });
}
