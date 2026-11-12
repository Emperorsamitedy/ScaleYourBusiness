// The growth engine — the v1 build spec §10.6's acceptance criteria and the
// Phase 7 gate: a brief without evidence fails generation; nothing
// publishes unlabelled; publishing needs station 3 and ad promotion 4; the
// first three pieces wait for a yes even at 4; the brand voice is readable,
// editable words; a real person never renders without an identity release.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  assetUsages,
  brandVoiceProfiles,
  businessProfiles,
  capabilityCaps,
  capabilityStations,
  contentItems,
  creativeBriefs,
  figures,
  identityReleases,
  intakeEvents,
  labellingRecords,
  libraryAssets,
  mediaGenerations,
  proposals,
} from "../../db/schema";
import { recordFigure } from "../figures/figure";
import { bootstrapIntake } from "../intake/service";
import { setCaps } from "../ladder/caps";
import { setStationUnchecked } from "../ladder/ladder";
import { withinLimits } from "../ladder/limits";
import { createProposal } from "../proposals/service";
import {
  BriefError,
  NO_EVIDENCE,
  canPromoteToAd,
  canPublish,
  citeEvidence,
  detectOpportunities,
  openBrief,
  requireGenerationBrief,
} from "./brief";
import {
  addAsset,
  buildVoice,
  confirmVoice,
  currentVoice,
  editVoice,
  libraryOf,
  markLabellingPublished,
  recordLabelling,
  recordRelease,
  revokeRelease,
  runningLow,
  useAsset,
  voiceWords,
} from "./library";

const created: { account_id: string; profile_id: string }[] = [];
afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length === 0) return;
  await db.delete(labellingRecords).where(inArray(labellingRecords.profile_id, ids));
  await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
  await db.delete(mediaGenerations).where(inArray(mediaGenerations.profile_id, ids));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  const assets = await db
    .select({ id: libraryAssets.id })
    .from(libraryAssets)
    .where(inArray(libraryAssets.profile_id, ids));
  if (assets.length)
    await db.delete(assetUsages).where(
      inArray(
        assetUsages.asset_id,
        assets.map((a) => a.id),
      ),
    );
  await db.delete(libraryAssets).where(inArray(libraryAssets.profile_id, ids));
  await db.delete(identityReleases).where(inArray(identityReleases.profile_id, ids));
  await db.delete(creativeBriefs).where(inArray(creativeBriefs.profile_id, ids));
  await db.delete(brandVoiceProfiles).where(inArray(brandVoiceProfiles.profile_id, ids));
  await db.delete(figures).where(inArray(figures.profile_id, ids));
  await db.delete(capabilityCaps).where(inArray(capabilityCaps.profile_id, ids));
  await db.delete(capabilityStations).where(inArray(capabilityStations.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(
    inArray(
      accounts.id,
      created.map((s) => s.account_id),
    ),
  );
});

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

const figure = (profileId: string, key = "margin.best_seller") =>
  recordFigure({
    profileId,
    key,
    value: 4_200,
    source_detail: "test",
    captured_at: new Date().toISOString(),
    provenance: { source: "measured" },
  });

const dbError = (q: Promise<unknown>) =>
  q.then(
    () => "no error",
    (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? e),
  );

