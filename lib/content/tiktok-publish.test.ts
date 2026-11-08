// TikTok posting end to end — the owner override of 2026-11-08 — against a
// fake TikTok API and the real database. No real network: the global fetch
// fails the test if touched.
//
// What these tests hold, each with a passing and a failing case:
//   · the consent: a TikTok sign-in connects ONLY with exactly the consent's
//     scopes, the secret encrypted at rest, a decision-log consent row with
//     its hash; one scope more is refused by name and nothing is stored;
//   · the proposal: a TikTok video gets ONE proposal, labelled irreversible
//     ("hard") before approval, with TikTok's AI label on generated clips;
//   · the owner's choice: approval refused until "who can see it" is chosen;
//     unaudited, only "Only me" can be chosen; locked once approved;
//   · the engine: published once through the due runner with the gate on,
//     refused by name with it off, nothing with the stop on, a second run a
//     no-op; Withdraw says plainly it comes down in the TikTok app;
//   · the readback: public posts' counts land as observations.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  channels,
  connections,
  connectorSyncs,
  contentItems,
  decisionLog,
  executionAttempts,
  executions,
  fieldRecords,
  intakeEvents,
  metricObservations,
  modeDecisions,
  proposals,
  users,
  watchActivity,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { connectForExecution, expectedExecutionScopes } from "../execution/connections";
import { runDueExecutions } from "../execution/due";
import { haltExecutions, resumeExecutions } from "../execution/engine";
import type { TikTokCredential } from "../execution/providers/tiktok";
import {
  TIKTOK_NO_UNDO,
  approvedTikTokHash,
  createTikTokExecution,
} from "../execution/providers/tiktok";
import {
  FAKE_TIKTOK_OPEN_ID,
  FAKE_TIKTOK_UPLOAD_URL,
  fakeTikTok,
} from "../execution/providers/tiktok-fake";
import {
  TIKTOK_PHRASE,
  completeTikTokCallback,
  revokeTikTokPosting,
  signTikTokState,
  tiktokLoginConfig,
} from "../execution/tiktok-posting";
import { phraseHash } from "../execution/meta-login";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { ProposalError, approveProposal, createProposal } from "../proposals/service";
import { memoryMediaStore } from "./media";
import { TIKTOK_PUBLISH_UNDO, proposePublishing, publishReadiness } from "./publish";
import { withdrawItem } from "./publishing";
import {
  dbTikTokPublishBackend,
  runTikTokPostReadback,
  saveTikTokSettings,
  tiktokItemStates,
} from "./tiktok-publish";

const realFetchUsed = vi.fn(async () => {
  throw new Error("a real fetch was attempted in a TikTok test");
});
const gateBefore = process.env.SESSION_D_REAL_WRITES;
const gate = (on: boolean) => {
  if (on) process.env.SESSION_D_REAL_WRITES = "on";
  else delete process.env.SESSION_D_REAL_WRITES;
};
beforeAll(() => vi.stubGlobal("fetch", realFetchUsed));
beforeEach(() => gate(true));

const LABEL = "AI-generated video. Not real footage.";
const noSleep = async () => undefined;
const app = () => ({ client_key: "ck", client_secret: "cs" });
const limitsLlm: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });
const store = memoryMediaStore();
const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  expect(realFetchUsed).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  if (gateBefore === undefined) delete process.env.SESSION_D_REAL_WRITES;
  else process.env.SESSION_D_REAL_WRITES = gateBefore;
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  // The decision log is append-only (rule 7): its rows outlive the test.
  await db.delete(watchActivity).where(inArray(watchActivity.profile_id, ids));
  await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
  const rows = await db
    .select({ id: executions.id })
    .from(executions)
    .where(inArray(executions.profile_id, ids));
  if (rows.length > 0) {
    await db.delete(executionAttempts).where(
      inArray(
        executionAttempts.execution_id,
        rows.map((r) => r.id),
      ),
    );
  }
  await db.delete(executions).where(inArray(executions.profile_id, ids));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.account_id, accountIds));
  if (conns.length > 0) {
    const cids = conns.map((c) => c.id);
    await db.delete(metricObservations).where(inArray(metricObservations.connection_id, cids));
    await db.delete(connectorSyncs).where(inArray(connectorSyncs.connection_id, cids));
  }
  await db.delete(connections).where(inArray(connections.account_id, accountIds));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(channels).where(inArray(channels.profile_id, ids));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
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

