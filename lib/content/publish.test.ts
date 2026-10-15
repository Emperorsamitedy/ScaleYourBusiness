// P3-21a — publish proposals: the owner approves the finished item, not
// just the plan. What must hold: an item qualifies only by data (its
// channel's platform value, a connected Meta asset, media where the
// platform needs it, a date and a timezone) and otherwise says why in the
// owner's words; a qualifying draft gets ONE proposal naming item,
// platform and target, posting at 10:00 local; approving without a time
// keeps that time; and nothing is pre-bound for the runner to execute.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  channels,
  connections,
  contentItems,
  fieldRecords,
  intakeEvents,
  proposals,
  users,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { connectForExecution, expectedExecutionScopes } from "../execution/connections";
import { preboundPlan } from "../execution/due";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal, createProposal } from "../proposals/service";
import type { ReadinessItem } from "./publish";
import {
  DEFAULT_POSTING_HOUR,
  PUBLISH_UNDO,
  isPublishProposal,
  proposePublishing,
  publishNotes,
  publishReadiness,
  zonedInstant,
} from "./publish";

const DRAFT: ReadinessItem = {
  kind: "post",
  status: "drafted",
  channel_label: "facebook",
  scheduled_for: "2026-10-20",
  media_path: null,
  publish_proposal_id: null,
};
const ASSETS = { page_id: "1000000001", ig_user_id: "17800000000000001" };
const ready = (over: Partial<Parameters<typeof publishReadiness>[0]> = {}) =>
  publishReadiness({
    item: DRAFT,
    platform: "facebook",
    assets: ASSETS,
    zone: "Europe/Budapest",
    ...over,
  });

