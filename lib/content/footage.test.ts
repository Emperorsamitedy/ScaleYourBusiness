// P3-52 — footage in. What must hold: an upload is granted only for the
// owner's own shot list (or a post needing media), only for phone video,
// only under the caps, at a pathname SYB chose; a "confirmed" upload is
// believed only from the store's own answer; the cut is arithmetic; the
// render lands on a video item through attachRenderedMedia, labelled as an
// edit of real footage, and that item gets its publish proposal; the clips
// leave storage; FFmpeg missing is a waiting state, not a failure; and
// real footage wins over a generated version already approved.

import "dotenv/config";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { eq, inArray } from "drizzle-orm";
import { path as ffprobePath } from "ffprobe-static";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  channels,
  connections,
  contentItems,
  fieldRecords,
  footageClips,
  footageRenders,
  intakeEvents,
  proposals,
  users,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { connectForExecution, expectedExecutionScopes } from "../execution/connections";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { createProposal } from "../proposals/service";
import { disclosureLabel, mediaDisclosureLabel } from "./disclosure";
import { ffmpegAvailable, makeTestClip } from "./edit";
import {
  MAX_CLIP_BYTES,
  MAX_CLIPS_PER_ITEM,
  WAITING_FOR_FFMPEG,
  clipLabel,
  confirmClipUpload,
  cutPlan,
  issueClipUpload,
  looksLikeVideoContainer,
  requestRender,
  runRender,
  storeClipDirect,
  sweepRenders,
} from "./footage";
import { memoryMediaStore } from "./media";
import { mediaOf, placeMedia, supersededByFootage } from "./media-item";
import { publishPlan } from "./publishing";

const run = promisify(execFile);
const TMP = path.join(process.cwd(), ".data", "test-footage");
const MP4_HEAD = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const limitsLlm: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

describe("P3-52 — the pure parts", () => {
  it("cuts every clip from its start, at most its share of a minute, and refuses under 3 s", () => {
    const clip = (id: string, s: number, audio = true) => ({
      clip_id: id,
      input: `${id}.mp4`,
      duration_s: s,
      width: 1080,
      height: 1920,
      has_audio: audio,
    });
    const two = cutPlan([clip("a", 50), clip("b", 4.2, false)]);
    expect(two.map((c) => [c.clip_id, c.start, c.duration, c.has_audio])).toEqual([
      ["a", 0, 30, true],
      ["b", 0, 4.2, false],
    ]);
    const eight = cutPlan(Array.from({ length: 8 }, (_, i) => clip(`c${i}`, 20)));
    expect(eight.reduce((n, c) => n + c.duration, 0)).toBeLessThanOrEqual(60);
    expect(() => cutPlan([clip("s", 1.5), clip("t", 1)])).toThrow(/at least 3 seconds/);
    expect(() => cutPlan([clip("z", 0.2)])).toThrow(/no(ne)? .*footage/);
  });

  it("knows a video container by its bytes, not its name, and cleans the file's name", () => {
    expect(looksLikeVideoContainer(MP4_HEAD)).toBe(true);
    expect(looksLikeVideoContainer(new TextEncoder().encode("<html><body>hi</body>"))).toBe(false);
    expect(clipLabel("C:\\Users\\me\\IMG_0042.MOV")).toBe("IMG_0042.MOV");
    expect(clipLabel("../../etc/<script>.mp4")).toBe("script.mp4");
    expect(clipLabel(undefined)).toBe("clip");
  });
});