function credential(over: Partial<TikTokCredential> = {}): TikTokCredential {
  return {
    v: 1,
    open_id: FAKE_TIKTOK_OPEN_ID,
    access_token: "act.stored",
    refresh_token: "rft.stored",
    access_expires_at: Date.now() + 3_600_000,
    refresh_expires_at: Date.now() + 100 * 86_400_000,
    scopes: [...expectedExecutionScopes("tiktok_publish")],
    username: "corner_cafe",
    nickname: "Corner Café",
    ...over,
  };
}

async function business(opts: { connect?: boolean } = {}) {
  const s = await bootstrapIntake();
  created.push(s);
  await owner(s.profile_id, "legal.country", "Hungary");
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: "instant",
    watch_weeks: null,
    inputs: { reasons: ["test fixture"] },
    reasoning: "test fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 42 * 86_400_000).toISOString(),
  });
  const [ch] = await db
    .insert(channels)
    .values({ profile_id: s.profile_id })
    .returning({ id: channels.id });
  await owner(s.profile_id, `channels.${ch!.id}.type`, "social_organic");
  await owner(s.profile_id, `channels.${ch!.id}.platform`, "tiktok");
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `tt-${crypto.randomUUID()}@test.local`,
      display_name: "TikTok owner",
      role: "owner",
    })
    .returning({ id: users.id });
  if (opts.connect !== false) {
    await connectForExecution({
      accountId: s.account_id,
      provider: "tiktok_publish",
      secret: JSON.stringify(credential()),
      verify: async () => ({ granted_scopes: expectedExecutionScopes("tiktok_publish") }),
    });
  }
  const plan = await createProposal({
    profile_id: s.profile_id,
    module: "content",
    action: { kind: "content_publishing", summary: "A plan", detail: { items: [] } },
    scenario: {} as never,
    reversibility: { level: "easy", if_you_change_your_mind: "drafts are drafts" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const video = async (
    over: { media?: string | null; generated?: boolean; date?: string } = {},
  ) => {
    const media =
      over.media === undefined
        ? (
            await store.put(
              `renders/test/${crypto.randomUUID()}/${crypto.randomUUID().replace(/-/g, "")}.mp4`,
              new Uint8Array(2048),
              "video/mp4",
            )
          ).url
        : over.media;
    const [row] = await db
      .insert(contentItems)
      .values({
        profile_id: s.profile_id,
        proposal_id: plan.id,
        kind: "video",
        channel_label: "tiktok",
        scheduled_for:
          over.date ?? new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
        title: "Autumn menu",
        body: `The soup is back.\n\n${LABEL}`,
        disclosure: LABEL,
        media_path: media,
        provenance: {
          item: { channel_id: ch!.id },
          evidence: [`channels.${ch!.id}.type`],
          media: {
            origin: "generated_video",
            source_item_id: "x",
            is_ai_generated: over.generated ?? true,
          },
        },
      })
      .returning();
    return row!;
  };
  return { ...s, user_id: u!.id, channel_id: ch!.id, video };
}

type Biz = Awaited<ReturnType<typeof business>>;

function harness(opts: Parameters<typeof fakeTikTok>[0] = {}) {
  const api = fakeTikTok(opts);
  const exec = createTikTokExecution({
    fetch: api.fetch,
    sleep: noSleep,
    app,
    audit: () => "unaudited",
    backend: dbTikTokPublishBackend({ store }),
  });
  const run = (b: Biz) =>
    runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { tiktok_publish: exec.publish },
    });
  return { api, exec, run };
}