describe("P3-21a — which drafts qualify, and why the rest don't", () => {
  it("a dated Facebook post with a connected Page qualifies, targeting the Page", () => {
    expect(ready()).toEqual({ ok: true, platform: "facebook", target: { page_id: "1000000001" } });
  });

  it("Instagram targets the Instagram account, and needs media", () => {
    expect(ready({ platform: "instagram" })).toEqual({
      ok: false,
      reason: "Instagram needs an image or a video, and this item has none yet",
    });
    expect(
      ready({
        platform: "instagram",
        item: { ...DRAFT, kind: "video", media_path: "https://blob/x.mp4" },
      }),
    ).toEqual({ ok: true, platform: "instagram", target: { ig_user_id: "17800000000000001" } });
    expect(
      ready({
        platform: "instagram",
        item: { ...DRAFT, media_path: "https://blob/x.jpg" },
        assets: { page_id: "1000000001", ig_user_id: null },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/no Instagram account/) });
  });

  it("every refusal says why, in the owner's words", () => {
    const reason = (r: ReturnType<typeof ready>) => (r.ok ? null : r.reason);
    expect(reason(ready({ platform: "tiktok", item: { ...DRAFT, channel_label: "tiktok" } }))).toBe(
      "SYB can't publish to tiktok — only to a Facebook Page or Instagram account you connect",
    );
    expect(reason(ready({ platform: null }))).toMatch(/can't publish to facebook/);
    expect(reason(ready({ assets: null }))).toBe(
      "connect Meta publishing on Connections to publish this to Facebook",
    );
    expect(reason(ready({ item: { ...DRAFT, kind: "shot_list" } }))).toMatch(/for filming/);
    expect(reason(ready({ item: { ...DRAFT, kind: "email" } }))).toMatch(/emails aren't sent/);
    expect(reason(ready({ item: { ...DRAFT, scheduled_for: null } }))).toMatch(/no date/);
    expect(reason(ready({ zone: null, zoneReason: "the country isn't known" }))).toBe(
      "the posting time can't be set: the country isn't known",
    );
    expect(reason(ready({ item: { ...DRAFT, status: "published" } }))).toMatch(
      /published, not a draft/,
    );
    expect(reason(ready({ item: { ...DRAFT, publish_proposal_id: "p" } }))).toBe(
      "already proposed for publishing",
    );
  });
});

describe("P3-21a — the posting time, in the business's clock", () => {
  it("10:00 local is converted to the right instant either side of a DST change", () => {
    // Budapest leaves summer time on 2026-10-25.
    expect(zonedInstant("2026-10-20", 10, "Europe/Budapest").toISOString()).toBe(
      "2026-10-20T08:00:00.000Z",
    );
    expect(zonedInstant("2026-11-02", 10, "Europe/Budapest").toISOString()).toBe(
      "2026-11-02T09:00:00.000Z",
    );
    expect(zonedInstant("2026-10-20", 10, "Asia/Kolkata").toISOString()).toBe(
      "2026-10-20T04:30:00.000Z",
    );
  });

  it("a publish proposal is told apart from a calendar plan by naming an item", () => {
    expect(isPublishProposal({ kind: "content_publishing", detail: { item_id: "i" } })).toBe(true);
    expect(isPublishProposal({ kind: "content_publishing", detail: { items: [] } })).toBe(false);
    expect(isPublishProposal(null)).toBe(false);
  });
});

/* ── end to end, against the database ── */

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length > 0) {
    await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(channels).where(inArray(channels.profile_id, ids));
    await db.delete(users).where(inArray(users.account_id, accountIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
});

async function owner(profileId: string, key: string, value: unknown) {
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

const limitsLlm: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

async function business(withMeta: boolean) {
  const s = await bootstrapIntake();
  created.push(s);
  await owner(s.profile_id, "legal.country", "Hungary");
  const channel = async (platform: string) => {
    const [ch] = await db
      .insert(channels)
      .values({ profile_id: s.profile_id })
      .returning({ id: channels.id });
    await owner(s.profile_id, `channels.${ch!.id}.type`, "social_organic");
    await owner(s.profile_id, `channels.${ch!.id}.platform`, platform);
    return ch!.id;
  };
  const facebook = await channel("facebook");
  const instagram = await channel("instagram");
  if (withMeta) {
    await connectForExecution({
      accountId: s.account_id,
      provider: "meta_publish",
      secret: JSON.stringify({ access_token: "EAApublishTest", page_id: ASSETS.page_id }),
      verify: async () => ({ granted_scopes: expectedExecutionScopes("meta_publish") }),
    });
  }
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-21a-${crypto.randomUUID()}@test.local`,
      display_name: "P3-21a owner",
      role: "owner",
    })
    .returning({ id: users.id });
  const plan = await createProposal({
    profile_id: s.profile_id,
    module: "content",
    action: { kind: "content_publishing", summary: "A plan", detail: { items: [] } },
    scenario: {} as never,
    reversibility: { level: "easy", if_you_change_your_mind: "drafts are drafts" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const item = async (channelId: string, label: string, date: string) => {
    const [row] = await db
      .insert(contentItems)
      .values({
        profile_id: s.profile_id,
        proposal_id: plan.id,
        kind: "post",
        channel_label: label,
        scheduled_for: date,
        title: `Autumn menu — ${label}`,
        body: "The autumn menu is here.",
        disclosure: "Written with AI assistance.",
        provenance: { item: { channel_id: channelId }, evidence: [`channels.${channelId}.type`] },
      })
      .returning();
    return row!;
  };
  return { ...s, user_id: u!.id, facebook, instagram, item };
}

describe("P3-21a — proposePublishing", () => {
  const NOW = new Date("2026-10-15T09:00:00Z");

  it("one proposal per qualifying draft, naming item, platform and target, at 10:00 local", async () => {
    const b = await business(true);
    const fb = await b.item(b.facebook, "facebook", "2026-10-20");
    const ig = await b.item(b.instagram, "instagram", "2026-10-21");

    const run = await proposePublishing(b.profile_id, [fb.id, ig.id], {
      now: NOW,
      limitLlm: limitsLlm,
    });
    expect(run.created).toHaveLength(1);
    expect(run.skipped).toEqual([
      {
        item_id: ig.id,
        reason:
          "the Meta connection has no Instagram account — reconnect with its id to publish there",
      },
    ]);

    const [p] = run.created;
    expect(p).toMatchObject({
      module: "content",
      status: "pending",
      originating_finding: `publish:${fb.id}`,
    });
    expect(p!.action).toMatchObject({
      kind: "content_publishing",
      summary: 'Publish "Autumn menu — facebook" to Facebook on 2026-10-20 at 10:00',
      detail: {
        item_id: fb.id,
        platform: "facebook",
        target: { page_id: ASSETS.page_id },
        posting_hour: DEFAULT_POSTING_HOUR,
        zone: "Europe/Budapest",
        publish_at: "2026-10-20T08:00:00.000Z",
        evidence: [`channels.${b.facebook}.type`],
      },
    });
    expect(p!.reversibility).toEqual({ level: "easy", if_you_change_your_mind: PUBLISH_UNDO });
    expect(Date.parse(p!.expires_at)).toBeLessThanOrEqual(Date.parse("2026-10-20T08:00:00.000Z"));

    const [linked] = await db.select().from(contentItems).where(eq(contentItems.id, fb.id));
    expect(linked?.publish_proposal_id).toBe(p!.id);
    expect(linked?.status).toBe("drafted");

    // Idempotent: proposing again creates nothing.
    const again = await proposePublishing(b.profile_id, [fb.id], { now: NOW, limitLlm: limitsLlm });
    expect(again.created).toHaveLength(0);
    expect(again.skipped[0]?.reason).toBe("already proposed for publishing");
  });

  it("approving without a time keeps the proposal's posting time; nothing is pre-bound to execute", async () => {
    const b = await business(true);
    const fb = await b.item(b.facebook, "facebook", "2026-12-01");
    const [p] = (await proposePublishing(b.profile_id, [fb.id], { now: NOW, limitLlm: limitsLlm }))
      .created;
    const approved = await approveProposal({
      proposalId: p!.id,
      userId: b.user_id,
      profileId: b.profile_id,
    });
    expect(Date.parse(approved.execute_not_before ?? "")).toBe(Date.parse("2026-12-01T09:00:00Z"));
    // The runner leaves it approved until the publish ops exist (P3-21b).
    expect(preboundPlan(approved)).toBeNull();

    const picked = await (async () => {
      const fb2 = await b.item(b.facebook, "facebook", "2026-12-02");
      const [p2] = (
        await proposePublishing(b.profile_id, [fb2.id], { now: NOW, limitLlm: limitsLlm })
      ).created;
      return approveProposal({
        proposalId: p2!.id,
        userId: b.user_id,
        profileId: b.profile_id,
        executeNotBefore: "2026-12-02T15:30:00.000Z",
      });
    })();
    expect(Date.parse(picked.execute_not_before ?? "")).toBe(Date.parse("2026-12-02T15:30:00Z")); // the owner's pick wins
  });

  it("without a Meta connection nothing is proposed, and the queue says how to fix it", async () => {
    const b = await business(false);
    const fb = await b.item(b.facebook, "facebook", "2026-10-20");
    const past = await b.item(b.facebook, "facebook", "2026-10-01");
    const run = await proposePublishing(b.profile_id, [fb.id], { now: NOW, limitLlm: limitsLlm });
    expect(run.created).toHaveLength(0);
    const items = await db
      .select()
      .from(contentItems)
      .where(inArray(contentItems.id, [fb.id, past.id]));
    const notes = await publishNotes(b.profile_id, items);
    expect(notes[fb.id]).toBe("connect Meta publishing on Connections to publish this to Facebook");
  });

  it("a draft whose date has passed is not proposed", async () => {
    const b = await business(true);
    const past = await b.item(b.facebook, "facebook", "2026-10-15");
    const run = await proposePublishing(b.profile_id, [past.id], { now: NOW, limitLlm: limitsLlm });
    expect(run.created).toHaveLength(0);
    expect(run.skipped[0]?.reason).toBe("its date (2026-10-15) has passed");
  });
});
