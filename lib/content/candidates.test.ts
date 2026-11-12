// P6-03 — three AI video candidates per brief through Higgsfield, the
// owner picks one (rules 33 and 34), against the database and a FAKE HTTP
// layer: no test calls Higgsfield. What must hold: AI video is proposed
// only for a brief's shot list with no footage, from profile facts with
// their provenance and never from typed words; the proposal states the
// set's price in US cents and generates nothing; the monthly cap stops it
// BEFORE anything is submitted; once approved, the three are SUBMITTED and
// the call returns at once (the owner's decision of 2026-11-09), and the
// background collects them — each labelled as AI-generated in the file and
// on its row, each its own cost line tagged by workload, never downloaded
// twice, left pending while it can't be labelled here, and closed as failed
// past its deadline with unbilled room given back; the owner's pick goes on the video item and is
// offered for publishing (nothing posted without that yes); the other two
// are kept, marked not chosen; the pick is in the decision log; one pick
// per set.

import "dotenv/config";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  channels,
  connections,
  contentItems,
  creativeBriefs,
  decisionLog,
  fieldRecords,
  footageClips,
  intakeEvents,
  mediaCandidates,
  mediaGenerations,
  proposals,
  users,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { SourceRef } from "../core/source-ref";
import { HIGGSFIELD_DEFAULTS } from "../env";
import { connectForExecution, expectedExecutionScopes } from "../execution/connections";
import { bootstrapIntake } from "../intake/service";
import { growthReady } from "../growth/test-support";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal, createProposal } from "../proposals/service";
import {
  AI_VIDEO_WORKLOAD,
  CANDIDATE_DEADLINE_MS,
  DIRECTION_REFUSED,
  MIN_CHECK_GAP_MS,
  NEEDS_BRIEF,
  WAITING_FOR_LABEL,
  collectCandidates,
  pickCandidate,
  studioVideoView,
} from "./candidates";
import { mediaDisclosureLabel } from "./disclosure";
import { ffmpegAvailable } from "./edit";
import {
  HIGGSFIELD_NO_KEY,
  HIGGSFIELD_ORIGIN,
  higgsfieldMediaProvider,
} from "./generate/higgsfield";
import type { HttpFetch } from "./generate/higgsfield";
import { readVideoComment } from "./generate/label";
import { FIXED_INSTRUCTION } from "./generate/provider";
import type { GenerationSetup } from "./generation";
import {
  GENERATION_KIND,
  generateFromProposal,
  generationSetup,
  proposeGeneration,
} from "./generation";
import type { MediaStore } from "./media";
import { memoryMediaStore } from "./media";
import { mediaOf } from "./media-item";
import { SHOT_ANGLES } from "./video-prompt";

const run = promisify(execFile);
const limitsLlm: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });
const TMP = path.join(os.tmpdir(), `syb-candidates-test-${process.pid}`);
const LABEL = mediaDisclosureLabel("video", "generated_video");
let CLIP: Uint8Array = new Uint8Array();

beforeAll(async () => {
  if (!ffmpegAvailable()) return;
  await fs.mkdir(TMP, { recursive: true });
  const file = path.join(TMP, "clip.mp4");
  await run(ffmpegPath as string, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x8fb3a0:s=108x192:rate=10:duration=1",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  CLIP = new Uint8Array(await fs.readFile(file));
}, 60_000);

/**
 * A fake Higgsfield: each submit a new request; completed on the second
 * check; moderation, a failure, a clip that never finishes or one that
 * stays queued, on demand.
 */
function fakeHiggsfield(
  opts: {
    nsfwAngle?: number;
    failFirstAngle?: number;
    /** Never finishes: in_progress for ever (cancel refused, so it may be billed). */
    stuckAngle?: number;
    /** Stays queued (cancel accepted, so nothing is billed). */
    queuedAngle?: number;
    /** Finishes on the fourth check instead of the second. */
    slowAngle?: number;
  } = {},
) {
  const sent: {
    url: string;
    method: string;
    body: { prompt?: string } | null;
    key: string | null;
  }[] = [];
  const byId = new Map<string, { prompt: string; polls: number; fail: boolean }>();
  let n = 0;
  let failed = false;
  const angle = (prompt: string, i: number | undefined) =>
    i !== undefined && prompt.includes(SHOT_ANGLES[i]!);
  const fetch: HttpFetch = async (url, init) => {
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as { prompt: string }) : null;
    const headers = (init.headers ?? {}) as Record<string, string>;
    sent.push({ url, method: init.method ?? "GET", body, key: headers["idempotency-key"] ?? null });
    if (url.startsWith(`${HIGGSFIELD_ORIGIN}/kling-video/`)) {
      n += 1;
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const fail = !failed && angle(body!.prompt, opts.failFirstAngle);
      if (fail) failed = true;
      byId.set(id, { prompt: body!.prompt, polls: 0, fail });
      return Response.json({
        status: "queued",
        request_id: id,
        status_url: `${HIGGSFIELD_ORIGIN}/requests/${id}/status`,
        cancel_url: `${HIGGSFIELD_ORIGIN}/requests/${id}/cancel`,
      });
    }
    const cancel = /\/requests\/([0-9a-f-]+)\/cancel$/.exec(url);
    if (cancel) {
      const r = byId.get(cancel[1]!)!;
      return new Response(null, { status: angle(r.prompt, opts.queuedAngle) ? 202 : 400 });
    }
    const m = /\/requests\/([0-9a-f-]+)\/status$/.exec(url);
    if (m) {
      const r = byId.get(m[1]!)!;
      r.polls += 1;
      if (angle(r.prompt, opts.nsfwAngle))
        return Response.json({ status: "nsfw", request_id: m[1] });
      if (angle(r.prompt, opts.queuedAngle)) {
        return Response.json({ status: "queued", request_id: m[1] });
      }
      if (angle(r.prompt, opts.stuckAngle)) {
        return Response.json({ status: "in_progress", request_id: m[1] });
      }
      // Higgsfield's "failed": unbilled, and worth another attempt.
      if (r.fail)
        return Response.json({ status: "failed", request_id: m[1], error: "it fell over" });
      return Response.json(
        r.polls < (angle(r.prompt, opts.slowAngle) ? 4 : 2)
          ? { status: "in_progress", request_id: m[1] }
          : {
              status: "completed",
              request_id: m[1],
              video: { url: `https://cdn.higgsfield.test/${m[1]}.mp4` },
            },
      );
    }
    if (url.startsWith("https://cdn.higgsfield.test/")) return new Response(new Uint8Array(CLIP));
    throw new Error(`unexpected call to ${url}`);
  };
  const count = (pred: (s: (typeof sent)[number]) => boolean) => sent.filter(pred).length;
  return {
    fetch,
    sent,
    submits: () => count((s) => s.url.startsWith(`${HIGGSFIELD_ORIGIN}/kling-video/`)),
    checks: () => count((s) => s.url.endsWith("/status")),
    downloads: () => count((s) => s.url.startsWith("https://cdn.higgsfield.test/")),
  };
}