const itemRow = async (id: string) =>
  (await db.select().from(contentItems).where(eq(contentItems.id, id)))[0]!;

/** A TikTok video, proposed, with "Only me" chosen, and approved to go out an hour ago. */
async function approved(b: Biz, h: ReturnType<typeof harness>) {
  const v = await b.video();
  const run = await proposePublishing(b.profile_id, [v.id], { limitLlm: limitsLlm });
  const p = run.created[0]!;
  await saveTikTokSettings({
    profileId: b.profile_id,
    accountId: b.account_id,
    itemId: v.id,
    input: { privacy_level: "SELF_ONLY", allow_comment: true },
    calls: h.exec.calls,
  });
  await approveProposal({
    proposalId: p.id,
    userId: b.user_id,
    profileId: b.profile_id,
    executeNotBefore: new Date(Date.now() - 3_600_000).toISOString(),
  });
  return { item_id: v.id, proposal_id: p.id };
}

describe("TikTok — which drafts qualify (pure)", () => {
  const DRAFT = {
    kind: "video",
    status: "drafted",
    channel_label: "tiktok",
    scheduled_for: "2026-11-20",
    media_path: "https://blob.test.invalid/r/a.mp4",
    publish_proposal_id: null,
  };
  const ready = (over: Record<string, unknown> = {}) =>
    publishReadiness({
      item: DRAFT,
      platform: "tiktok",
      assets: null,
      tiktok: { open_id: "o" },
      zone: "Europe/Budapest",
      ...over,
    });

  it("a dated TikTok video with a connected account qualifies, targeting that account", () => {
    expect(ready()).toEqual({ ok: true, platform: "tiktok", target: { open_id: "o" } });
  });

  it("says why not otherwise: connect TikTok, or it needs a video", () => {
    expect(ready({ tiktok: null })).toEqual({
      ok: false,
      reason: "connect TikTok posting on Connections to publish this to TikTok",
    });
    expect(ready({ item: { ...DRAFT, media_path: null } })).toEqual({
      ok: false,
      reason: "TikTok needs a video, and this item has none yet",
    });
    expect(
      ready({ item: { ...DRAFT, media_path: "https://blob.test.invalid/r/a.jpg" } }),
    ).toMatchObject({ ok: false });
    expect(ready({ item: { ...DRAFT, scheduled_for: null } })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no date/),
    });
  });
});

