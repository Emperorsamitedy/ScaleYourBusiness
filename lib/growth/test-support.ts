// What the growth engine's rules need in place before a generation or a
// publish, for tests that exercise the content paths (the v1 spec §10):
// a real §6.1 figure, a brief citing it, a confirmed brand voice, and the
// labelling record a generated item carries. Tests only — the app makes
// these through its own flows.

import { db } from "../../db";
import { brandVoiceProfiles, creativeBriefs } from "../../db/schema";
import { recordFigure } from "../figures/figure";
import { recordLabelling } from "./library";

/** A figure of this business's own, and its brand voice confirmed. Returns the figure id. */
export async function growthReady(profileId: string): Promise<string> {
  const figure = await recordFigure({
    profileId,
    key: "margin.best_seller",
    value: 4_200,
    source_detail: "test fixture",
    captured_at: new Date().toISOString(),
    provenance: { source: "stated" },
  });
  await db
    .insert(brandVoiceProfiles)
    .values({
      profile_id: profileId,
      description: "Warm and plain.",
      traits: [],
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
    })
    .onConflictDoNothing();
  return figure.id;
}

/** An evidence-cited brief with one hook, for items that need `brief_id`. */
export async function evidenceBrief(profileId: string, figureId?: string) {
  const id = figureId ?? (await growthReady(profileId));
  const cites = [{ id, kind: "figure", ref: id }];
  const [brief] = await db
    .insert(creativeBriefs)
    .values({
      profile_id: profileId,
      campaign: "Test campaign",
      brief: {
        audience: { text: "Locals", countries: [], cites },
        offer: { text: "The best seller", cites },
        hooks: [{ hook: "Why it sells", script: "Show it.", seconds: 12, cites, shots: [] }],
      },
      sources: [],
      model: "test",
      attempts: 1,
      cost_eur: "0",
      trigger: "margin_opportunity",
      evidence: [id],
      subject: "The best seller",
      angle: "Why it sells",
    })
    .returning();
  return brief!;
}

/** The labelling record a generated item made before §10 would have been given at render. */
export async function labelledForTest(
  profileId: string,
  itemId: string,
  mediaUrl: string,
  label: string,
) {
  return recordLabelling({ profileId, mediaUrl, label, media: "video", contentItemId: itemId });
}
