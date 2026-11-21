// Posts that learn, against the database: a business's own measured posts
// become the lessons its next draft is given. Seeded with the readback
// fixtures (a Meta publishing connection, published posts, a week of daily
// snapshots each); the verdicts are the real ones (lib/trust/post-readback).
// The drafting model is a stand-in that keeps what it was sent.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { channels, contentItems } from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal, createProposal } from "../proposals/service";
import { withDisclosure } from "./disclosure";
import type { DraftLlm } from "./draft";
import { lessonsFor, lessonsForChannel } from "./lessons-load";
import type { PlannedItem } from "./plan";
import { produceFromProposal } from "./produce";
import type { FxBusiness } from "./readback-fixture";
import {
  fxBusiness,
  fxCleanup,
  fxExecuteConnection,
  fxPublishedItem,
  fxScenario,
  fxSnapshots,
} from "./readback-fixture";

const WEEK = [1, 2, 3, 4, 5, 6, 7];
const BETTER = "Real fireplace, not perfume counter. Ember is back on the bench.";
const WORSE = "SALE! Everything must go, last chance, do not miss out!!!";

async function answer(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

let b: FxBusiness;
let instagram: string;
let tiktok: string;
const posted: Record<string, string> = {};

/** A post on Instagram with its own words and a week of snapshots at one reach. */
async function measured(
  connectionId: string,
  name: string,
  day: string,
  reach: number,
  words: string,
  extra: { status?: "published" | "withdrawn"; kind?: "post" | "video" } = {},
) {
  const postId = `ig-${crypto.randomUUID().slice(0, 8)}-${name}`;
  const { item } = await fxPublishedItem(b, {
    platform: "instagram",
    post_id: postId,
    published_at: `${day}T10:00:00.000Z`,
    ...extra,
  });
  await db
    .update(contentItems)
    .set({ body: withDisclosure("post", words) })
    .where(eq(contentItems.id, item.id));
  await fxSnapshots(
    connectionId,
    "instagram",
    postId,
    day,
    WEEK.map((age) => ({ age, reach, interactions: 10 })),
  );
  posted[name] = item.id;
}

beforeAll(async () => {
  b = await fxBusiness();
  const conn = await fxExecuteConnection(b.account_id);
  // Four ordinary posts to compare with, then one of each kind worth knowing.
  for (const [i, day] of ["2026-09-01", "2026-09-03", "2026-09-05", "2026-09-07"].entries()) {
    await measured(conn.id, `usual-${i}`, day, 100, `An ordinary post, number ${i}.`);
  }
  await measured(conn.id, "better", "2026-09-10", 150, BETTER);
  await measured(conn.id, "worse", "2026-09-12", 60, WORSE);
  await measured(conn.id, "same", "2026-09-14", 105, "Open as usual this week.");
  await measured(conn.id, "taken-down", "2026-09-16", 400, "Taken down again by the owner.", {
    status: "withdrawn",
  });
  await measured(conn.id, "video", "2026-09-18", 400, "A caption under a video.", {
    kind: "video",
  });

  const [ig] = await db
    .insert(channels)
    .values({ profile_id: b.profile_id })
    .returning({ id: channels.id });
  const [tt] = await db
    .insert(channels)
    .values({ profile_id: b.profile_id })
    .returning({ id: channels.id });
  instagram = ig!.id;
  tiktok = tt!.id;
  await answer(b.profile_id, `channels.${instagram}.platform`, "instagram");
  await answer(b.profile_id, `channels.${tiktok}.platform`, "tiktok");
}, 120_000);

afterAll(async () => {
  await fxCleanup();
});

describe("a business's own measured posts are its lessons", () => {
  it("holds the post that did better and the one that did worse, in their own words", async () => {
    const lessons = await lessonsFor(b.profile_id, "instagram");
    expect(lessons?.helped).toEqual([
      expect.objectContaining({
        item_id: posted.better,
        text: BETTER,
        published_on: "2026-09-10",
      }),
    ]);
    expect(lessons?.backfired).toEqual([
      expect.objectContaining({ item_id: posted.worse, text: WORSE }),
    ]);
    // The verdict's own arithmetic rides along for the record.
    expect(lessons?.helped[0]?.arithmetic).toContain("reach 150 against a median of 100");
  });

  it("leaves out a post taken down again and a video, however they measured", async () => {
    const lessons = await lessonsFor(b.profile_id, "instagram");
    const ids = [...(lessons?.helped ?? []), ...(lessons?.backfired ?? [])].map((l) => l.item_id);
    expect(ids).not.toContain(posted["taken-down"]);
    expect(ids).not.toContain(posted.video);
    expect(ids).not.toContain(posted.same);
  });

  it("has none for a platform with no measured post, or a channel that is not one of them", async () => {
    expect(await lessonsFor(b.profile_id, "facebook")).toBeNull();
    expect(await lessonsForChannel(b.profile_id, tiktok)).toBeNull();
    expect(await lessonsForChannel(b.profile_id, crypto.randomUUID())).toBeNull();
    expect((await lessonsForChannel(b.profile_id, instagram))?.helped).toHaveLength(1);
  });
});

describe("an approved plan drafts its posts with the lessons in view", () => {
  const limitLlm: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

  it("gives them to a post, records them on the draft, and leaves an email as it was", async () => {
    const slot = (format: PlannedItem["format"], date: string): PlannedItem => ({
      date,
      channel_id: instagram,
      channel_label: format === "email" ? "Newsletter" : "Instagram",
      format,
      goal_id: null,
      focus: "Ember Candle",
      brief: "Say the Ember Candle is back.",
      evidence: [],
    });
    const plan = await createProposal({
      profile_id: b.profile_id,
      module: "content",
      originating_finding: `plan:${crypto.randomUUID()}`,
      action: {
        kind: "content_publishing",
        summary: "A week of posts",
        detail: { items: [slot("post", "2026-11-23"), slot("email", "2026-11-24")] },
      },
      scenario: fxScenario,
      reversibility: { level: "easy", if_you_change_your_mind: "discard the drafts" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await approveProposal({ proposalId: plan.id, userId: b.user_id });

    const sent: string[] = [];
    const draftLlm: DraftLlm = async ({ system }) => {
      sent.push(system);
      return { text: "Ember is back on the bench this week." };
    };
    const { items } = await produceFromProposal(plan.id, { draftLlm, limitLlm });
    expect(items.map((i) => i.kind)).toEqual(["post", "email"]);

    // The post: the model saw both examples, and the draft says which posts they were.
    expect(sent[0]).toContain("Did better than usual:");
    expect(sent[0]).toContain(BETTER);
    expect(sent[0]).toContain("Did worse than usual:");
    expect(sent[0]).toContain(WORSE);
    expect(sent[0]).not.toContain("An ordinary post");
    expect(sent[0]).not.toMatch(/median|reach \d/);
    const post = items.find((i) => i.kind === "post");
    expect((post?.provenance as { lessons?: unknown }).lessons).toEqual({
      platform: "instagram",
      helped: [posted.better],
      backfired: [posted.worse],
    });
    expect(post?.body.trimEnd()).toMatch(/Written with AI assistance\.$/);

    // The email: no posts in view, nothing recorded.
    expect(sent[1]).not.toContain("Did better than usual:");
    const email = items.find((i) => i.kind === "email");
    expect(email?.provenance).not.toHaveProperty("lessons");
  }, 60_000);
});