/* ── against the database ── */

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length > 0) {
    await db.delete(footageRenders).where(inArray(footageRenders.profile_id, ids));
    await db.delete(footageClips).where(inArray(footageClips.profile_id, ids));
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
  await fs.rm(TMP, { recursive: true, force: true });
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

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  await owner(s.profile_id, "legal.country", "Hungary");
  const [ch] = await db
    .insert(channels)
    .values({ profile_id: s.profile_id })
    .returning({ id: channels.id });
  await owner(s.profile_id, `channels.${ch!.id}.type`, "social_organic");
  await owner(s.profile_id, `channels.${ch!.id}.platform`, "instagram");
  await connectForExecution({
    accountId: s.account_id,
    provider: "meta_publish",
    secret: JSON.stringify({
      access_token: "EAAfootageTest",
      page_id: "1000000001",
      ig_user_id: "17800000000000001",
    }),
    verify: async () => ({ granted_scopes: expectedExecutionScopes("meta_publish") }),
  });
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-52-${crypto.randomUUID()}@test.local`,
      display_name: "P3-52 owner",
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
  const shotList = async (date: string | null = inDays(9)) => {
    const [row] = await db
      .insert(contentItems)
      .values({
        profile_id: s.profile_id,
        proposal_id: plan.id,
        kind: "shot_list",
        channel_label: "instagram",
        scheduled_for: date,
        title: "Film for instagram — Autumn menu",
        body: "Film the autumn menu.\n\nShot list prepared with AI assistance.",
        disclosure: "Shot list prepared with AI assistance.",
        provenance: {
          item: { channel_id: ch!.id, focus: "Autumn menu", brief: "the new soups" },
          evidence: [`channels.${ch!.id}.type`],
        },
      })
      .returning();
    return row!;
  };
  return { ...s, user_id: u!.id, channel: ch!.id, plan, shotList };
}

describe("P3-52 — the upload grant (production: straight to Blob)", () => {
  it("grants one server-chosen pathname for the owner's shot list, typed and capped", async () => {
    const b = await business();
    const sl = await b.shotList();
    const minted: Parameters<NonNullable<Parameters<typeof issueClipUpload>[0]["mint"]>>[0][] = [];
    const grant = await issueClipUpload({
      profileId: b.profile_id,
      itemId: sl.id,
      contentType: "video/quicktime",
      bytes: 50_000_000,
      name: "IMG_0042.MOV",
      mint: async (a) => {
        minted.push(a);
        return "vercel_blob_client_test";
      },
    });
    expect(grant.pathname).toMatch(
      new RegExp(`^renders/${b.profile_id}/${sl.id}/clip-[0-9a-f]{32}\\.mov$`),
    );
    expect(minted[0]).toMatchObject({
      pathname: grant.pathname,
      contentType: "video/quicktime",
      maxBytes: MAX_CLIP_BYTES,
    });
    const [row] = await db.select().from(footageClips).where(eq(footageClips.id, grant.clip_id));
    expect(row).toMatchObject({ status: "issued", label: "IMG_0042.MOV", url: null });

    const ask = (over: Partial<Parameters<typeof issueClipUpload>[0]>) =>
      issueClipUpload({
        profileId: b.profile_id,
        itemId: sl.id,
        contentType: "video/mp4",
        bytes: 1000,
        name: "x.mp4",
        mint: async () => "t",
        ...over,
      });
    await expect(ask({ contentType: "image/svg+xml" })).rejects.toMatchObject({ status: 415 });
    await expect(ask({ bytes: MAX_CLIP_BYTES + 1 })).rejects.toMatchObject({ status: 413 });
    await expect(ask({ bytes: 0 })).rejects.toMatchObject({ status: 422 });
    // A foreign profile's item is missing, not forbidden.
    const other = await business();
    await expect(ask({ profileId: other.profile_id })).rejects.toMatchObject({ status: 404 });
  });

  it("stops at the clip count", async () => {
    const b = await business();
    const sl = await b.shotList();
    for (let i = 0; i < MAX_CLIPS_PER_ITEM; i++) {
      await issueClipUpload({
        profileId: b.profile_id,
        itemId: sl.id,
        contentType: "video/mp4",
        bytes: 1000,
        name: `${i}.mp4`,
        mint: async () => "t",
      });
    }
    await expect(
      issueClipUpload({
        profileId: b.profile_id,
        itemId: sl.id,
        contentType: "video/mp4",
        bytes: 1000,
        name: "one-more.mp4",
        mint: async () => "t",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("believes an upload only from the store's own answer", async () => {
    const b = await business();
    const sl = await b.shotList();
    const grant = await issueClipUpload({
      profileId: b.profile_id,
      itemId: sl.id,
      contentType: "video/mp4",
      bytes: 2_000_000,
      name: "a.mp4",
      mint: async () => "t",
    });
    const url = `https://abc123.public.blob.vercel-storage.com/${grant.pathname}`;
    const confirm = (
      head: NonNullable<Parameters<typeof confirmClipUpload>[0]["head"]>,
      now?: Date,
    ) =>
      confirmClipUpload({
        profileId: b.profile_id,
        itemId: sl.id,
        clipId: grant.clip_id,
        head,
        ...(now ? { now } : {}),
      });
    await expect(confirm(async () => null)).rejects.toMatchObject({ status: 409 });
    await expect(
      confirm(async () => ({
        url: "https://evil.example/x.mp4",
        size: 2_000_000,
        contentType: "video/mp4",
      })),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      confirm(async () => ({ url, size: 2_000_000, contentType: "text/html" })),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      confirm(
        async () => ({ url, size: 2_000_000, contentType: "video/mp4" }),
        new Date(Date.now() + 31 * 60_000),
      ),
    ).rejects.toMatchObject({ status: 410 });
    const ok = await confirm(async () => ({ url, size: 1_999_000, contentType: "video/mp4" }));
    expect(ok).toMatchObject({ status: "uploaded", url, bytes: 1_999_000 });
  });
});

