// The evidence-cited creative brief — the v1 build spec §10.1–§10.2 (P7-90).
//
// "A brief that cannot cite evidence does not generate. That rule is what
// separates this from every other AI video tool and it must be enforced,
// not aspirational." Enforced three times:
//   · here: a brief opens only with at least one §6.1 figure id, and
//     `requireGenerationBrief` refuses a render whose brief has none;
//   · the database: a brief may cite only its own business's figures, and a
//     new media generation must name a brief that cites at least one
//     (migration 0119);
//   · the render paths call `requireGenerationBrief` before they claim.
//
// Step 1, opportunity detection, is deterministic: it reads the business's
// own §6.1 figures by key and names the trigger each supports. No model.

import { and, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import { db } from "../../db";
import {
  brandVoiceProfiles,
  creativeBriefs,
  figures,
  identityReleases,
  libraryAssets,
} from "../../db/schema";
import type { AssetNeed } from "../../db/schema";

export const BRIEF_TRIGGERS = [
  "margin_opportunity",
  "slow_stock",
  "dead_hours",
  "seasonal_forecast",
  "winback",
  "peer_signal",
] as const;
export type BriefTrigger = (typeof BRIEF_TRIGGERS)[number];

export class BriefError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "BriefError";
    this.status = status;
  }
}

export const NO_EVIDENCE = "a brief that cannot cite evidence does not generate";

/**
 * §10.1 step 1: which figure keys support which trigger, as data. A figure
 * whose key starts with one of these prefixes is evidence for that trigger.
 */
export const TRIGGER_KEYS: Readonly<Record<BriefTrigger, readonly string[]>> = {
  margin_opportunity: ["margin.", "gross_margin", "unit_economics.margin"],
  slow_stock: ["stock.days_since_sale", "stock.slow", "stock.value_at_cost"],
  dead_hours: ["hours.", "revenue.hourly"],
  seasonal_forecast: ["forecast.", "season."],
  winback: ["customers.lapsed", "customers.winback"],
  peer_signal: ["peer."],
};

/** Opportunity detection: each trigger the business's own figures support, with those figures, newest first. */
export async function detectOpportunities(profileId: string) {
  const out: { trigger: BriefTrigger; figure_ids: string[] }[] = [];
  for (const trigger of BRIEF_TRIGGERS) {
    const prefixes = TRIGGER_KEYS[trigger];
    const rows = await db
      .select({ id: figures.id })
      .from(figures)
      .where(
        and(
          eq(figures.profile_id, profileId),
          or(...prefixes.map((p) => like(figures.key, `${p}%`))),
        ),
      )
      .orderBy(desc(figures.captured_at))
      .limit(5);
    if (rows.length > 0) out.push({ trigger, figure_ids: rows.map((r) => r.id) });
  }
  return out;
}

/** §10.2: open a brief. No evidence, no brief; foreign figures are refused by the database. */
export async function openBrief(args: {
  profileId: string;
  trigger: BriefTrigger;
  evidence: readonly string[];
  subject: string;
  angle: string;
  assetsRequired?: readonly AssetNeed[];
  locale?: string | null;
  depictsRealPerson?: boolean;
}) {
  if (!(BRIEF_TRIGGERS as readonly string[]).includes(args.trigger))
    throw new BriefError("no such trigger");
  const evidence = [...new Set(args.evidence)];
  if (evidence.length === 0) throw new BriefError(NO_EVIDENCE);
  const subject = args.subject.trim();
  const angle = args.angle.trim();
  if (subject === "" || angle === "")
    throw new BriefError("a brief names its subject and its angle");
  const [voice] = await db
    .select({ id: brandVoiceProfiles.id })
    .from(brandVoiceProfiles)
    .where(
      and(
        eq(brandVoiceProfiles.profile_id, args.profileId),
        isNull(brandVoiceProfiles.superseded_at),
      ),
    );
  const cites = evidence.map((id) => ({ id, kind: "figure", ref: id }));
  const [row] = await db
    .insert(creativeBriefs)
    .values({
      profile_id: args.profileId,
      campaign: subject.slice(0, 200),
      brief: {
        audience: { text: "", countries: [], cites },
        offer: { text: subject, cites },
        hooks: [{ hook: angle, script: angle, seconds: 15, cites, shots: [] }],
      },
      sources: [],
      model: "evidence",
      attempts: 1,
      cost_eur: "0",
      trigger: args.trigger,
      evidence,
      subject,
      angle,
      assets_required: [...(args.assetsRequired ?? [])],
      locale: args.locale ?? null,
      brand_voice_profile_id: voice?.id ?? null,
      depicts_real_person: args.depictsRealPerson === true,
    })
    .returning();
  return row!;
}