describe("TikTok — the consent (rule 13)", () => {
  const config = tiktokLoginConfig(
    { client_key: "ck", client_secret: "cs", redirect_uri: null, app_url: "https://app.test" },
    "https://app.test",
  );
  const state = (b: Biz, nonce: string) =>
    signTikTokState({
      v: 1,
      account_id: b.account_id,
      profile_id: b.profile_id,
      nonce,
      phrase_hash: phraseHash(TIKTOK_PHRASE),
      issued_at: Date.now(),
    });

  it("connects with exactly the consent's scopes: encrypted at rest, a consent row with its hash", async () => {
    const b = await business({ connect: false });
    const api = fakeTikTok();
    const calls = createTikTokExecution({ fetch: api.fetch, sleep: noSleep, app }).calls;
    const out = await completeTikTokCallback({
      accountId: b.account_id,
      userId: b.user_id,
      query: { code: "code-1", state: state(b, "n1"), error: null },
      nonceCookie: "n1",
      config,
      audit: "unaudited",
      calls,
    });
    expect(out.kind).toBe("connected");
    const [row] = await db
      .select()
      .from(connections)
      .where(
        and(eq(connections.account_id, b.account_id), eq(connections.provider, "tiktok_publish")),
      );
    expect(row?.purpose).toBe("execute");
    expect(row?.granted_scopes).toEqual(["user.info.basic", "video.list", "video.publish"]);
    expect(row?.encrypted_secret).not.toContain("act.new");
    const [consent] = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, b.profile_id), eq(decisionLog.kind, "consent")));
    expect(consent?.ref_id).toBe(row?.id);
    expect(consent?.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    // The code went to TikTok's token endpoint once, as a form, never in a URL.
    const token = api.calls.filter((c) => c.url.endsWith("/v2/oauth/token/"));
    expect(token).toHaveLength(1);
    expect(token[0]?.url).not.toContain("code-1");
    // Revoking wipes the secret here and asks TikTok too.
    const revoked = await revokeTikTokPosting(b.account_id, row!.id, { calls });
    expect(revoked.revoked_on_tiktok).toBe(true);
    const [after] = await db.select().from(connections).where(eq(connections.id, row!.id));
    expect(after?.encrypted_secret).toBeNull();
    expect(after?.status).toBe("disconnected");
  });

  it("one scope too many is refused by name, and nothing is stored", async () => {
    const b = await business({ connect: false });
    const calls = createTikTokExecution({
      fetch: fakeTikTok({ grantScope: "user.info.basic,video.publish,video.list,video.upload" })
        .fetch,
      sleep: noSleep,
      app,
    }).calls;
    const out = await completeTikTokCallback({
      accountId: b.account_id,
      userId: b.user_id,
      query: { code: "code-2", state: state(b, "n2"), error: null },
      nonceCookie: "n2",
      config,
      audit: "unaudited",
      calls,
    });
    expect(out).toEqual({ kind: "failed", reason: "scope" });
    const rows = await db
      .select()
      .from(connections)
      .where(eq(connections.account_id, b.account_id));
    expect(rows).toHaveLength(0);
  });

  it("a state from another nonce, or a cancel, connects nothing", async () => {
    const b = await business({ connect: false });
    const calls = createTikTokExecution({ fetch: fakeTikTok().fetch, sleep: noSleep, app }).calls;
    const replay = await completeTikTokCallback({
      accountId: b.account_id,
      userId: b.user_id,
      query: { code: "c", state: state(b, "n3"), error: null },
      nonceCookie: "someone-elses",
      config,
      audit: "unaudited",
      calls,
    });
    expect(replay).toEqual({ kind: "failed", reason: "start_again" });
    const cancel = await completeTikTokCallback({
      accountId: b.account_id,
      userId: b.user_id,
      query: { code: null, state: null, error: "access_denied" },
      nonceCookie: null,
      config,
      audit: "unaudited",
      calls,
    });
    expect(cancel).toEqual({ kind: "cancelled" });
  });
});