describe("P3-52 — through the route, to the local store (development)", () => {
  it("refuses bytes that aren't video, whatever the name, and keeps the rest", async () => {
    const b = await business();
    const sl = await b.shotList();
    const store = memoryMediaStore();
    await expect(
      storeClipDirect({
        profileId: b.profile_id,
        itemId: sl.id,
        name: "clip.mp4",
        contentType: "video/mp4",
        body: new TextEncoder().encode("<html>not a video at all</html>"),
        store,
      }),
    ).rejects.toMatchObject({ status: 415 });
    const clip = await storeClipDirect({
      profileId: b.profile_id,
      itemId: sl.id,
      name: "clip.mp4",
      contentType: "video/mp4",
      body: new Uint8Array([...MP4_HEAD, 1, 2, 3]),
      store,
    });
    expect(clip).toMatchObject({ status: "uploaded", store: "memory", bytes: 15 });
    expect(store.read(clip.url as string)).not.toBeNull();
  });

  it("a cut needs clips and a caption, and only one runs at a time", async () => {
    const b = await business();
    const sl = await b.shotList();
    const ask = () =>
      requestRender({
        profileId: b.profile_id,
        itemId: sl.id,
        userId: b.user_id,
        caption: "Soup.",
      });
    await expect(ask()).rejects.toMatchObject({ status: 422 });
    await storeClipDirect({
      profileId: b.profile_id,
      itemId: sl.id,
      name: "a.mp4",
      contentType: "video/mp4",
      body: new Uint8Array([...MP4_HEAD, 9]),
      store: memoryMediaStore(),
    });
    await expect(
      requestRender({ profileId: b.profile_id, itemId: sl.id, userId: b.user_id }),
    ).rejects.toThrow(/needs a caption/);
    const first = await ask();
    expect(first.status).toBe("queued");
    await expect(ask()).rejects.toMatchObject({ status: 409 });
  });

  it("without FFmpeg the cut waits — no attempt spent, the sentence says why", async () => {
    const b = await business();
    const sl = await b.shotList();
    await storeClipDirect({
      profileId: b.profile_id,
      itemId: sl.id,
      name: "a.mp4",
      contentType: "video/mp4",
      body: new Uint8Array([...MP4_HEAD, 9]),
      store: memoryMediaStore(),
    });
    const r = await requestRender({
      profileId: b.profile_id,
      itemId: sl.id,
      userId: b.user_id,
      caption: "Soup season.",
    });
    const out = await runRender(r.id, { ffmpeg: () => false });
    expect(out).toMatchObject({ status: "waiting", note: WAITING_FOR_FFMPEG });
    const [row] = await db.select().from(footageRenders).where(eq(footageRenders.id, r.id));
    expect(row).toMatchObject({ status: "queued", attempts: 0, note: WAITING_FOR_FFMPEG });
  });
});

