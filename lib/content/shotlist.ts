// Shot lists — Phase 3 Session C (P3-17).
//
// The system tells the owner exactly what to film, and every shot says
// WHY it earns its place — anchored to the profile's own facts (the
// offer that actually sells, the channel it will run on, the goal it
// serves). Deterministic: a shot list is a checklist derived from
// evidence, not a mood board. When per-post readback exists (P3-23 /
// Session E), "what performed before" sharpens these; today the
// honest evidence is measured volume and stated goals, and each shot
// names its source.

import { desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { offers } from "../../db/schema";
import { readCurrentField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { checkHardLimits, ensureHardLimits, limitCaption } from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal } from "../proposals/service";
import { listGoals } from "./goals";
import { listChannels } from "./plan";
import { ContentError } from "./plan";

export interface Shot {
  order: number;
  shot: string;
  why: string;
  /** Field keys this shot's reasoning rests on. */
  evidence: string[];
}

const VIDEO_PLATFORMS = new Set(["tiktok", "instagram", "youtube", "facebook"]);

/**
 * Build the shot list for the strongest offer, as a proposal. The
 * owner films; the cutting room (P3-18) does the rest.
 */
export async function proposeShotList(
  profileId: string,
  args: { now?: Date; limitLlm?: LimitLlm } = {},
): Promise<ProposalRow> {
  const now = args.now ?? new Date();

  const spine = await db
    .select({ id: offers.id })
    .from(offers)
    .where(eq(offers.profile_id, profileId))
    .orderBy(desc(offers.created_at));
  if (spine.length === 0) {
    throw new ContentError("no offers on the profile — nothing to film yet", 422);
  }

  // Strongest offer by current volume fact (measured supersedes stated
  // upstream, so this read already prefers Stripe/Shopify truth).
  let offerId = spine[0]!.id;
  let offerName = "the flagship";
  let bestVolume = -1;
  const offerEvidence: string[] = [];
  for (const row of spine) {
    const name = await readCurrentField<string>(profileId, `offers.${row.id}.name`);
    const volume = await readCurrentField<number>(profileId, `offers.${row.id}.volume_period`);
    const v = typeof volume?.value === "number" ? volume.value : -1;
    if (v > bestVolume || offerEvidence.length === 0) {
      offerId = row.id;
      offerName = typeof name?.value === "string" ? name.value : "the flagship";
      bestVolume = v;
      offerEvidence.length = 0;
      offerEvidence.push(`offers.${row.id}.name`);
      if (v >= 0) offerEvidence.push(`offers.${row.id}.volume_period`);
    }
  }

  const videoChannel = (await listChannels(profileId)).find(
    (c) => c.platform !== null && VIDEO_PLATFORMS.has(c.platform),
  );
  const channelLabel = videoChannel?.label ?? "your strongest video channel";
  const channelEvidence = videoChannel ? [`channels.${videoChannel.channel_id}.platform`] : [];

  const goal = (await listGoals(profileId)).find((g) => g.statement !== null) ?? null;
  const goalEvidence = goal ? [`goals.${goal.goal_id}.statement`] : [];

  const shots: Shot[] = [
    {
      order: 1,
      shot: `Open on ${offerName} in someone's hands, mid-use — no logo card, no intro.`,
      why: "The first second decides the scroll; the product working is the strongest opener you own.",
      evidence: offerEvidence,
    },
    {
      order: 2,
      shot: "You, to camera, one sentence: the problem this solves, in the words you used in your intake.",
      why: "Your own phrasing tested well enough to build a business on — it goes in front of the camera unchanged.",
      evidence: [...offerEvidence, ...goalEvidence],
    },
    {
      order: 3,
      shot: `Close-up detail of ${offerName} — texture, mechanism, the part a customer touches first.`,
      why: "Detail shots read as honesty; stock-looking footage reads as an ad.",
      evidence: offerEvidence,
    },
    {
      order: 4,
      shot: "Fifteen seconds of the making/doing — workshop, prep, screen, whatever the real work looks like.",
      why: "Process footage is the cheapest trust you can film, and it cannot be faked by competitors.",
      evidence: offerEvidence,
    },
    {
      order: 5,
      shot: "The before/after or the result — the state a customer is in once it worked.",
      why: goal
        ? `It shows the outcome your stated goal points at: "${goal.statement}".`
        : "Outcomes sell; features explain.",
      evidence: goalEvidence.length > 0 ? goalEvidence : offerEvidence,
    },
    {
      order: 6,
      shot: "A real customer moment if you have one — unboxing, first use, a message you were sent (with permission).",
      why: "One real reaction outperforms any script; skip it rather than stage it.",
      evidence: offerEvidence,
    },
    {
      order: 7,
      shot: "You again, one closing line: what to do next, said once, plainly.",
      why: "A single clear ask; stacked asks cancel each other.",
      evidence: channelEvidence.length > 0 ? channelEvidence : offerEvidence,
    },
  ];

  const { limits } = await ensureHardLimits(profileId, args.limitLlm);
  const verdict = checkHardLimits(limits, "content_publishing");

  return createProposal({
    profile_id: profileId,
    module: "content",
    action: {
      kind: "content_publishing",
      summary: `A shot list for ${offerName} — 7 shots, filmed by you, cut for ${channelLabel}`,
      detail: {
        shots,
        offer_id: offerId,
        channel_label: channelLabel,
        manual_limits: verdict.manual.map((l) => l.quote),
        rationale:
          "Real footage only. You film these on a phone; the cutting room trims, captions and crops per platform. No generated video, ever.",
      },
    },
    scenario: {
      assumptions: [
        {
          statement:
            bestVolume >= 0
              ? `${offerName} carries the strongest measured volume on the profile`
              : `${offerName} is the lead offer on the profile (no measured volume yet)`,
          value: null,
          source_field: offerEvidence[offerEvidence.length - 1] ?? null,
          sensitivity: "medium",
        },
      ],
      base_case: {
        case: "base",
        statement: "An afternoon of filming yields a week of honest, cuttable material.",
        profit_delta_monthly: null,
        formula: null,
      },
      downside_case: {
        case: "downside",
        statement: "The footage is unusable and the cost was the afternoon.",
        profit_delta_monthly: null,
        formula: null,
      },
      upside_case: {
        case: "upside",
        statement: "The strongest clip becomes the template the readback keeps refilling.",
        profit_delta_monthly: null,
        formula: null,
      },
      breakeven_condition: "no spend — a phone and an afternoon",
    } as never,
    reversibility: {
      level: "easy",
      if_you_change_your_mind: "It's a checklist. Film none of it and nothing has happened.",
    },
    expires_at: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
    blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
  });
}

/** The shot list rendered as the owner sees it in a content item. */
export function renderShotList(shots: readonly Shot[], offerName: string): string {
  const lines = [`Shot list — ${offerName}`, ""];
  for (const s of shots) {
    lines.push(`${s.order}. ${s.shot}`);
    lines.push(`   Why: ${s.why}`);
  }
  return lines.join("\n");
}
