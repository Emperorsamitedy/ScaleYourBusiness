// P3-53 — the AI fallback for media. What must hold: generation is off
// unless switched on, and the vendor slot says it isn't chosen; a real
// person's likeness or a named brand is refused by rule before anything
// is proposed; the proposal states its cost and caps and generates
// nothing; only an approved proposal generates, once; every attempt's
// charge is recorded in minor units with its currency, the attempts and
// the per-item and monthly caps are hard; the output is labelled as
// GENERATED in the file, the caption and the provenance; Instagram's
// container flag and Facebook's caption check both pass for it; and real
// footage always comes first.

import "dotenv/config";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  channels,
  competitors,
  connections,
  contentItems,
  fieldRecords,
  footageClips,
  intakeEvents,
  mediaGenerations,
  proposals,
  users,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { mediaProviderSetting } from "../env";
import { connectForExecution, expectedExecutionScopes } from "../execution/connections";
import { disclosureViolation, publishCaption } from "../execution/providers/meta";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal, createProposal } from "../proposals/service";
import {
  disclosureLabel,
  isDisclosed,
  isGeneratedLabel,
  mediaDisclosureLabel,
  relabel,
} from "./disclosure";
import { ffmpegAvailable } from "./edit";
import { FAKE_PRICES, fakeMediaProvider } from "./generate/fake";
import type { FakeOptions } from "./generate/fake";
import { screenPrompt } from "./generate/guard";
import { DIGITAL_SOURCE_TYPE, readJpegLabels, readVideoComment, stampJpeg } from "./generate/label";
import { FIXED_INSTRUCTION } from "./generate/provider";
import type { GenerationRequest } from "./generate/provider";
import { VENDOR_NOT_CHOSEN } from "./generate/vendor";
import {
  GENERATION_KIND,
  GENERATION_OFF,
  ITEM_CAP_MINOR,
  MAX_GENERATION_ATTEMPTS,
  MONTHLY_CAP_MINOR,
  buildPrompt,
  capRefusal,
  generateFromProposal,
  generationSetup,
  monthStart,
  proposeGeneration,
} from "./generation";
import type { GenerationSetup } from "./generation";
import { memoryMediaStore } from "./media";
import { mediaOf } from "./media-item";

const limitsLlm: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });
const fake = (opts: FakeOptions = {}): GenerationSetup => ({
  provider: fakeMediaProvider(opts),
  reason: null,
  setting: "fake",
});

describe("P3-53 — the switch", () => {
  const saved = { p: process.env.MEDIA_PROVIDER, n: process.env.NODE_ENV };
  afterEach(() => {
    process.env.MEDIA_PROVIDER = saved.p;
    (process.env as Record<string, string | undefined>).NODE_ENV = saved.n;
  });

  it("defaults to off; fake is refused in production; the vendor slot says it isn't chosen", () => {
    delete process.env.MEDIA_PROVIDER;
    expect(mediaProviderSetting()).toBe("off");
    process.env.MEDIA_PROVIDER = "something-else";
    expect(mediaProviderSetting()).toBe("off");
    process.env.MEDIA_PROVIDER = "fake";
    expect(mediaProviderSetting()).toBe("fake");
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(mediaProviderSetting()).toBe("off");

    expect(generationSetup("off")).toMatchObject({ provider: null, reason: GENERATION_OFF });
    expect(generationSetup("vendor")).toMatchObject({ provider: null, reason: VENDOR_NOT_CHOSEN });
    expect(generationSetup("fake").provider?.id).toBe("fake");
  });
});