describe.skipIf(!ffmpegAvailable())("P3-52 — end to end through the cutting room", () => {
  it("two clips (one silent) → a 9:16 video item, disclosed, proposed for Instagram; clips released", async () => {
    const b = await business();
    const sl = await b.shotList();
    const store = memoryMediaStore();
    const a = path.join(TMP, "a.mp4");
    const silent = path.join(TMP, "silent.mp4");
    await makeTestClip(a, 3);
    await fs.mkdir(TMP, { recursive: true });
    await run((await import("ffmpeg-static")).default as unknown as string, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=25:duration=2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      silent,
    ]);
    const clipIds: string[] = [];
    for (const [file, name] of [
      [a, "IMG_1.mp4"],
      [silent, "IMG_2.mp4"],
    ] as const) {
      const clip = await storeClipDirect({
        profileId: b.profile_id,
        itemId: sl.id,
        name,
        contentType: "video/mp4",
        body: new Uint8Array(await fs.readFile(file)),
        store,
      });
      clipIds.push(clip.id);
    }
    const r = await requestRender({
      profileId: b.profile_id,
      itemId: sl.id,
      userId: b.user_id,
      caption: "Soup season is here.",
      onScreen: "New: autumn soups",
    });
    const out = await runRender(r.id, { store, limitLlm: limitsLlm });
    expect(out.status).toBe("rendered");

    const [video] = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, out.item_id as string));
    expect(video).toMatchObject({
      kind: "video",
      status: "drafted",
      channel_label: "instagram",
      scheduled_for: sl.scheduled_for,
      title: "Autumn menu — video",
      disclosure: disclosureLabel("video"),
    });
    expect(video!.body).toBe(`Soup season is here.\n\n${disclosureLabel("video")}`);
    expect(mediaOf(video!.provenance)).toMatchObject({
      origin: "footage",
      source_item_id: sl.id,
      is_ai_generated: false,
    });
    // The render is in the store at an unguessable path, and it IS the real cut.
    expect(video!.media_path).toMatch(
      new RegExp(
        `^https://blob\\.test\\.invalid/renders/${b.profile_id}/${video!.id}/[0-9a-f]{32}\\.mp4$`,
      ),
    );
    const rendered = path.join(TMP, "out.mp4");
    await fs.writeFile(rendered, store.read(video!.media_path as string)!);
    const { stdout } = await run(ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height:format=duration:format_tags=comment",
      "-print_format",
      "json",
      rendered,
    ]);
    const probe = JSON.parse(stdout) as {
      streams: { width?: number; height?: number }[];
      format: { duration: string; tags?: { comment?: string } };
    };
    expect(probe.streams.find((s) => s.width)).toMatchObject({ width: 1080, height: 1920 });
    expect(Number(probe.format.duration)).toBeGreaterThan(4.5);
    expect(probe.format.tags?.comment).toBe(disclosureLabel("video"));

    // The publish proposal (P3-21a) — the owner's next yes.
    expect(video!.publish_proposal_id).not.toBeNull();
    const [pp] = await db
      .select()
      .from(proposals)
      .where(eq(proposals.id, video!.publish_proposal_id as string));
    expect(pp?.action).toMatchObject({
      kind: "content_publishing",
      detail: {
        item_id: video!.id,
        platform: "instagram",
        target: { ig_user_id: "17800000000000001" },
      },
    });

    // The clips' bytes are gone; their rows stay as the record.
    const clips = await db.select().from(footageClips).where(inArray(footageClips.id, clipIds));
    expect(clips.every((c) => c.status === "released")).toBe(true);
    expect(clips.every((c) => store.read(c.url as string) === null)).toBe(true);
    const [row] = await db.select().from(footageRenders).where(eq(footageRenders.id, r.id));
    expect(row).toMatchObject({ status: "rendered", attempts: 1, result_item_id: video!.id });
    expect(row!.metrics).toMatchObject({ segments: 2, output_s: 5 });

    // Nothing left for the sweep to do for this one.
    const sweep = await sweepRenders({ store });
    expect(sweep.ran.find((x) => x.render_id === r.id)).toBeUndefined();
  }, 120_000);

  it("footage that can't be read fails by name, without retrying", async () => {
    const b = await business();
    const sl = await b.shotList();
    const store = memoryMediaStore();
    await storeClipDirect({
      profileId: b.profile_id,
      itemId: sl.id,
      name: "broken.mp4",
      contentType: "video/mp4",
      body: new Uint8Array([...MP4_HEAD, 0, 0, 0, 0]),
      store,
    });
    const r = await requestRender({
      profileId: b.profile_id,
      itemId: sl.id,
      userId: b.user_id,
      caption: "x",
    });
    const out = await runRender(r.id, { store });
    expect(out.status).toBe("failed");
    expect(out.note).toMatch(/broken\.mp4/);
  }, 60_000);
});