describe("TikTok — the proposal and the owner's choice", () => {
  it("one proposal per TikTok video, labelled irreversible before approval, with TikTok's AI label", async () => {
    const b = await business();
    const v = await b.video();
    const run = await proposePublishing(b.profile_id, [v.id], { limitLlm: limitsLlm });
    expect(run.created).toHaveLength(1);
    const p = run.created[0]!;
    expect(p.reversibility).toEqual({
      level: "hard",
      if_you_change_your_mind: TIKTOK_PUBLISH_UNDO,
    });
    expect(p.action).toMatchObject({
      kind: "content_publishing",
      detail: {
        item_id: v.id,
        platform: "tiktok",
        target: { open_id: FAKE_TIKTOK_OPEN_ID },
        is_aigc: true,
      },
    });
    // Without a TikTok connection, it says so instead.
    const none = await business({ connect: false });
    const w = await none.video();
    const skipped = await proposePublishing(none.profile_id, [w.id], { limitLlm: limitsLlm });
    expect(skipped.created).toHaveLength(0);
    expect(skipped.skipped[0]?.reason).toBe(
      "connect TikTok posting on Connections to publish this to TikTok",
    );
  });

  it("approval waits for 'who can see it'; unaudited, only 'Only me' can be chosen; locked once approved", async () => {
    const b = await business();
    const h = harness();
    const v = await b.video();
    const p = (await proposePublishing(b.profile_id, [v.id], { limitLlm: limitsLlm })).created[0]!;
    await expect(
      approveProposal({ proposalId: p.id, userId: b.user_id, profileId: b.profile_id }),
    ).rejects.toBeInstanceOf(ProposalError);
    await expect(
      saveTikTokSettings({
        profileId: b.profile_id,
        accountId: b.account_id,
        itemId: v.id,
        input: { privacy_level: "PUBLIC_TO_EVERYONE" },
        calls: h.exec.calls,
      }),
    ).rejects.toThrow(/only be private/);
    const saved = await saveTikTokSettings({
      profileId: b.profile_id,
      accountId: b.account_id,
      itemId: v.id,
      // allow_stitch is off on this account (creator_info): asked for, it stays off.
      input: { privacy_level: "SELF_ONLY", allow_comment: true, allow_stitch: true },
      calls: h.exec.calls,
    });
    expect(saved).toEqual({
      privacy_level: "SELF_ONLY",
      allow_comment: true,
      allow_duet: false,
      allow_stitch: false,
      brand_organic: false,
    });
    expect((await tiktokItemStates(b.profile_id, [await itemRow(v.id)]))[v.id]).toMatchObject({
      can_choose: true,
    });
    await approveProposal({ proposalId: p.id, userId: b.user_id, profileId: b.profile_id });
    const row = await itemRow(v.id);
    expect(row.status).toBe("queued");
    // The approval's hash covers the settings too.
    expect(row.publish_approved_sha256).toBe(approvedTikTokHash(row));
    await expect(
      saveTikTokSettings({
        profileId: b.profile_id,
        accountId: b.account_id,
        itemId: v.id,
        input: { privacy_level: "SELF_ONLY" },
        calls: h.exec.calls,
      }),
    ).rejects.toThrow(/can't change now/);
  });
});

describe("TikTok — through the engine (approval, the gate, the stop, at most once)", () => {
  it("publishes once with the gate on; a second run is a no-op; Withdraw says it comes down in the app", async () => {
    const b = await business();
    const h = harness();
    const { item_id } = await approved(b, h);
    await h.run(b);
    const row = await itemRow(item_id);
    expect(row.status).toBe("published");
    expect(row.platform).toBe("tiktok");
    expect(row.platform_post_id).toBe("v_pub_file~v2-1.123");
    expect(row.media_path).toBeNull(); // released: TikTok holds the bytes now
    const inits = () => h.api.calls.filter((c) => c.url.endsWith("/video/init/")).length;
    expect(inits()).toBe(1);
    expect(h.api.calls.filter((c) => c.url === FAKE_TIKTOK_UPLOAD_URL)).toHaveLength(1);
    const lines = await db
      .select({ detail: watchActivity.detail })
      .from(watchActivity)
      .where(eq(watchActivity.profile_id, b.profile_id));
    expect(lines.map((l) => l.detail)).toContain("Published 'Autumn menu' to TikTok.");
    await h.run(b);
    expect(inits()).toBe(1);
    await expect(
      withdrawItem({ itemId: item_id, profileId: b.profile_id, userId: b.user_id }),
    ).rejects.toThrow(TIKTOK_NO_UNDO);
  });

  it("with the real-write gate off, it is refused by name: nothing sent, the item untouched", async () => {
    const b = await business();
    const h = harness();
    const { item_id } = await approved(b, h);
    const before = h.api.calls.length;
    gate(false);
    const summary = await h.run(b);
    expect(
      summary.outcomes.some(
        (o) => o.result === "refused" && /TikTok posting is switched off/.test(o.detail ?? ""),
      ),
    ).toBe(true);
    expect(h.api.calls.length).toBe(before);
    expect((await itemRow(item_id)).status).toBe("queued");
  });

  it("with the emergency stop on, nothing goes out; after resume, it does", async () => {
    const b = await business();
    const h = harness();
    const { item_id } = await approved(b, h);
    await haltExecutions({ accountId: b.account_id, userId: b.user_id, reason: "test" });
    await h.run(b);
    expect(h.api.calls.filter((c) => c.url.endsWith("/video/init/"))).toHaveLength(0);
    expect((await itemRow(item_id)).status).toBe("queued");
    await resumeExecutions(b.account_id, b.user_id);
    await h.run(b);
    expect((await itemRow(item_id)).status).toBe("published");
  });

  it("a lost answer on the last chunk is read back in the same run, never sent again", async () => {
    const b = await business();
    const lossy = harness({ loseLastChunk: true });
    const { item_id } = await approved(b, lossy);
    await lossy.run(b);
    // The engine's next attempt read the status by publish_id instead of re-sending.
    expect((await itemRow(item_id)).status).toBe("published");
    expect(lossy.api.calls.filter((c) => c.url.endsWith("/video/init/"))).toHaveLength(1);
    expect(lossy.api.calls.filter((c) => c.url === FAKE_TIKTOK_UPLOAD_URL)).toHaveLength(1);
  });

  it("still processing at the end of the run: 'unconfirmed', and the next sweep settles it by reading back", async () => {
    const b = await business();
    const slow = harness({ statuses: [{ status: "PROCESSING_UPLOAD" }] });
    const { item_id } = await approved(b, slow);
    await slow.run(b);
    const mid = await itemRow(item_id);
    expect(mid.status).toBe("publishing");
    expect(mid.last_error).toMatch(/still processing/);
    // The sweep reads back once the run is over — with TikTok done now — and never posts again.
    const later = harness();
    await db
      .update(executions)
      .set({ started_at: new Date(Date.now() - 60 * 60_000).toISOString() })
      .where(eq(executions.proposal_id, mid.publish_proposal_id!));
    await later.run(b);
    expect((await itemRow(item_id)).status).toBe("published");
    expect(
      later.api.calls.filter(
        (c) => c.url.endsWith("/video/init/") || c.url === FAKE_TIKTOK_UPLOAD_URL,
      ),
    ).toHaveLength(0);
  });
});

describe("TikTok — readback of public posts", () => {
  it("a published post with a public id gets its counts; a private one writes nothing", async () => {
    const b = await business();
    const h = harness({
      statuses: [{ status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] }],
    });
    const pub = await b.video();
    await db
      .update(contentItems)
      .set({
        status: "published",
        platform: "tiktok",
        platform_post_id: "7300000000000000001",
        published_at: new Date().toISOString(),
        publish_attempt: { started_at: "x", caption_sha256: "y", publish_id: "v_pub_a" },
      })
      .where(eq(contentItems.id, pub.id));
    const priv = await b.video();
    await db
      .update(contentItems)
      .set({
        status: "published",
        platform: "tiktok",
        platform_post_id: "v_pub_b",
        published_at: new Date().toISOString(),
        publish_attempt: { started_at: "x", caption_sha256: "y", publish_id: "v_pub_b" },
      })
      .where(eq(contentItems.id, priv.id));
    const summary = await runTikTokPostReadback(new Date(), {
      calls: h.exec.calls,
      accountIds: [b.account_id],
    });
    expect(summary).toMatchObject({ connections: 1, ok: 1, failed: 0 });
    const [conn] = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.account_id, b.account_id));
    const obs = await db
      .select()
      .from(metricObservations)
      .where(eq(metricObservations.connection_id, conn!.id));
    const byKey = Object.fromEntries(obs.map((o) => [o.metric_key, Number(o.value_num)]));
    expect(byKey).toEqual({ "content.views.daily": 120, "content.interactions.daily": 12 });
    expect(
      obs.every(
        (o) =>
          (o.dimensions as { platform_post_id?: string }).platform_post_id ===
          "7300000000000000001",
      ),
    ).toBe(true);
    // The private one was asked about by its publish_id only — no public id, no counts.
    const q = h.api.calls.filter((c) => c.url.includes("/v2/video/query/"));
    expect((q[0]?.body?.["filters"] as { video_ids: string[] }).video_ids).toEqual([
      "7300000000000000001",
    ]);
  });
});