describe("P3-53 — the likeness and brand screen", () => {
  it("refuses a real person's likeness, by rule", () => {
    for (const prompt of [
      "a celebrity eating our soup",
      "someone who looks like Taylor Swift holding a bowl",
      "a portrait of Anna Kovacs at the counter",
      "President Biden tasting the menu",
      "tag @realchef in the video",
      "our staff smiling behind the bar",
      "a deepfake of the mayor",
      "a selfie at the shop",
    ]) {
      expect(screenPrompt(prompt)).toMatchObject({ ok: false });
    }
  });

  it("refuses logos and named brands, the owner's competitors included", () => {
    expect(screenPrompt("our soup next to a Nike shoe")).toMatchObject({
      ok: false,
      matched: "Nike",
    });
    expect(screenPrompt("a cup with the Starbucks look")).toMatchObject({ ok: false });
    expect(screenPrompt("put a logo on the bowl")).toMatchObject({ ok: false });
    expect(screenPrompt("soup™ in a bowl")).toMatchObject({ ok: false });
    expect(screenPrompt("better than Goulash Garden's soup", ["Goulash Garden"])).toMatchObject({
      ok: false,
      reason: "it names one of your competitors",
    });
  });

  it("lets ordinary product imagery through — the platforms' names included", () => {
    expect(screenPrompt("A steaming bowl of pumpkin soup on a rustic table, autumn light")).toEqual(
      {
        ok: true,
      },
    );
    expect(screenPrompt("New soups this week — follow us on Instagram")).toEqual({ ok: true });
  });

  it("the fixed instruction says the same, every time", () => {
    expect(FIXED_INSTRUCTION).toMatch(/real, identifiable person/);
    expect(FIXED_INSTRUCTION).toMatch(/logo/);
  });
});

