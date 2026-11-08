// P6-03 — three AI video candidates per brief through Higgsfield, the
// owner picks one (rules 33 and 34), against the database and a FAKE HTTP
// layer: no test calls Higgsfield. What must hold: AI video is proposed
// only for a brief's shot list with no footage, from profile facts with
// their provenance and never from typed words; the proposal states the
// set's price in US cents and generates nothing; the monthly cap stops it
// BEFORE anything is submitted; once approved, three clips are made, each
// labelled as AI-generated in the file and on its row, each its own cost
// line tagged by workload; the owner's pick goes on the video item and is
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
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal, createProposal } from "../proposals/service";
import {
  AI_VIDEO_WORKLOAD,
  DIRECTION_REFUSED,
  NEEDS_BRIEF,
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

/** A fake Higgsfield: each submit a new request; completed on the second poll; moderation on demand. */
function fakeHiggsfield(opts: { nsfwAngle?: number } = {}) {
  const sent: { url: string; method: string; body: { prompt?: string } | null }[] = [];
  const byId = new Map<string, { prompt: string; polls: number }>();
  let n = 0;
  const fetch: HttpFetch = async (url, init) => {
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as { prompt: string }) : null;
    sent.push({ url, method: init.method ?? "GET", body });
    if (url.startsWith(`${HIGGSFIELD_ORIGIN}/kling-video/`)) {
      n += 1;
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      byId.set(id, { prompt: body!.prompt, polls: 0 });
      return Response.json({
        status: "queued",
        request_id: id,
        status_url: `${HIGGSFIELD_ORIGIN}/requests/${id}/status`,
        cancel_url: `${HIGGSFIELD_ORIGIN}/requests/${id}/cancel`,
      });
    }
    const m = /\/requests\/([0-9a-f-]+)\/status$/.exec(url);
    if (m) {
      const r = byId.get(m[1]!)!;
      r.polls += 1;
      if (opts.nsfwAngle !== undefined && r.prompt.includes(SHOT_ANGLES[opts.nsfwAngle]!)) {
        return Response.json({ status: "nsfw", request_id: m[1] });
      }
      return Response.json(
        r.polls < 2
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
  return { fetch, sent, submits: () => sent.filter((s) => s.method === "POST").length };
}

const higgsfield = (fetch: HttpFetch, monthCap = 6000): GenerationSetup => ({
  provider: higgsfieldMediaProvider({
    key: { id: "kid", secret: "ksecret" },
    model: HIGGSFIELD_DEFAULTS.model,
    usd_micros_per_second: HIGGSFIELD_DEFAULTS.usd_micros_per_second,
    fetch,
    sleep: async () => {},
  }),
  reason: null,
  setting: "higgsfield",
  caps: { currency: "USD", item_cap_minor: 1000, month_cap_minor: monthCap },
  candidates: 3,
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
  const [brief] = await db
    .insert(creativeBriefs)
    .values({
      profile_id: s.profile_id,
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

/* ── generating and picking ── */

describe.skipIf(!ffmpegAvailable())("P6-03 — generating and picking", () => {
  it("makes three labelled clips, each its own cost line; the pick is placed and offered, the rest kept", async () => {
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
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    let out;
    try {
      out = await generateFromProposal({
        proposalId: p.id,
        expectedProfileId: b.profile_id,
        setup,
        store,
      });
    } finally {
      spy.mockRestore();
    }
    expect(out).toMatchObject({
      status: "generated",
      cost: { amount_minor: 168, currency: "USD" },
    });
    expect(out.candidate_ids).toHaveLength(3);
    expect(api.submits()).toBe(3);

    const rows = await db
      .select()
      .from(mediaCandidates)
      .where(eq(mediaCandidates.proposal_id, p.id))
      .orderBy(mediaCandidates.ordinal);
    expect(rows.map((r) => r.status)).toEqual(["ready", "ready", "ready"]);
    for (const r of rows) {
      expect(r).toMatchObject({
        label: LABEL,
        workload: AI_VIDEO_WORKLOAD,
        cost_minor: 56,
        currency: "USD",
        attempts: 1,
        provider: "higgsfield",
        brief_id: b.brief_id,
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
      });
    }
    const [gen] = await db
      .select()
      .from(mediaGenerations)
      .where(eq(mediaGenerations.proposal_id, p.id));
    expect(gen).toMatchObject({ status: "generated", cost_minor: 168, currency: "USD" });
    const [after] = await db.select().from(proposals).where(eq(proposals.id, p.id));
    expect(after?.status).toBe("executed");
    // Nothing is on an item, and nothing is offered for publishing, before the pick.
    const before = await db
      .select()
      .from(contentItems)
      .where(and(eq(contentItems.profile_id, b.profile_id), eq(contentItems.kind, "video")));
    expect(before).toHaveLength(0);

    // The studio shows the set.
    const view = await studioVideoView(b.profile_id, setup);
    const set = view.sets.find((s) => s.proposal_id === p.id)!;
    expect(set.candidates).toHaveLength(3);
    expect(set.chosen_id).toBeNull();
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

    const after2 = await db
      .select()
      .from(mediaCandidates)
      .where(eq(mediaCandidates.proposal_id, p.id))
      .orderBy(mediaCandidates.ordinal);
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

  it("a refused candidate costs nothing and the others still arrive", async () => {
    const b = await bakery();
    const sl = await b.shotList();
    const api = fakeHiggsfield({ nsfwAngle: 1 });
    const setup = higgsfield(api.fetch);
    const p = await proposeGeneration({
      profileId: b.profile_id,
      itemId: sl.id,
      media: "video",
      setup,
      limitLlm: limitsLlm,
    });
    await b.approve(p.id);
    const out = await generateFromProposal({ proposalId: p.id, setup, store: memoryMediaStore() });
    expect(out).toMatchObject({ status: "generated", cost: { amount_minor: 112 } });
    expect(out.candidate_ids).toHaveLength(2);
    const rows = await db
      .select()
      .from(mediaCandidates)
      .where(eq(mediaCandidates.proposal_id, p.id))
      .orderBy(mediaCandidates.ordinal);
    expect(rows.map((r) => r.status)).toEqual(["ready", "failed", "ready"]);
    expect(rows[1]).toMatchObject({ cost_minor: 0, attempts: 1, media_url: null });
    expect(rows[1]!.error).toMatch(/moderation/);
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