const higgsfield = (fetch: HttpFetch, monthCap = 6000): GenerationSetup => ({
  provider: higgsfieldMediaProvider({
    key: { id: "kid", secret: "ksecret" },
    model: HIGGSFIELD_DEFAULTS.model,
    usd_micros_per_second: HIGGSFIELD_DEFAULTS.usd_micros_per_second,
    fetch,
    // The real check (lib/site/fetch's vetAddresses, security review
    // 2026-11-09) does a live DNS lookup; this suite's fixture hosts are
    // fake on purpose, so a no-op stub keeps the suite network-free. The
    // real function has its own tests (lib/site/fetch.test.ts); the
    // refusal path's own test lives in generate/higgsfield.test.ts.
    vetUrl: async () => undefined,
  }),
  reason: null,
  setting: "higgsfield",
  caps: { currency: "USD", item_cap_minor: 1000, month_cap_minor: monthCap },
  candidates: 3,
});

/** The background's clock: each run a little later, past the gap between checks. */
let clock = Date.now();
const later = (ms = MIN_CHECK_GAP_MS + 1_000) =>
  new Date((clock = Math.max(clock, Date.now()) + ms));
const collect = (
  profileId: string,
  setup: GenerationSetup,
  store: MediaStore,
  extra: { now?: Date; labelling?: () => boolean } = {},
) =>
  collectCandidates({
    profileId,
    setup,
    store,
    now: extra.now ?? later(),
    labelling: extra.labelling ?? (() => true),
  });