describe("§10.6 — a brief without evidence fails generation", () => {
  it("opens only with figures; cites only its own business's; a generation naming an evidence-less brief is refused by the database", async () => {
    const s = await business();
    const other = await business();
    await expect(
      openBrief({
        profileId: s.profile_id,
        trigger: "slow_stock",
        evidence: [],
        subject: "Rye loaf",
        angle: "Clear the shelf",
      }),
    ).rejects.toThrow(NO_EVIDENCE);

    const theirs = await figure(other.profile_id);
    expect(
      await dbError(
        db.insert(creativeBriefs).values({
          profile_id: s.profile_id,
          campaign: "x",
          brief: {},
          sources: [],
          model: "test",
          attempts: 1,
          cost_eur: "0",
          evidence: [theirs.id],
        }),
      ),
    ).toMatch(/only this business's own figures/);

    // A brief written before §10, with no evidence: rendering it is refused, in code and in the database.
    const [bare] = await db
      .insert(creativeBriefs)
      .values({
        profile_id: s.profile_id,
        campaign: "x",
        brief: {},
        sources: [],
        model: "test",
        attempts: 1,
        cost_eur: "0",
      })
      .returning();
    await expect(requireGenerationBrief(s.profile_id, { brief_id: bare!.id })).rejects.toThrow(
      NO_EVIDENCE,
    );
    await expect(requireGenerationBrief(s.profile_id, {})).rejects.toBeInstanceOf(BriefError);
    const p = await createProposal({
      profile_id: s.profile_id,
      module: "content",
      action: { kind: "media_generation", summary: "x", detail: {} },
      scenario: {} as never,
      reversibility: { level: "moderate", if_you_change_your_mind: "x" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const generation = (briefId: string | null) =>
      db.insert(mediaGenerations).values({
        profile_id: s.profile_id,
        account_id: s.account_id,
        proposal_id: p.id,
        target_item_id: randomUUID(),
        creative_brief_id: briefId,
        media: "video",
        provider: "fake",
        estimate_minor: 1,
        currency: "EUR",
        prompt_sha256: "x",
      });
    expect(await dbError(generation(null))).toMatch(/does not generate|needs_brief|violates/);
    expect(await dbError(generation(bare!.id))).toMatch(/does not generate/);

    // Cite a figure, and the same brief may render (once the voice is confirmed).
    const mine = await figure(s.profile_id);
    await citeEvidence(s.profile_id, bare!.id, [mine.id]);
    await buildVoice(s.profile_id, {
      traits: [{ statement: "Warm.", source: "x" }],
      boundaries: [],
    });
    await expect(requireGenerationBrief(s.profile_id, { brief_id: bare!.id })).rejects.toThrow(
      /confirm/,
    );
    await confirmVoice(s.profile_id, randomUUID());
    expect(await requireGenerationBrief(s.profile_id, { brief_id: bare!.id })).toBe(bare!.id);
  });

  it("opportunity detection names the triggers the business's own figures support", async () => {
    const s = await business();
    const m = await figure(s.profile_id, "margin.best_seller");
    const st = await figure(s.profile_id, "stock.days_since_sale");
    const found = await detectOpportunities(s.profile_id);
    expect(found).toEqual(
      expect.arrayContaining([
        { trigger: "margin_opportunity", figure_ids: [m.id] },
        { trigger: "slow_stock", figure_ids: [st.id] },
      ]),
    );
    const brief = await openBrief({
      profileId: s.profile_id,
      trigger: "slow_stock",
      evidence: [st.id],
      subject: "Rye loaf",
      angle: "Forty loaves on the shelf",
      assetsRequired: [{ kind: "video", description: "the rye loaf being sliced", quantity: 3 }],
    });
    expect(brief.evidence).toEqual([st.id]);
  });
});

describe("§10.6 — a real person never renders without an identity release", () => {
  it("the brief's person, and every supplied asset with a person, need a live release", async () => {
    const s = await business();
    const f = await figure(s.profile_id);
    await buildVoice(s.profile_id, { traits: [], boundaries: [] });
    await confirmVoice(s.profile_id, randomUUID());
    const brief = await openBrief({
      profileId: s.profile_id,
      trigger: "margin_opportunity",
      evidence: [f.id],
      subject: "Anna's bread",
      angle: "Meet the baker",
      depictsRealPerson: true,
    });
    await expect(requireGenerationBrief(s.profile_id, { brief_id: brief.id })).rejects.toThrow(
      /identity release/,
    );
    const release = await recordRelease({
      profileId: s.profile_id,
      person: "Anna, our baker",
      evidenceRef: "release-2026-11-12.pdf",
      signedAt: new Date(),
    });
    expect(await requireGenerationBrief(s.profile_id, { brief_id: brief.id })).toBe(brief.id);
    await revokeRelease(s.profile_id, release.id);
    await expect(requireGenerationBrief(s.profile_id, { brief_id: brief.id })).rejects.toThrow(
      /identity release/,
    );

    // An asset showing a person, with no release, can be stored but not supplied to a render.
    const plain = await openBrief({
      profileId: s.profile_id,
      trigger: "margin_opportunity",
      evidence: [f.id],
      subject: "Bread",
      angle: "Crust",
    });
    const clip = await addAsset({
      profileId: s.profile_id,
      kind: "video",
      url: "https://blob.test/a.mp4",
      contentType: "video/mp4",
      description: "the counter at opening",
      shotBy: "the owner",
      personAppears: true,
    });
    await db
      .update(creativeBriefs)
      .set({ assets_supplied: [clip.id] })
      .where(eq(creativeBriefs.id, plain.id));
    await expect(requireGenerationBrief(s.profile_id, { brief_id: plain.id })).rejects.toThrow(
      /no identity release/,
    );
    await expect(
      addAsset({
        profileId: s.profile_id,
        kind: "photo",
        url: "x",
        contentType: "image/jpeg",
        description: "x",
        shotBy: " ",
        personAppears: false,
      }),
    ).rejects.toThrow(/who shot it/);
  });
});

describe("§10.6 — every rendered asset has a labelling record before it can be published", () => {
  it("the database refuses to queue a generated item without one; with one it goes, and the record says when it went out", async () => {
    const s = await business();
    const p = await createProposal({
      profile_id: s.profile_id,
      module: "content",
      action: { kind: "content_publishing", summary: "x", detail: { items: [] } },
      scenario: {} as never,
      reversibility: { level: "easy", if_you_change_your_mind: "x" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const url = `https://blob.test/${randomUUID()}.mp4`;
    const [item] = await db
      .insert(contentItems)
      .values({
        profile_id: s.profile_id,
        proposal_id: p.id,
        kind: "video",
        channel_label: "instagram",
        title: "x",
        body: "x\n\nAI-generated video.",
        disclosure: "AI-generated video.",
        media_path: url,
        provenance: { media: { origin: "generated_video", is_ai_generated: true } },
      })
      .returning();
    expect(
      await dbError(
        db.update(contentItems).set({ status: "queued" }).where(eq(contentItems.id, item!.id)),
      ),
    ).toMatch(/labelling record/);
    // Inserting it already queued is refused the same way.
    expect(
      await dbError(
        db.insert(contentItems).values({
          ...item!,
          id: randomUUID(),
          status: "published",
          media_path: `https://blob.test/${randomUUID()}.mp4`,
        }),
      ),
    ).toMatch(/labelling record/);

    await recordLabelling({
      profileId: s.profile_id,
      mediaUrl: url,
      label: "AI-generated video.",
      media: "video",
      contentItemId: item!.id,
    });
    await db.update(contentItems).set({ status: "queued" }).where(eq(contentItems.id, item!.id));
    await markLabellingPublished(item!.id, url, null);
    const [rec] = await db
      .select()
      .from(labellingRecords)
      .where(eq(labellingRecords.content_item_id, item!.id));
    expect(rec).toMatchObject({ method: "mp4_comment", label: "AI-generated video." });
    expect(rec!.standard_version).toMatch(/Art\. 50/);
    expect(rec!.published_at).not.toBeNull();
  });
});

describe("§10.6 — stations: publish at 3, promote to an ad at 4, and the first three pieces always wait", () => {
  it("publishing below 3 and ad promotion below 4 are refused; at 4 the first three still need a yes", async () => {
    const s = await business();
    await setStationUnchecked({
      profileId: s.profile_id,
      capability: "meta_publish",
      station: 2,
      by: null,
    });
    expect(await canPublish(s.profile_id, "meta_publish")).toBe(false);
    await setStationUnchecked({
      profileId: s.profile_id,
      capability: "meta_publish",
      station: 3,
      by: null,
    });
    expect(await canPublish(s.profile_id, "meta_publish")).toBe(true);
    await setStationUnchecked({
      profileId: s.profile_id,
      capability: "meta_ads",
      station: 3,
      by: null,
    });
    expect(await canPromoteToAd(s.profile_id)).toBe(false);
    await setStationUnchecked({
      profileId: s.profile_id,
      capability: "meta_ads",
      station: 4,
      by: null,
    });
    expect(await canPromoteToAd(s.profile_id)).toBe(true);

    await setStationUnchecked({
      profileId: s.profile_id,
      capability: "meta_publish",
      station: 4,
      by: null,
    });
    await setCaps({
      profileId: s.profile_id,
      capability: "meta_publish",
      caps: {
        currency: "EUR",
        max_daily_spend_delta_minor: null,
        max_single_action_minor: 0,
        max_actions_per_day: 5,
        blackout_windows: [],
        require_approval_above_minor: null,
        never_touch: [],
      },
      by: null,
    });
    const verdict = await withinLimits({
      profileId: s.profile_id,
      capability: "meta_publish",
      facts: { targets: [] },
      now: new Date(),
    });
    expect(verdict).toEqual({
      verdict: "needs_approval",
      reasons: ["the first three generated pieces always wait for your yes"],
    });
  });
});

describe("§10.3 / §10.4 — the brand voice as words; the library with usage", () => {
  it("builds readable words from the owner's own sentences, keeps the owner's edit, and never lets a draft replace it", async () => {
    const s = await business();
    const card = {
      traits: [
        { statement: "The business is called Szomszéd Szörp.", source: "identity.legal_name" },
        { statement: "Stated brand tone: warm, a little cheeky", source: "presence.brand_tone" },
      ],
      boundaries: ["sound corporate"],
    };
    expect(voiceWords(card)).toBe(
      "The business is called Szomszéd Szörp.\nStated brand tone: warm, a little cheeky\nNever: sound corporate.",
    );
    const draft = await buildVoice(s.profile_id, card);
    expect(draft).toMatchObject({ status: "draft", edited_by_owner: false });
    const mine = await editVoice(
      s.profile_id,
      randomUUID(),
      "Warm, short sentences, never salesy.",
    );
    expect(mine).toMatchObject({
      status: "confirmed",
      edited_by_owner: true,
      description: "Warm, short sentences, never salesy.",
    });
    expect((await buildVoice(s.profile_id, card)).id).toBe(mine.id); // a confirmed voice isn't replaced
    const all = await db
      .select()
      .from(brandVoiceProfiles)
      .where(eq(brandVoiceProfiles.profile_id, s.profile_id));
    expect(all).toHaveLength(2);
    expect((await currentVoice(s.profile_id))?.description).toBe(
      "Warm, short sentences, never salesy.",
    );
  });

  it("keeps usage history and says when footage for an upcoming brief is running low", async () => {
    const s = await business();
    const f = await figure(s.profile_id);
    await openBrief({
      profileId: s.profile_id,
      trigger: "margin_opportunity",
      evidence: [f.id],
      subject: "Pasta",
      angle: "Plated in ten seconds",
      assetsRequired: [{ kind: "video", description: "the pasta being plated", quantity: 3 }],
    });
    expect(await runningLow(s.profile_id)).toEqual([
      { description: "the pasta being plated", kind: "video", have: 0, need: 3 },
    ]);
    const clip = await addAsset({
      profileId: s.profile_id,
      kind: "video",
      url: "https://blob.test/p.mp4",
      contentType: "video/mp4",
      description: "Pasta plated at lunch",
      shotBy: "Marco",
      personAppears: false,
    });
    expect((await runningLow(s.profile_id))[0]).toMatchObject({ have: 1, need: 3 });
    const item = randomUUID();
    await useAsset(clip.id, item);
    await useAsset(clip.id, item); // once per post
    const lib = await libraryOf(s.profile_id);
    expect(lib.find((a) => a.asset.id === clip.id)?.uses).toBe(1);
    const [usage] = await db
      .select()
      .from(assetUsages)
      .where(and(eq(assetUsages.asset_id, clip.id), eq(assetUsages.content_item_id, item)));
    expect(usage).toBeTruthy();
  });
});
