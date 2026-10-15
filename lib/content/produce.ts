// Producing — Phase 3 Session C. An APPROVED content proposal becomes
// items in the scheduled queue: calendar slots get drafted in the
// owner's voice (P3-16), shot lists get rendered as checklists
// (P3-17), and every item lands with its goal, its disclosure and its
// provenance. Video items are not drafted here — a short_video slot
// produces the shot list for the owner to film; the cutting room
// (edit.ts) turns their footage into the video item, explicitly.
//
// This is internal production, not an external write: nothing leaves
// the system, so it does not pass the Session B engine. The proposal
// still flips to executed through the Session A service, which writes
// the decision-log entry — an approved plan that produced drafts is a
// thing that HAPPENED, and the log says so.
//
// P3-21a: the drafts it produces are then offered for publishing, one
// proposal per item headed for a connected Meta asset (./publish) — the
// owner approves the finished item, not just the plan.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, contentItems, proposals } from "../../db/schema";
import type { LimitLlm } from "../proposals/hard-limits";
import { recordExecution } from "../proposals/service";
import type { DraftLlm } from "./draft";
import { draftItem } from "./draft";
import { withDisclosure } from "./disclosure";
import type { PublishRun } from "./publish";
import { isPublishProposal, proposePublishing } from "./publish";
import type { PlannedItem } from "./plan";
import { ContentError } from "./plan";
import type { Shot } from "./shotlist";
import { renderShotList } from "./shotlist";
import { buildVoiceCard } from "./voice";

export type ContentItemRow = typeof contentItems.$inferSelect;

export interface ProduceOutcome {
  items: ContentItemRow[];
  /** P3-21a: the publish proposals the drafts got, and why the rest didn't. */
  publishing: PublishRun;
}

/**
 * Produce the items an approved content proposal promised. Idempotent:
 * a proposal that already produced its items refuses to produce twice
 * (its status is executed, and only approved produces).
 */
export async function produceFromProposal(
  proposalId: string,
  opts: { draftLlm?: DraftLlm; limitLlm?: LimitLlm; expectedProfileId?: string } = {},
): Promise<ProduceOutcome> {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
  if (!proposal) throw new ContentError("no such proposal", 404);
  // Ownership clause (2026-09-26 review): foreign = missing, 404.
  if (opts.expectedProfileId && proposal.profile_id !== opts.expectedProfileId) {
    throw new ContentError("no such proposal", 404);
  }
  if (proposal.status !== "approved") {
    throw new ContentError(
      `only an approved proposal produces content — this one is ${proposal.status}`,
      409,
    );
  }
  const action = proposal.action as {
    kind?: string;
    summary?: string;
    detail?: { items?: PlannedItem[]; shots?: Shot[]; offer_id?: string; channel_label?: string };
  };
  if (action.kind !== "content_publishing") {
    throw new ContentError("this proposal is not a content proposal", 422);
  }
  if (isPublishProposal(proposal.action)) {
    throw new ContentError(
      "this is a publish proposal for one finished item — it publishes, it doesn't produce",
      422,
    );
  }

  const [acct] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, proposal.profile_id));
  const accountId = acct?.account_id ?? proposal.profile_id;

  const card = await buildVoiceCard(proposal.profile_id, opts.limitLlm);
  const rows: (typeof contentItems.$inferInsert)[] = [];

  for (const item of action.detail?.items ?? []) {
    if (item.format === "short_video") {
      // The slot exists; the footage does not. What the queue holds is
      // the ask — film this — not a fabricated video.
      rows.push({
        profile_id: proposal.profile_id,
        proposal_id: proposal.id,
        goal_id: item.goal_id,
        kind: "shot_list",
        channel_label: item.channel_label,
        scheduled_for: item.date,
        title: `Film for ${item.channel_label} — ${item.focus}`,
        body: withDisclosure(
          "shot_list",
          `${item.brief}\n\nFilm on a phone; the cutting room trims, captions and crops it for ${item.channel_label}.`,
        ),
        disclosure: "Shot list prepared with AI assistance.",
        provenance: { item, voice_card: card, evidence: item.evidence },
      });
      continue;
    }
    const kind = item.format === "email" ? ("email" as const) : ("post" as const);
    const draft = await draftItem({
      card,
      item,
      kind,
      accountId,
      ...(opts.draftLlm ? { llm: opts.draftLlm } : {}),
    });
    rows.push({
      profile_id: proposal.profile_id,
      proposal_id: proposal.id,
      goal_id: item.goal_id,
      kind,
      channel_label: item.channel_label,
      scheduled_for: item.date,
      title: `${item.focus} — ${item.channel_label}, ${item.date}`,
      body: draft.body,
      disclosure: kind === "email" ? "Written with AI assistance." : "Written with AI assistance.",
      provenance: { ...draft.provenance, item, evidence: item.evidence },
    });
  }

  if (action.detail?.shots && action.detail.shots.length > 0) {
    const offerName =
      action.summary?.replace(/^A shot list for /, "").split(" — ")[0] ?? "the offer";
    rows.push({
      profile_id: proposal.profile_id,
      proposal_id: proposal.id,
      goal_id: null,
      kind: "shot_list",
      channel_label: action.detail.channel_label ?? "video",
      scheduled_for: null,
      title: `Shot list — ${offerName}`,
      body: withDisclosure("shot_list", renderShotList(action.detail.shots, offerName)),
      disclosure: "Shot list prepared with AI assistance.",
      provenance: {
        shots: action.detail.shots,
        offer_id: action.detail.offer_id ?? null,
        voice_card: card,
      },
    });
  }

  if (rows.length === 0) {
    throw new ContentError("the proposal carried nothing to produce", 422);
  }

  const inserted = await db.insert(contentItems).values(rows).returning();
  await recordExecution({
    proposalId: proposal.id,
    result: { produced: inserted.length, kinds: inserted.map((r) => r.kind) },
  });

  // The drafts exist and the plan is executed whatever happens next; a
  // failure to propose publishing is logged, never an undone production.
  let publishing: PublishRun = { created: [], skipped: [] };
  try {
    publishing = await proposePublishing(
      proposal.profile_id,
      inserted.map((r) => r.id),
      opts.limitLlm ? { limitLlm: opts.limitLlm } : {},
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "publish_proposals_failed",
        account_id: accountId,
        profile_id: proposal.profile_id,
        message: String(error),
      }),
    );
  }
  return { items: inserted, publishing };
}

/** The queue, soonest first — the /content screen's one read. */
export async function contentQueue(profileId: string): Promise<ContentItemRow[]> {
  return db
    .select()
    .from(contentItems)
    .where(eq(contentItems.profile_id, profileId))
    .orderBy(contentItems.scheduled_for, contentItems.created_at);
}