describe("Session K — real footage wins", () => {
  it("an approved generated version is never published once footage for it exists", async () => {
    const b = await business();
    const sl = await b.shotList();
    const store = memoryMediaStore();
    const file = path.join(TMP, "placeholder.jpg");
    await fs.mkdir(TMP, { recursive: true });
    await fs.writeFile(file, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 1, 2, 3]));
    const generated = await placeMedia({
      target: sl,
      file,
      source: {
        kind: "generated",
        media: "image",
        generation_id: crypto.randomUUID(),
        proposal_id: crypto.randomUUID(),
        provider: "fake",
        model: "fake-image-1",
        cost: { amount_minor: 4, currency: "EUR" },
        prompt_sha256: "x",
      },
      caption: "Soup season.",
      store,
      limitLlm: limitsLlm,
    });
    expect(generated.item.disclosure).toBe(mediaDisclosureLabel("video", "generated_image"));
    expect(generated.item.body.endsWith("AI-generated image. Not a real photo.")).toBe(true);
    // Approved (the queue's yes), then the owner's footage arrives.
    await db
      .update(contentItems)
      .set({ status: "queued" })
      .where(eq(contentItems.id, generated.item.id));
    const mp4 = path.join(TMP, "footage.mp4");
    await fs.writeFile(mp4, new Uint8Array([...MP4_HEAD, 1]));
    const footage = await placeMedia({
      target: sl,
      file: mp4,
      source: {
        kind: "footage",
        render_id: crypto.randomUUID(),
        clips: 1,
        metrics: { duration_ms: 1, bytes: 13, output_s: 3, segments: 1 },
      },
      caption: "Soup season, filmed.",
      store,
      limitLlm: limitsLlm,
    });
    expect(footage.created).toBe(true); // the approved one is left as it is
    expect(await supersededByFootage(generated.item)).toBe(true);
    expect(await supersededByFootage(footage.item)).toBe(false);

    const [pp] = await db
      .select()
      .from(proposals)
      .where(eq(proposals.id, generated.item.publish_proposal_id as string));
    const routed = await publishPlan(pp!);
    expect(routed).toEqual({
      unroutable: "your own footage for this replaced the generated version, so it isn't published",
    });
  });

  it("footage replaces generated media IN PLACE on a draft, and the label stops saying generated", async () => {
    const b = await business();
    const sl = await b.shotList();
    const store = memoryMediaStore();
    await fs.mkdir(TMP, { recursive: true });
    const jpg = path.join(TMP, "g.jpg");
    await fs.writeFile(jpg, new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1]));
    const g = await placeMedia({
      target: sl,
      file: jpg,
      source: {
        kind: "generated",
        media: "image",
        generation_id: crypto.randomUUID(),
        proposal_id: crypto.randomUUID(),
        provider: "fake",
        model: "m",
        cost: { amount_minor: 4, currency: "EUR" },
        prompt_sha256: "x",
      },
      caption: "Soup.",
      store,
      limitLlm: limitsLlm,
    });
    const mp4 = path.join(TMP, "f.mp4");
    await fs.writeFile(mp4, new Uint8Array([...MP4_HEAD, 2]));
    const f = await placeMedia({
      target: sl,
      file: mp4,
      source: {
        kind: "footage",
        render_id: crypto.randomUUID(),
        clips: 1,
        metrics: { duration_ms: 1, bytes: 13, output_s: 3, segments: 1 },
      },
      store,
      limitLlm: limitsLlm,
    });
    expect(f.created).toBe(false);
    expect(f.item.id).toBe(g.item.id);
    expect(f.item.disclosure).toBe(disclosureLabel("video"));
    expect(f.item.body).toBe(`Soup.\n\n${disclosureLabel("video")}`);
    expect(f.item.media_path).toMatch(/\.mp4$/);
    expect(store.read(g.item.media_path as string)).toBeNull(); // the generated file left storage
    const prov = f.item.provenance as { previous_media?: { origin: string }[] };
    expect(prov.previous_media?.[0]?.origin).toBe("generated_image");
  });
});