describe("P3-53 — the prompt and the label, pure", () => {
  it("builds from the item's words, never the shot-list template; direction and brief add to it", () => {
    const post = {
      kind: "post" as const,
      title: "Autumn menu — instagram",
      body: "Soup season is here #soup https://x.test/a\n\nWritten with AI assistance.",
      provenance: {},
    };
    const p = buildPrompt({ item: post, media: "image" });
    expect(p).toBe(
      "A single still image, 4:5 portrait, for a social media post. Subject: Soup season is here.",
    );
    const shot = {
      kind: "shot_list" as const,
      title: "Film for instagram — Autumn menu",
      body: "You, to camera, one sentence…\n\nShot list prepared with AI assistance.",
      provenance: { item: { focus: "Autumn menu", brief: "the new soups" } },
    };
    const v = buildPrompt({
      item: shot,
      media: "video",
      brief: { hook: "Three soups, one week", script: "Close on the steam." },
    });
    expect(v).toContain("Subject: Autumn menu. the new soups.");
    expect(v).toContain("Hook: Three soups, one week.");
    expect(v).toContain("Script: Close on the steam.");
    expect(v).not.toContain("to camera");
    expect(
      buildPrompt({ item: post, media: "image", direction: "a bowl of soup, top down" }),
    ).toContain("Subject: a bowl of soup, top down.");
  });

  it("labels as GENERATED — stronger than AI-assisted — and relabels cleanly", () => {
    const image = mediaDisclosureLabel("post", "generated_image");
    expect(image).toBe("Written with AI assistance. AI-generated image. Not a real photo.");
    expect(mediaDisclosureLabel("video", "generated_video")).toBe(
      "AI-generated video. Not real footage.",
    );
    expect(mediaDisclosureLabel("video", "footage")).toBe(disclosureLabel("video"));
    expect(isGeneratedLabel(image)).toBe(true);
    expect(isGeneratedLabel(disclosureLabel("video"))).toBe(false);
    const once = relabel("Soup.\n\nWritten with AI assistance.", image);
    expect(once).toBe(`Soup.\n\n${image}`);
    expect(relabel(once, image)).toBe(once);
    expect(relabel(once, disclosureLabel("post"))).toBe("Soup.\n\nWritten with AI assistance.");
    expect(isDisclosed(once)).toBe(true);
  });

  it("stamps the JPEG with IPTC 'trainedAlgorithmicMedia' and the label, and reads it back", async () => {
    const out = await fakeMediaProvider().generate({
      media: "image",
      prompt: "p",
      instruction: FIXED_INSTRUCTION,
      aspect: "4:5",
      account_id: "a",
    });
    expect(readJpegLabels(out.bytes).generated).toBe(false);
    const stamped = stampJpeg(out.bytes, "AI-generated image. Not a real photo.");
    const read = readJpegLabels(stamped);
    expect(read.generated).toBe(true);
    expect(read.comments).toContain("AI-generated image. Not a real photo.");
    expect(new TextDecoder().decode(stamped)).toContain(DIGITAL_SOURCE_TYPE);
    expect(() => stampJpeg(new Uint8Array([1, 2, 3, 4]), "x")).toThrow(/isn't a JPEG/);
  });

  it("the caps are arithmetic, in one currency", () => {
    const eur = (n: number) => ({ amount_minor: n, currency: "EUR" });
    const room = (item: number, month: number) => ({
      item_spent: eur(item),
      month_spent: eur(month),
      item_cap: eur(ITEM_CAP_MINOR),
      month_cap: eur(MONTHLY_CAP_MINOR),
    });
    expect(capRefusal(room(0, 0), eur(4))).toBeNull();
    expect(capRefusal(room(ITEM_CAP_MINOR - 3, 0), eur(4))).toMatch(
      /this item past its €2\.00 cap/,
    );
    expect(capRefusal(room(0, MONTHLY_CAP_MINOR - 3), eur(4))).toMatch(
      /this month past its €10\.00 cap/,
    );
    expect(capRefusal(room(0, 0), { amount_minor: 4, currency: "USD" })).toMatch(/doesn't convert/);
    expect(monthStart(new Date("2026-10-26T15:00:00Z")).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("the Meta publish path's own rule-17 checks pass for a generated caption", () => {
    const label = mediaDisclosureLabel("post", "generated_image");
    const caption = publishCaption({ body: relabel("Soup.", label), disclosure: label });
    expect(disclosureViolation("page_photos", { message: caption })).toBeNull();
    // Instagram: the executor sets is_ai_generated on every container; without it, nothing is sent.
    expect(disclosureViolation("ig_container", { caption })).toBe("ig_container");
    expect(disclosureViolation("ig_container", { caption, is_ai_generated: "true" })).toBeNull();
  });
});

/* ── against the database ── */

const created: { account_id: string; profile_id: string }[] = [];
const TMP = path.join(os.tmpdir(), "syb-generation-test");

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length > 0) {
    await db.delete(mediaGenerations).where(inArray(mediaGenerations.profile_id, ids));
    await db.delete(footageClips).where(inArray(footageClips.profile_id, ids));
    await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(channels).where(inArray(channels.profile_id, ids));
    await db.delete(competitors).where(inArray(competitors.profile_id, ids));
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
      access_token: "EAAgenerateTest",
      page_id: "1000000001",
      ig_user_id: "17800000000000001",
    }),
    verify: async () => ({ granted_scopes: expectedExecutionScopes("meta_publish") }),
  });
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-53-${crypto.randomUUID()}@test.local`,
      display_name: "P3-53 owner",
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
  const item = async (kind: "post" | "shot_list", body = "Soup season is here.") => {
    const label =
      kind === "post" ? "Written with AI assistance." : "Shot list prepared with AI assistance.";
    const [row] = await db
      .insert(contentItems)
      .values({
        profile_id: s.profile_id,
        proposal_id: plan.id,
        kind,
        channel_label: "instagram",
        scheduled_for: inDays(10),
        title: kind === "post" ? "Autumn menu — instagram" : "Film for instagram — Autumn menu",
        body: `${body}\n\n${label}`,
        disclosure: label,
        provenance: {
          item: { channel_id: ch!.id, focus: "Autumn menu", brief: "the new soups" },
          evidence: [`channels.${ch!.id}.type`],
        },
      })
      .returning();
    return row!;
  };
  const approve = (proposalId: string) =>
    approveProposal({ proposalId, userId: u!.id, profileId: s.profile_id });
  return { ...s, user_id: u!.id, item, approve };
}

describe("P3-53 — proposing", () => {
  it("off: nothing is proposed, and the refusal says generation isn't set up", async () => {
    const b = await business();
    const post = await b.item("post");
    await expect(
      proposeGeneration({
        profileId: b.profile_id,
        itemId: post.id,
        media: "image",
        setup: generationSetup("off"),
        limitLlm: limitsLlm,
      }),
    ).rejects.toMatchObject({ status: 503, message: GENERATION_OFF });
    const rows = await db.select().from(proposals).where(eq(proposals.profile_id, b.profile_id));
    expect(
      rows.filter((r) => (r.action as { kind?: string }).kind === GENERATION_KIND),
    ).toHaveLength(0);
  });

  it("a proposal states its cost, caps and prompt, and generates nothing", async () => {
    const b = await business();
    const post = await b.item("post");
    const p = await proposeGeneration({
      profileId: b.profile_id,
      itemId: post.id,
      media: "image",
      setup: fake(),
      limitLlm: limitsLlm,
    });
    expect(p).toMatchObject({
      status: "pending",
      module: "content",
      originating_finding: `generate:${post.id}`,
    });
    expect(p.action).toMatchObject({
      kind: GENERATION_KIND,
      summary: expect.stringContaining("about €0.04"),
      detail: {
        target_item_id: post.id,
        media: "image",
        provider: "fake",
        instruction: FIXED_INSTRUCTION,
        estimate: { amount_minor: FAKE_PRICES.image, currency: "EUR" },
        caps: {
          item: { amount_minor: ITEM_CAP_MINOR, currency: "EUR" },
          max_attempts: MAX_GENERATION_ATTEMPTS,
        },
        label: mediaDisclosureLabel("post", "generated_image"),
      },
    });
    expect(
      await db.select().from(mediaGenerations).where(eq(mediaGenerations.proposal_id, p.id)),
    ).toHaveLength(0);
    // Not twice while it waits.
    await expect(
      proposeGeneration({
        profileId: b.profile_id,
        itemId: post.id,
        media: "image",
        setup: fake(),
        limitLlm: limitsLlm,
      }),
    ).rejects.toMatchObject({ status: 409 });
    // Only an approved one generates.
    await expect(
      generateFromProposal({
        proposalId: p.id,
        expectedProfileId: b.profile_id,
        setup: fake(),
        store: memoryMediaStore(),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a competitor by name, and refuses when the owner's footage exists", async () => {
    const b = await business();
    const [c] = await db
      .insert(competitors)
      .values({ profile_id: b.profile_id, source: { kind: "owner_input" } })
      .returning();
    await owner(b.profile_id, `competitors.${c!.id}.name`, "Goulash Garden");
    const post = await b.item("post", "Better soup than Goulash Garden, honestly.");
    await expect(
      proposeGeneration({
        profileId: b.profile_id,
        itemId: post.id,
        media: "image",
        setup: fake(),
        limitLlm: limitsLlm,
      }),
    ).rejects.toThrow(/one of your competitors \("Goulash Garden"\)/);

    const sl = await b.item("shot_list");
    await db.insert(footageClips).values({
      profile_id: b.profile_id,
      item_id: sl.id,
      status: "uploaded",
      store: "memory",
      pathname: `renders/${b.profile_id}/${sl.id}/clip-${"a".repeat(32)}.mp4`,
      url: `https://blob.test.invalid/renders/${b.profile_id}/${sl.id}/clip-${"a".repeat(32)}.mp4`,
      content_type: "video/mp4",
      declared_bytes: 10,
      bytes: 10,
      label: "a.mp4",
    });
    await expect(
      proposeGeneration({
        profileId: b.profile_id,
        itemId: sl.id,
        media: "video",
        setup: fake(),
        limitLlm: limitsLlm,
      }),
    ).rejects.toThrow(/uploaded clips/);
  });

  it("the monthly and per-item caps refuse before anything is proposed", async () => {
    const b = await business();
    const post = await b.item("post");
    const other = await b.item("post", "Another soup.");
    const ledger = async (target: string, cost: number) => {
      const p = await createProposal({
        profile_id: b.profile_id,
        module: "content",
        action: { kind: GENERATION_KIND, summary: "earlier", detail: {} },
        scenario: {} as never,
        reversibility: { level: "moderate", if_you_change_your_mind: "x" },
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await db.insert(mediaGenerations).values({
        profile_id: b.profile_id,
        account_id: b.account_id,
        proposal_id: p.id,
        target_item_id: target,
        media: "image",
        provider: "fake",
        status: "generated",
        attempts: 1,
        estimate_minor: cost,
        cost_minor: cost,
        currency: "EUR",
        prompt_sha256: "x",
      });
    };
    await ledger(post.id, ITEM_CAP_MINOR - 2);
    await expect(
      proposeGeneration({
        profileId: b.profile_id,
        itemId: post.id,
        media: "image",
        setup: fake(),
        limitLlm: limitsLlm,
      }),
    ).rejects.toThrow(/this item past its €2\.00 cap/);
    await ledger(other.id, MONTHLY_CAP_MINOR - ITEM_CAP_MINOR);
    const third = await b.item("post", "A third soup.");
    await expect(
      proposeGeneration({
        profileId: b.profile_id,
        itemId: third.id,
        media: "image",
        setup: fake(),
        limitLlm: limitsLlm,
      }),
    ).rejects.toThrow(/this month past its €10\.00 cap/);
  });
});