/** Cite figures on a brief written before §10 (or add more): the database checks each is this business's. */
export async function citeEvidence(
  profileId: string,
  briefId: string,
  figureIds: readonly string[],
) {
  const [b] = await db
    .select({ evidence: creativeBriefs.evidence })
    .from(creativeBriefs)
    .where(and(eq(creativeBriefs.id, briefId), eq(creativeBriefs.profile_id, profileId)));
  if (!b) throw new BriefError("no such brief", 404);
  const evidence = [...new Set([...b.evidence, ...figureIds])];
  await db.update(creativeBriefs).set({ evidence }).where(eq(creativeBriefs.id, briefId));
  return evidence;
}

/**
 * The render gate. The item's brief must cite evidence; the brand voice must
 * have been shown to the owner and confirmed (§10.3, "before first use");
 * and a video showing a real person needs a live identity release — for the
 * brief itself and for every supplied asset in which a person appears
 * (§10.6, Art. 50(4)). Returns the brief id the generation row names.
 */
export async function requireGenerationBrief(
  profileId: string,
  provenance: unknown,
): Promise<string> {
  const briefId = (provenance as { brief_id?: unknown } | null)?.brief_id;
  if (typeof briefId !== "string") throw new BriefError(NO_EVIDENCE);
  const [b] = await db
    .select()
    .from(creativeBriefs)
    .where(and(eq(creativeBriefs.id, briefId), eq(creativeBriefs.profile_id, profileId)));
  if (!b || b.evidence.length === 0) throw new BriefError(NO_EVIDENCE);

  const [voice] = await db
    .select({ status: brandVoiceProfiles.status })
    .from(brandVoiceProfiles)
    .where(
      and(eq(brandVoiceProfiles.profile_id, profileId), isNull(brandVoiceProfiles.superseded_at)),
    );
  if (voice?.status !== "confirmed") {
    throw new BriefError(
      "read and confirm how SYB describes your voice before anything is generated",
      409,
    );
  }

  const releaseLive = async (id: string | null) => {
    if (!id) return false;
    const [r] = await db
      .select({ id: identityReleases.id })
      .from(identityReleases)
      .where(
        and(
          eq(identityReleases.id, id),
          eq(identityReleases.profile_id, profileId),
          isNull(identityReleases.revoked_at),
        ),
      );
    return r !== undefined;
  };
  if (b.depicts_real_person) {
    const [any] = await db
      .select({ id: identityReleases.id })
      .from(identityReleases)
      .where(and(eq(identityReleases.profile_id, profileId), isNull(identityReleases.revoked_at)))
      .limit(1);
    if (!any)
      throw new BriefError("a video showing a real person needs their identity release first", 409);
  }
  if (b.assets_supplied.length > 0) {
    const assets = await db
      .select({ person: libraryAssets.person_appears, release: libraryAssets.identity_release_id })
      .from(libraryAssets)
      .where(
        and(eq(libraryAssets.profile_id, profileId), inArray(libraryAssets.id, b.assets_supplied)),
      );
    for (const a of assets) {
      if (a.person && !(await releaseLive(a.release))) {
        throw new BriefError("an asset shows a person with no identity release on file", 409);
      }
    }
  }
  return b.id;
}

/**
 * §10.1 step 5–7: publishing needs station 3 (the engine's ladder check),
 * and turning a winning organic post into a paid ad needs station 4 on the
 * ad capability — never lower, whatever is asked. The promotion itself
 * goes through the engine within the owner's caps like every ad change.
 */
export async function canPromoteToAd(
  profileId: string,
  capability: "meta_ads" | "tiktok_ads" = "meta_ads",
) {
  const { authorize } = await import("../ladder/ladder");
  return (await authorize(profileId, capability)).state === "AUTHORIZED";
}

/** Publishing a generated piece needs at least station 3 on its publish capability. */
export async function canPublish(profileId: string, capability: "meta_publish" | "tiktok_publish") {
  const { authorize } = await import("../ladder/ladder");
  const { state } = await authorize(profileId, capability);
  return state === "NEEDS_APPROVAL" || state === "AUTHORIZED";
}