/* ── fixtures ── */

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length > 0) {
    await db.delete(mediaCandidates).where(inArray(mediaCandidates.profile_id, ids));
    await db.delete(mediaGenerations).where(inArray(mediaGenerations.profile_id, ids));
    await db.delete(footageClips).where(inArray(footageClips.profile_id, ids));
    await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(creativeBriefs).where(inArray(creativeBriefs.profile_id, ids));
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(channels).where(inArray(channels.profile_id, ids));
    await db.delete(users).where(inArray(users.account_id, accountIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
  await fs.rm(TMP, { recursive: true, force: true });
});

async function fact(
  profileId: string,
  key: string,
  value: unknown,
  source: SourceRef = { kind: "owner_input" },
) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.75),
      source,
      observed_at: at,
      recorded_at: at,
    }),
  );
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function bakery() {
  const s = await bootstrapIntake();
  created.push(s);
  const offer = crypto.randomUUID();
  await fact(s.profile_id, "legal.country", "Hungary");
  await fact(s.profile_id, "identity.sells", "Sourdough bread and pastries, baked daily");
  await fact(s.profile_id, "offers.best_seller_id", offer);
  await fact(s.profile_id, `offers.${offer}.name`, "Rye sourdough loaf");
  await fact(s.profile_id, "marketing.brand.desired_feeling", "Warm, like a Sunday morning");
  await fact(s.profile_id, "marketing.brand.main_promise", "Bread the slow way");
  // Other people's words on the web never reach the prompt.
  await fact(s.profile_id, "positioning.differentiator", "SCRAPED-FROM-THE-WEB", {
    kind: "web_research",
    researched_url: "https://reviews.example/bakery",
  });
  const [ch] = await db
    .insert(channels)
    .values({ profile_id: s.profile_id })
    .returning({ id: channels.id });
  await fact(s.profile_id, `channels.${ch!.id}.type`, "social_organic");
  await fact(s.profile_id, `channels.${ch!.id}.platform`, "instagram");
  await connectForExecution({
    accountId: s.account_id,
    provider: "meta_publish",
    secret: JSON.stringify({
      access_token: "EAAp603Test",
      page_id: "1000000003",
      ig_user_id: "17800000000000003",
    }),
    verify: async () => ({ granted_scopes: expectedExecutionScopes("meta_publish") }),
  });
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p6-03-${crypto.randomUUID()}@test.local`,
      display_name: "P6-03 owner",
      role: "owner",
    })
    .returning({ id: users.id });
  // The v1 spec §10: a brief cites a §6.1 figure, and the voice is confirmed, before anything renders.
  const figureId = await growthReady(s.profile_id);
  const [brief] = await db
    .insert(creativeBriefs)
    .values({
      profile_id: s.profile_id,
      evidence: [figureId],
      campaign: "Autumn loaves",
      brief: {
        audience: { text: "Local families", countries: ["HU"], cites: [] },
        offer: { text: "The rye loaf", cites: [] },
        hooks: [
          {
            hook: "What 48 hours does to flour",
            script: "Close on the crust. Break it. Steam.",
            seconds: 12,
            cites: [{ id: "F1", kind: "fact", ref: "identity.sells" }],
            shots: [],
          },
        ],
      },
      sources: [],
      model: "test",
      attempts: 1,
      cost_eur: "0",
    })
    .returning();
  const plan = await createProposal({
    profile_id: s.profile_id,
    module: "content",
    action: { kind: "content_publishing", summary: "A shot list", detail: { items: [] } },
    scenario: {} as never,
    reversibility: { level: "easy", if_you_change_your_mind: "drafts are drafts" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const shotList = async (fromBrief = true) => {
    const [row] = await db
      .insert(contentItems)
      .values({
        profile_id: s.profile_id,
        proposal_id: plan.id,
        kind: "shot_list",
        channel_label: "instagram",
        scheduled_for: inDays(10),
        title: "Film for instagram — Autumn loaves",
        body: "Close on the crust.\n\nShot list prepared with AI assistance.",
        disclosure: "Shot list prepared with AI assistance.",
        provenance: {
          item: { channel_id: ch!.id, focus: "Autumn loaves" },
          evidence: [`channels.${ch!.id}.type`],
          ...(fromBrief ? { brief_id: brief!.id, hook_index: 0 } : {}),
        },
      })
      .returning();
    return row!;
  };
  const approve = (proposalId: string) =>
    approveProposal({ proposalId, userId: u!.id, profileId: s.profile_id });
  return { ...s, user_id: u!.id, brief_id: brief!.id, shotList, approve };
}

/* ── proposing ── */

describe("P6-03 — proposing three candidates", () => {
  it("states the set's price in US cents, rests on profile facts with provenance, and generates nothing", async () => {
    const b = await bakery();
    const sl = await b.shotList();
    const api = fakeHiggsfield();
    const p = await proposeGeneration({
      profileId: b.profile_id,
      itemId: sl.id,
      media: "video",
      setup: higgsfield(api.fetch),
      limitLlm: limitsLlm,
    });
    expect(p).toMatchObject({ status: "pending", originating_finding: `generate:${sl.id}` });
    const d = (p.action as { kind: string; summary: string; detail: Record<string, unknown> })
      .detail;
    expect((p.action as { kind: string }).kind).toBe(GENERATION_KIND);
    expect((p.action as { summary: string }).summary).toMatch(/3 AI video candidates.*\$1\.68/);
    expect(d).toMatchObject({
      candidates: 3,
      provider: "higgsfield",
      instruction: FIXED_INSTRUCTION,
      estimate: { amount_minor: 168, currency: "USD" },
      estimate_each: { amount_minor: 56, currency: "USD" },
      caps: { month: { amount_minor: 6000, currency: "USD" } },
      label: LABEL,
      brief: { brief_id: b.brief_id, hook_index: 0, hook: "What 48 hours does to flour" },
    });
    const prompts = d.prompts as string[];
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt).toContain("Sourdough bread and pastries");
      expect(prompt).toContain("Its best seller: Rye sourdough loaf.");
      expect(prompt).toContain("What 48 hours does to flour");
      expect(prompt).not.toContain("SCRAPED-FROM-THE-WEB");
    }
    // Rule 33: every fact used, with its record, status, source and date.
    const facts = d.facts as { key: string; record_id: string; source: string }[];
    expect(facts.map((f) => f.key)).toEqual(
      expect.arrayContaining(["identity.sells", "marketing.brand.desired_feeling"]),
    );
    expect(facts.every((f) => f.record_id && f.source === "owner_input")).toBe(true);
    expect(facts.some((f) => f.key === "positioning.differentiator")).toBe(false);
    // Nothing generated, nothing sent.
    expect(api.sent).toHaveLength(0);
    expect(
      await db.select().from(mediaGenerations).where(eq(mediaGenerations.proposal_id, p.id)),
    ).toHaveLength(0);
  });

  it("refuses typed directions, a shot list not made from a brief, and pictures (rule 33)", async () => {
    const b = await bakery();
    const sl = await b.shotList();
    const setup = higgsfield(fakeHiggsfield().fetch);
    await expect(
      proposeGeneration({
        profileId: b.profile_id,
        itemId: sl.id,
        media: "video",
        direction: "a customer typed: show my face",
        setup,
        limitLlm: limitsLlm,
      }),
    ).rejects.toMatchObject({ status: 422, message: DIRECTION_REFUSED });
    const loose = await b.shotList(false);
    await expect(
      proposeGeneration({
        profileId: b.profile_id,
        itemId: loose.id,
        media: "video",
        setup,
        limitLlm: limitsLlm,
      }),
    ).rejects.toMatchObject({ status: 409, message: NEEDS_BRIEF });
    await expect(
      proposeGeneration({
        profileId: b.profile_id,
        itemId: sl.id,
        media: "image",
        setup,
        limitLlm: limitsLlm,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("with no key, nothing is proposed and the refusal says what's needed", async () => {
    const b = await bakery();
    const sl = await b.shotList();
    const saved = { k: process.env.HIGGSFIELD_API_KEY, s: process.env.HIGGSFIELD_API_SECRET };
    delete process.env.HIGGSFIELD_API_KEY;
    delete process.env.HIGGSFIELD_API_SECRET;
    try {
      const setup = generationSetup("higgsfield");
      await expect(
        proposeGeneration({
          profileId: b.profile_id,
          itemId: sl.id,
          media: "video",
          setup,
          limitLlm: limitsLlm,
        }),
      ).rejects.toMatchObject({ status: 503, message: HIGGSFIELD_NO_KEY });
      const view = await studioVideoView(b.profile_id, setup);
      expect(view.setup).toMatchObject({ available: false, state: "needs_key" });
      expect(view.targets.map((t) => t.item_id)).toContain(sl.id);
    } finally {
      if (saved.k !== undefined) process.env.HIGGSFIELD_API_KEY = saved.k;
      if (saved.s !== undefined) process.env.HIGGSFIELD_API_SECRET = saved.s;
    }
  });

  it("the monthly cap refuses before anything is proposed", async () => {
    const b = await bakery();
    const sl = await b.shotList();
    await expect(
      proposeGeneration({
        profileId: b.profile_id,
        itemId: sl.id,
        media: "video",
        setup: higgsfield(fakeHiggsfield().fetch, 150),
        limitLlm: limitsLlm,
      }),
    ).rejects.toThrow(/this month past its \$1\.50 cap/);
  });
});

/* ── generating (submit now) and collecting (in the background), then picking ── */

const candidatesOf = (proposalId: string) =>
  db
    .select()
    .from(mediaCandidates)
    .where(eq(mediaCandidates.proposal_id, proposalId))
    .orderBy(mediaCandidates.ordinal);
const claimOf = async (proposalId: string) =>
  (await db.select().from(mediaGenerations).where(eq(mediaGenerations.proposal_id, proposalId)))[0];
const proposalOf = async (id: string) =>
  (await db.select().from(proposals).where(eq(proposals.id, id)))[0];

/** Propose a set for a fresh shot list, approve it, and submit it. */
async function submitted(
  b: Awaited<ReturnType<typeof bakery>>,
  api: ReturnType<typeof fakeHiggsfield>,
  monthCap?: number,
) {
  const sl = await b.shotList();
  const setup = higgsfield(api.fetch, monthCap);
  const p = await proposeGeneration({
    profileId: b.profile_id,
    itemId: sl.id,
    media: "video",
    setup,
    limitLlm: limitsLlm,
  });
  await b.approve(p.id);
  const store = memoryMediaStore();
  const out = await generateFromProposal({ proposalId: p.id, setup, store });
  return { sl, setup, store, p, out };
}

describe.skipIf(!ffmpegAvailable())("P6-03 — generating and picking", () => {
  it("submits three and returns at once; the background collects three labelled clips, each its own cost line; the pick is placed and offered, the rest kept", async () => {
    const b = await bakery();
    const sl = await b.shotList();
    const api = fakeHiggsfield();
    const setup = higgsfield(api.fetch);
    const p = await proposeGeneration({
      profileId: b.profile_id,
      itemId: sl.id,
      media: "video",
      setup,
      limitLlm: limitsLlm,
    });
    // Only an approved proposal generates.
    await expect(
      generateFromProposal({ proposalId: p.id, setup, store: memoryMediaStore() }),
    ).rejects.toMatchObject({ status: 409 });
    expect(api.sent).toHaveLength(0);
    await b.approve(p.id);

    const store = memoryMediaStore();
    const out = await generateFromProposal({
      proposalId: p.id,
      expectedProfileId: b.profile_id,
      setup,
      store,
    });
    // Submit, don't wait: three requests, not one status check, no file.
    expect(out).toMatchObject({
      status: "generating",
      cost: { amount_minor: 168, currency: "USD" },
    });
    expect(out.candidate_ids).toHaveLength(3);
    expect(api.submits()).toBe(3);
    expect(api.checks()).toBe(0);
    expect(api.downloads()).toBe(0);
    const pending = await candidatesOf(p.id);
    expect(pending.map((r) => r.status)).toEqual(["generating", "generating", "generating"]);
    for (const r of pending) {
      expect(r.request_id).toMatch(/^00000000-0000-4000-8000-/);
      expect(r.status_url).toBe(`${HIGGSFIELD_ORIGIN}/requests/${r.request_id}/status`);
      expect(r).toMatchObject({ attempts: 1, cost_minor: null, lease_until: null });
      expect(r.submitted_at).not.toBeNull();
    }
    // The set holds its price against the caps while it runs; the proposal is still open.
    expect(await claimOf(p.id)).toMatchObject({ status: "generating", estimate_minor: 168 });
    expect((await proposalOf(p.id))?.status).toBe("approved");
    // It can't be started twice.
    await expect(generateFromProposal({ proposalId: p.id, setup, store })).rejects.toMatchObject({
      status: 409,
    });

    // The studio shows it being made, not a second "generate" button.
    const making = await studioVideoView(b.profile_id, setup);
    const target = making.targets.find((t) => t.item_id === sl.id)!;
    expect(target).toMatchObject({ approved_proposal_id: null });
    expect(target.making_generation_id).not.toBeNull();
    expect(making.sets.find((s) => s.proposal_id === p.id)).toMatchObject({
      status: "generating",
      ready: 0,
      pending: 3,
    });

    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    try {
      // The first check: still running. The second: finished, collected, labelled, stored.
      expect(await collect(b.profile_id, setup, store)).toMatchObject({ checked: 3, ready: 0 });
      expect(await collect(b.profile_id, setup, store)).toMatchObject({
        ready: 3,
        sets_settled: 1,
      });
    } finally {
      spy.mockRestore();
    }
    expect(api.submits()).toBe(3);
    expect(api.downloads()).toBe(3);

    const rows = await candidatesOf(p.id);
    expect(rows.map((r) => r.status)).toEqual(["ready", "ready", "ready"]);
    for (const r of rows) {
      expect(r).toMatchObject({
        label: LABEL,
        workload: AI_VIDEO_WORKLOAD,
        cost_minor: 56,
        currency: "USD",
        attempts: 1,
        checks: 2,
        provider: "higgsfield",
        brief_id: b.brief_id,
        waiting: null,
      });
      expect(r.request_id).toMatch(/^00000000-0000-4000-8000-/);
      // Rule 33: labelled in the file before it was stored.
      const file = path.join(TMP, `cand-${r.ordinal}.mp4`);
      await fs.writeFile(file, store.read(r.media_url as string)!);
      expect(await readVideoComment(file)).toBe(LABEL);
    }
    // Rule 34: one cost line per candidate, tagged by workload.
    const costLines = logs
      .filter((l) => l.includes('"media_generation_cost"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(costLines).toHaveLength(3);
    for (const l of costLines) {
      expect(l).toMatchObject({
        workload: "ai_video",
        account_id: b.account_id,
        cost_minor: 56,
        currency: "USD",
        status: "ready",
      });
    }
    const gen = await claimOf(p.id);
    expect(gen).toMatchObject({ status: "generated", cost_minor: 168, currency: "USD" });
    expect((await proposalOf(p.id))?.status).toBe("executed");
    // Nothing is on an item, and nothing is offered for publishing, before the pick.
    const before = await db
      .select()
      .from(contentItems)
      .where(and(eq(contentItems.profile_id, b.profile_id), eq(contentItems.kind, "video")));
    expect(before).toHaveLength(0);

    // A later run has nothing to do: nothing is checked or downloaded twice.
    expect(await collect(b.profile_id, setup, store)).toMatchObject({ taken: 0 });
    expect(api.downloads()).toBe(3);

    // The studio shows the set.
    const view = await studioVideoView(b.profile_id, setup);
    const set = view.sets.find((s) => s.proposal_id === p.id)!;
    expect(set).toMatchObject({ ready: 3, pending: 0, chosen_id: null });
    expect(set.candidates).toHaveLength(3);
    expect(view.month).toMatchObject({
      spent: { amount_minor: 168, currency: "USD" },
      cap: { amount_minor: 6000, currency: "USD" },
    });

    // The pick.
    const chosen = rows[1]!;
    const picked = await pickCandidate({
      profileId: b.profile_id,
      candidateId: chosen.id,
      userId: b.user_id,
      store,
      limitLlm: limitsLlm,
    });
    const [video] = await db.select().from(contentItems).where(eq(contentItems.id, picked.item_id));
    expect(video).toMatchObject({ kind: "video", disclosure: LABEL, status: "drafted" });
    expect(video!.body.endsWith(LABEL)).toBe(true);
    expect(mediaOf(video!.provenance)).toMatchObject({
      origin: "generated_video",
      is_ai_generated: true,
      source_item_id: sl.id,
      detail: { generation_id: gen!.id, provider: "higgsfield", cost: { currency: "USD" } },
    });
    // Offered for publishing — the usual yes — never published here.
    expect(video!.publish_proposal_id).not.toBeNull();
    expect(picked.publish_proposed).toBe(true);

    const after2 = await candidatesOf(p.id);
    expect(after2.map((r) => r.status)).toEqual(["not_chosen", "chosen", "not_chosen"]);
    expect(after2[1]).toMatchObject({ chosen_by: b.user_id, result_item_id: picked.item_id });
    // Kept, not deleted: the others' files are still stored.
    for (const r of [after2[0]!, after2[2]!]) {
      expect(r.media_url).not.toBeNull();
      expect(store.read(r.media_url as string)).not.toBeNull();
    }
    const [logged] = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.kind, "media_pick"), eq(decisionLog.ref_id, chosen.id)));
    expect(logged).toMatchObject({ actor: "owner", user_id: b.user_id });

    // One pick per set.
    await expect(
      pickCandidate({
        profileId: b.profile_id,
        candidateId: rows[0]!.id,
        userId: b.user_id,
        store,
      }),
    ).rejects.toMatchObject({ status: 409 });
    // A foreign business can't reach it.
    await expect(
      pickCandidate({
        profileId: crypto.randomUUID(),
        candidateId: rows[0]!.id,
        userId: null,
        store,
      }),
    ).rejects.toMatchObject({ status: 404 });
  }, 120_000);

  it("the pick works once one is ready; a clip that lands after the pick is kept as not chosen", async () => {
    const b = await bakery();
    const api = fakeHiggsfield({ slowAngle: 2 });
    const { p, setup, store } = await submitted(b, api);
    await collect(b.profile_id, setup, store);
    await collect(b.profile_id, setup, store);
    const rows = await candidatesOf(p.id);
    expect(rows.map((r) => r.status)).toEqual(["ready", "ready", "generating"]);
    const set = (await studioVideoView(b.profile_id, setup)).sets.find(
      (s) => s.proposal_id === p.id,
    )!;
    expect(set).toMatchObject({ status: "generating", ready: 2, pending: 1 });
    // A candidate still being made can't be picked.
    await expect(
      pickCandidate({
        profileId: b.profile_id,
        candidateId: rows[2]!.id,
        userId: b.user_id,
        store,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const picked = await pickCandidate({
      profileId: b.profile_id,
      candidateId: rows[0]!.id,
      userId: b.user_id,
      store,
      limitLlm: limitsLlm,
    });
    expect(picked.item_id).toBeDefined();
    expect((await candidatesOf(p.id)).map((r) => r.status)).toEqual([
      "chosen",
      "not_chosen",
      "generating",
    ]);
    // The slow one lands after the pick: kept, as not chosen, and the set settles.
    await collect(b.profile_id, setup, store);
    expect(await collect(b.profile_id, setup, store)).toMatchObject({ ready: 1, sets_settled: 1 });
    const last = await candidatesOf(p.id);
    expect(last.map((r) => r.status)).toEqual(["chosen", "not_chosen", "not_chosen"]);
    expect(last[2]!.media_url).not.toBeNull();
    expect(await claimOf(p.id)).toMatchObject({ status: "generated", cost_minor: 168 });
  }, 120_000);

  it("a refused candidate costs nothing and the others still arrive", async () => {
    const b = await bakery();
    const api = fakeHiggsfield({ nsfwAngle: 1 });
    const { p, setup, store, out } = await submitted(b, api);
    expect(out.status).toBe("generating");
    await collect(b.profile_id, setup, store);
    await collect(b.profile_id, setup, store);
    const rows = await candidatesOf(p.id);
    expect(rows.map((r) => r.status)).toEqual(["ready", "failed", "ready"]);
    expect(rows[1]).toMatchObject({ cost_minor: 0, attempts: 1, media_url: null });
    expect(rows[1]!.error).toMatch(/moderation/);
    expect(await claimOf(p.id)).toMatchObject({ status: "generated", cost_minor: 112 });
  }, 120_000);

  it("the sweeper closes what never finished: canceled while queued is free, running is counted as spent; the proposal is freed", async () => {
    const b = await bakery();
    const api = fakeHiggsfield({ stuckAngle: 0, queuedAngle: 1 });
    const { p, sl, setup, store } = await submitted(b, api);
    await collect(b.profile_id, setup, store);
    await collect(b.profile_id, setup, store);
    expect((await candidatesOf(p.id)).map((r) => r.status)).toEqual([
      "generating",
      "generating",
      "ready",
    ]);
    // Still inside the deadline: nothing is closed.
    expect(await claimOf(p.id)).toMatchObject({ status: "generating", estimate_minor: 168 });

    const pastDeadline = new Date(Date.now() + CANDIDATE_DEADLINE_MS + 60_000);
    const swept = await collect(b.profile_id, setup, store, { now: pastDeadline });
    expect(swept).toMatchObject({ swept: 2, sets_settled: 1 });
    const rows = await candidatesOf(p.id);
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed", "ready"]);
    expect(rows[0]!.error).toMatch(/didn't finish this clip within 2 hours.*counted as spent/);
    expect(rows[0]!.cost_minor).toBe(56);
    // Never billed: its room is given back.
    expect(rows[1]!.error).toMatch(/canceled — nothing was billed/);
    expect(rows[1]!.cost_minor).toBe(0);
    expect(api.sent.filter((s) => s.url.endsWith("/cancel"))).toHaveLength(2);
    expect(await claimOf(p.id)).toMatchObject({ status: "generated", cost_minor: 112 });
    // The stuck set no longer holds its proposal open: the item can be proposed again.
    expect((await proposalOf(p.id))?.status).toBe("executed");
    const again = await proposeGeneration({
      profileId: b.profile_id,
      itemId: sl.id,
      media: "video",
      setup,
      limitLlm: limitsLlm,
    });
    expect(again.status).toBe("pending");
  }, 120_000);

  it("a set that never got an answer is closed at the deadline and its proposal recorded", async () => {
    const b = await bakery();
    const api = fakeHiggsfield();
    const { p, setup, store } = await submitted(b, api);
    // As if the function died right after submitting: no request ids were kept.
    await db
      .update(mediaCandidates)
      .set({ request_id: null, status_url: null, cancel_url: null })
      .where(eq(mediaCandidates.proposal_id, p.id));
    const swept = await collect(b.profile_id, setup, store, {
      now: new Date(Date.now() + CANDIDATE_DEADLINE_MS + 60_000),
    });
    expect(swept).toMatchObject({ swept: 3, sets_settled: 1 });
    const rows = await candidatesOf(p.id);
    expect(rows.every((r) => r.status === "failed" && r.cost_minor === 56)).toBe(true);
    expect(rows[0]!.error).toMatch(/never heard back.*counted as spent/);
    expect(await claimOf(p.id)).toMatchObject({ status: "failed", cost_minor: 168 });
    expect((await proposalOf(p.id))?.status).toBe("executed");
  }, 60_000);

  it("within the deadline, a lost answer is asked for again with the same Idempotency-Key", async () => {
    const b = await bakery();
    const api = fakeHiggsfield();
    const { p, setup, store } = await submitted(b, api);
    const [first] = await candidatesOf(p.id);
    await db
      .update(mediaCandidates)
      .set({ request_id: null, status_url: null, cancel_url: null })
      .where(eq(mediaCandidates.id, first!.id));
    const keys = () =>
      api.sent
        .filter((s) => s.url.startsWith(`${HIGGSFIELD_ORIGIN}/kling-video/`))
        .map((s) => s.key);
    const before = keys();
    await collect(b.profile_id, setup, store);
    const resent = keys().slice(before.length);
    // Ordinal 1, attempt 1: the key it was first sent with, so Higgsfield returns that request.
    expect(resent).toEqual([`syb-${first!.generation_id}-1-1`]);
    expect(before).toContain(resent[0]);
    const [again] = await candidatesOf(p.id);
    expect(again).toMatchObject({ status: "generating", attempts: 1 });
    expect(again!.request_id).not.toBeNull();
  }, 60_000);

  it("without FFmpeg a finished clip stays pending, paid for and saying why; it is collected once FFmpeg is here", async () => {
    const b = await bakery();
    const api = fakeHiggsfield();
    const { p, setup, store } = await submitted(b, api);
    const noFfmpeg = { labelling: () => false };
    await collect(b.profile_id, setup, store, noFfmpeg);
    const waiting = await collect(b.profile_id, setup, store, noFfmpeg);
    expect(waiting).toMatchObject({ waiting: 3, ready: 0, failed: 0 });
    expect(api.downloads()).toBe(0);
    const rows = await candidatesOf(p.id);
    expect(rows.map((r) => r.status)).toEqual(["generating", "generating", "generating"]);
    for (const r of rows) {
      expect(r.waiting).toBe(WAITING_FOR_LABEL);
      expect(r.completed_at).not.toBeNull();
      expect(r.media_url).toBeNull();
    }
    const view = await studioVideoView(b.profile_id, setup);
    expect(view.sets.find((s) => s.proposal_id === p.id)!.candidates[0]!.waiting).toBe(
      WAITING_FOR_LABEL,
    );
    expect(await claimOf(p.id)).toMatchObject({ status: "generating", estimate_minor: 168 });
    expect((await proposalOf(p.id))?.status).toBe("approved");

    // Past the 2-hour deadline it is NOT thrown away: it finished, and waits to be collected.
    const after = await collect(b.profile_id, setup, store, {
      now: new Date(Date.now() + CANDIDATE_DEADLINE_MS + 60_000),
    });
    expect(after).toMatchObject({ ready: 3, swept: 0, sets_settled: 1 });
    expect(api.downloads()).toBe(3);
  }, 120_000);

  it("two runs at once download each clip once (the lease)", async () => {
    const b = await bakery();
    const api = fakeHiggsfield();
    const { p, setup, store } = await submitted(b, api);
    await collect(b.profile_id, setup, store);
    const now = later();
    const both = await Promise.all([
      collectCandidates({ profileId: b.profile_id, setup, store, now, labelling: () => true }),
      collectCandidates({ profileId: b.profile_id, setup, store, now, labelling: () => true }),
    ]);
    expect(both[0].taken + both[1].taken).toBe(3);
    expect(both[0].ready + both[1].ready).toBe(3);
    expect(api.downloads()).toBe(3);
    expect((await candidatesOf(p.id)).map((r) => r.status)).toEqual(["ready", "ready", "ready"]);
  }, 120_000);

  it("the cap is checked again before anything is submitted, and real footage still wins", async () => {
    const b = await bakery();
    const sl = await b.shotList();
    const api = fakeHiggsfield();
    const p = await proposeGeneration({
      profileId: b.profile_id,
      itemId: sl.id,
      media: "video",
      setup: higgsfield(api.fetch),
      limitLlm: limitsLlm,
    });
    await b.approve(p.id);
    // The cap was lowered after the yes: nothing is submitted, and it stays approved.
    await expect(
      generateFromProposal({
        proposalId: p.id,
        setup: higgsfield(api.fetch, 100),
        store: memoryMediaStore(),
      }),
    ).rejects.toThrow(/past its \$1\.00 cap.*stays approved/);
    expect(api.sent).toHaveLength(0);

    // Footage arrives: nothing generated, nothing charged.
    await db.insert(footageClips).values({
      profile_id: b.profile_id,
      item_id: sl.id,
      status: "uploaded",
      store: "memory",
      pathname: `renders/${b.profile_id}/${sl.id}/clip-${"c".repeat(32)}.mp4`,
      url: `https://blob.test.invalid/renders/${b.profile_id}/${sl.id}/clip-${"c".repeat(32)}.mp4`,
      content_type: "video/mp4",
      declared_bytes: 10,
      bytes: 10,
      label: "c.mp4",
    });
    const out = await generateFromProposal({
      proposalId: p.id,
      setup: higgsfield(api.fetch),
      store: memoryMediaStore(),
    });
    expect(out).toMatchObject({ status: "not_needed", cost: { amount_minor: 0 } });
    expect(api.sent).toHaveLength(0);
  }, 60_000);

  it("pays for nothing when the clips couldn't be labelled here", async () => {
    const b = await bakery();
    const sl = await b.shotList();
    const api = fakeHiggsfield();
    const setup = higgsfield(api.fetch);
    const p = await proposeGeneration({
      profileId: b.profile_id,
      itemId: sl.id,
      media: "video",
      setup,
      limitLlm: limitsLlm,
    });
    await b.approve(p.id);
    await expect(
      generateFromProposal({
        proposalId: p.id,
        setup,
        store: memoryMediaStore(),
        labelling: () => false,
      }),
    ).rejects.toThrow(/can't be labelled.*nothing was generated or charged.*stays approved/);
    expect(api.sent).toHaveLength(0);
    expect(await claimOf(p.id)).toBeUndefined();
  }, 60_000);

  it("two sets started at once can't both fit into room for one (the caps hold under a race)", async () => {
    const b = await bakery();
    const one = await b.shotList();
    const two = await b.shotList();
    const api = fakeHiggsfield();
    // A set is 3 × 56¢ = $1.68; the month has room for one set, not two.
    const setup = higgsfield(api.fetch, 200);
    const propose = (itemId: string) =>
      proposeGeneration({
        profileId: b.profile_id,
        itemId,
        media: "video",
        setup,
        limitLlm: limitsLlm,
      });
    const p1 = await propose(one.id);
    const p2 = await propose(two.id);
    await b.approve(p1.id);
    await b.approve(p2.id);
    const results = await Promise.allSettled(
      [p1, p2].map((p) =>
        generateFromProposal({ proposalId: p.id, setup, store: memoryMediaStore() }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/past its \$2\.00 cap/);
    expect(api.submits()).toBe(3);
  }, 120_000);

  it("a set being made still holds its room: another set can't take it", async () => {
    const b = await bakery();
    const api = fakeHiggsfield();
    await submitted(b, api, 200);
    const two = await b.shotList();
    await expect(
      proposeGeneration({
        profileId: b.profile_id,
        itemId: two.id,
        media: "video",
        setup: higgsfield(api.fetch, 200),
        limitLlm: limitsLlm,
      }),
    ).rejects.toThrow(/past its \$2\.00 cap \(\$1\.68 spent so far\)/);
  }, 60_000);

  it("a retry takes its room from the ledger and gives back what an unbilled attempt didn't spend", async () => {
    const b = await bakery();
    const api = fakeHiggsfield({ failFirstAngle: 0 });
    const { p, setup, store } = await submitted(b, api, 200);
    // The first check: angle 0 failed (unbilled), so it is resubmitted at once; the others run on.
    expect(await collect(b.profile_id, setup, store)).toMatchObject({ retried: 1 });
    expect(api.submits()).toBe(4);
    const [retried] = await candidatesOf(p.id);
    expect(retried).toMatchObject({ status: "generating", attempts: 2, cost_minor: 0 });
    // The failed first attempt was free, so the retry fits: three clips for $1.68.
    await collect(b.profile_id, setup, store);
    await collect(b.profile_id, setup, store);
    const claim = await claimOf(p.id);
    expect(claim).toMatchObject({ status: "generated", cost_minor: 168 });
    expect(claim!.estimate_minor).toBeLessThanOrEqual(168);
    expect((await candidatesOf(p.id)).map((r) => r.status)).toEqual(["ready", "ready", "ready"]);
  }, 120_000);

  it("a retry the caps can't take is refused, and the candidate closes with its reason", async () => {
    const b = await bakery();
    const api = fakeHiggsfield({ failFirstAngle: 0 });
    const { p, setup, store } = await submitted(b, api, 200);
    // The cap is lowered after the set started: the retry no longer fits.
    const tight = higgsfield(api.fetch, 150);
    await collect(b.profile_id, tight, store);
    const [first] = await candidatesOf(p.id);
    expect(first).toMatchObject({ status: "failed", attempts: 1, cost_minor: 0 });
    expect(first!.error).toMatch(/^a retry it would take this month past its \$1\.50 cap/);
    expect(api.submits()).toBe(3);
    void setup;
  }, 60_000);

  it("the database refuses a candidate without the AI label", async () => {
    const b = await bakery();
    const sl = await b.shotList();
    const p = await createProposal({
      profile_id: b.profile_id,
      module: "content",
      action: { kind: GENERATION_KIND, summary: "x", detail: {} },
      scenario: {} as never,
      reversibility: { level: "moderate", if_you_change_your_mind: "x" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const [g] = await db
      .insert(mediaGenerations)
      .values({
        profile_id: b.profile_id,
        account_id: b.account_id,
        proposal_id: p.id,
        target_item_id: sl.id,
        creative_brief_id: b.brief_id,
        media: "video",
        provider: "higgsfield",
        estimate_minor: 56,
        currency: "USD",
        prompt_sha256: "x",
      })
      .returning();
    const row = {
      generation_id: g!.id,
      profile_id: b.profile_id,
      proposal_id: p.id,
      target_item_id: sl.id,
      ordinal: 1,
      provider: "higgsfield",
      prompt_sha256: "x",
      estimate_minor: 56,
      currency: "USD",
    };
    await expect(
      db.insert(mediaCandidates).values({ ...row, label: "A lovely clip." }),
    ).rejects.toThrow();
    await expect(
      db.insert(mediaCandidates).values({ ...row, label: LABEL }),
    ).resolves.toBeDefined();
  });
});