describe("P3-53 — generating, once approved", () => {
  it("an image for a post: charged once, labelled in the file, the caption and the record, then proposed", async () => {
    const b = await business();
    const post = await b.item("post");
    const sent: GenerationRequest[] = [];
    const p = await proposeGeneration({
      profileId: b.profile_id,
      itemId: post.id,
      media: "image",
      setup: fake({ sent }),
      limitLlm: limitsLlm,
    });
    await b.approve(p.id);
    const store = memoryMediaStore();
    const out = await generateFromProposal({
      proposalId: p.id,
      expectedProfileId: b.profile_id,
      setup: fake({ sent }),
      store,
      limitLlm: limitsLlm,
    });
    expect(out).toMatchObject({
      status: "generated",
      item_id: post.id,
      cost: { amount_minor: 4, currency: "EUR" },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      media: "image",
      instruction: FIXED_INSTRUCTION,
      aspect: "4:5",
    });

    const [item] = await db.select().from(contentItems).where(eq(contentItems.id, post.id));
    const label = mediaDisclosureLabel("post", "generated_image");
    expect(item!.disclosure).toBe(label);
    expect(item!.body).toBe(`Soup season is here.\n\n${label}`);
    expect(mediaOf(item!.provenance)).toMatchObject({
      origin: "generated_image",
      is_ai_generated: true,
      label,
    });
    expect((item!.provenance as { ai_generated?: boolean }).ai_generated).toBe(true);
    expect(item!.media_path).toMatch(/\.jpg$/);
    const bytes = store.read(item!.media_path as string)!;
    expect(readJpegLabels(bytes)).toMatchObject({
      generated: true,
      comments: expect.arrayContaining([label]),
    });
    // Same publish proposal and approval as real footage.
    expect(item!.publish_proposal_id).not.toBeNull();

    const [gen] = await db
      .select()
      .from(mediaGenerations)
      .where(eq(mediaGenerations.proposal_id, p.id));
    expect(gen).toMatchObject({
      status: "generated",
      attempts: 1,
      cost_minor: 4,
      currency: "EUR",
      result_item_id: post.id,
    });
    const [after] = await db.select().from(proposals).where(eq(proposals.id, p.id));
    expect(after?.status).toBe("executed");
    // Once, ever.
    await expect(
      generateFromProposal({
        proposalId: p.id,
        expectedProfileId: b.profile_id,
        setup: fake(),
        store,
      }),
    ).rejects.toMatchObject({ status: 409 });
    // A foreign profile can't reach it.
    await expect(
      generateFromProposal({
        proposalId: p.id,
        expectedProfileId: crypto.randomUUID(),
        setup: fake(),
        store,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("retries to the hard cap, records every charge, and closes honestly when it fails", async () => {
    const b = await business();
    const ok = await b.item("post");
    const p1 = await proposeGeneration({
      profileId: b.profile_id,
      itemId: ok.id,
      media: "image",
      setup: fake(),
      limitLlm: limitsLlm,
    });
    await b.approve(p1.id);
    const once = await generateFromProposal({
      proposalId: p1.id,
      setup: fake({ failures: 1, chargeFailures: true }),
      store: memoryMediaStore(),
      limitLlm: limitsLlm,
    });
    expect(once).toMatchObject({ status: "generated", cost: { amount_minor: 8 } });
    const [g1] = await db
      .select()
      .from(mediaGenerations)
      .where(eq(mediaGenerations.proposal_id, p1.id));
    expect(g1).toMatchObject({ attempts: 2, cost_minor: 8 });

    const bad = await b.item("post", "Another soup.");
    const p2 = await proposeGeneration({
      profileId: b.profile_id,
      itemId: bad.id,
      media: "image",
      setup: fake(),
      limitLlm: limitsLlm,
    });
    await b.approve(p2.id);
    const sent: GenerationRequest[] = [];
    const failed = await generateFromProposal({
      proposalId: p2.id,
      setup: fake({ failures: 5, chargeFailures: true, sent }),
      store: memoryMediaStore(),
    });
    expect(sent).toHaveLength(MAX_GENERATION_ATTEMPTS);
    expect(failed).toMatchObject({ status: "failed", cost: { amount_minor: 8, currency: "EUR" } });
    expect(failed.note).toMatch(/€0\.08 was charged/);
    const [g2] = await db
      .select()
      .from(mediaGenerations)
      .where(eq(mediaGenerations.proposal_id, p2.id));
    expect(g2).toMatchObject({ status: "failed", attempts: 2, cost_minor: 8 });
    const [pr] = await db.select().from(proposals).where(eq(proposals.id, p2.id));
    expect(pr).toMatchObject({ status: "executed", execution_result: { generated: false } });
    const [still] = await db.select().from(contentItems).where(eq(contentItems.id, bad.id));
    expect(still!.media_path).toBeNull();

    // A non-retryable failure stops at once.
    const third = await b.item("post", "Third soup.");
    const p3 = await proposeGeneration({
      profileId: b.profile_id,
      itemId: third.id,
      media: "image",
      setup: fake(),
      limitLlm: limitsLlm,
    });
    await b.approve(p3.id);
    const sent3: GenerationRequest[] = [];
    await generateFromProposal({
      proposalId: p3.id,
      setup: fake({ failures: 5, retryable: false, sent: sent3 }),
      store: memoryMediaStore(),
    });
    expect(sent3).toHaveLength(1);
  });

  it("footage that arrived while it waited wins: nothing generated, nothing charged", async () => {
    const b = await business();
    const sl = await b.item("shot_list");
    const p = await proposeGeneration({
      profileId: b.profile_id,
      itemId: sl.id,
      media: "image",
      setup: fake(),
      limitLlm: limitsLlm,
    });
    await b.approve(p.id);
    await db.insert(footageClips).values({
      profile_id: b.profile_id,
      item_id: sl.id,
      status: "uploaded",
      store: "memory",
      pathname: `renders/${b.profile_id}/${sl.id}/clip-${"b".repeat(32)}.mp4`,
      url: `https://blob.test.invalid/renders/${b.profile_id}/${sl.id}/clip-${"b".repeat(32)}.mp4`,
      content_type: "video/mp4",
      declared_bytes: 10,
      bytes: 10,
      label: "b.mp4",
    });
    const sent: GenerationRequest[] = [];
    const out = await generateFromProposal({
      proposalId: p.id,
      setup: fake({ sent }),
      store: memoryMediaStore(),
    });
    expect(out).toMatchObject({ status: "not_needed", cost: { amount_minor: 0 } });
    expect(sent).toHaveLength(0);
    expect(
      await db.select().from(mediaGenerations).where(eq(mediaGenerations.proposal_id, p.id)),
    ).toHaveLength(0);
  });

  it.skipIf(!ffmpegAvailable())(
    "a clip for a shot list: a video item, the label in the container, Reels-ready",
    async () => {
      const b = await business();
      const sl = await b.item("shot_list");
      const p = await proposeGeneration({
        profileId: b.profile_id,
        itemId: sl.id,
        media: "video",
        setup: fake(),
        limitLlm: limitsLlm,
      });
      expect(
        (p.action as { detail: { estimate: { amount_minor: number } } }).detail.estimate
          .amount_minor,
      ).toBe(50);
      await b.approve(p.id);
      const store = memoryMediaStore();
      const out = await generateFromProposal({
        proposalId: p.id,
        setup: fake(),
        store,
        limitLlm: limitsLlm,
      });
      expect(out.status).toBe("generated");
      const [video] = await db
        .select()
        .from(contentItems)
        .where(eq(contentItems.id, out.item_id as string));
      const label = mediaDisclosureLabel("video", "generated_video");
      expect(video).toMatchObject({
        kind: "video",
        disclosure: label,
        title: "Autumn menu — video",
      });
      expect(mediaOf(video!.provenance)).toMatchObject({
        origin: "generated_video",
        source_item_id: sl.id,
      });
      await fs.mkdir(TMP, { recursive: true });
      const file = path.join(TMP, "g.mp4");
      await fs.writeFile(file, store.read(video!.media_path as string)!);
      expect(await readVideoComment(file)).toBe(label);
    },
    60_000,
  );
});
