// The asset library, the brand voice profile and labelling records — the v1
// build spec §10.3, §10.4, §9.3 (P7-91..93).
//
//   addAsset          every asset with its rights record: who shot it,
//                     whether a person appears, the identity release where
//                     one does (a person with no release can be stored, but
//                     never rendered — lib/growth/brief.ts)
//   recordRelease     the person's identity release; revocable
//   useAsset          usage history: which post used which asset
//   runningLow        "You're running low on footage of X", driven by the
//                     assets upcoming briefs need
//   buildVoice / editVoice / confirmVoice
//                     the brand voice as plain words built from the owner's
//                     own sentences, read, corrected and confirmed by them
//   recordLabelling   the record written where a generated file is stamped
//   firstThreePending the first three generated pieces always wait for the
//                     owner's yes, whatever the station (§10.3)

import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  assetUsages,
  brandVoiceProfiles,
  contentItems,
  creativeBriefs,
  identityReleases,
  labellingRecords,
  libraryAssets,
} from "../../db/schema";
import { LABEL_STANDARD, provenanceManifest } from "../compliance/labeller";
import type { VoiceCard } from "../content/voice";

export class LibraryError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "LibraryError";
    this.status = status;
  }
}

// ── §10.4: assets and their rights ───────────────────────────────────────

export async function recordRelease(args: {
  profileId: string;
  person: string;
  evidenceRef: string;
  signedAt: Date;
}) {
  const person = args.person.trim().slice(0, 120);
  const ref = args.evidenceRef.trim().slice(0, 200);
  if (person === "" || ref === "")
    throw new LibraryError("a release names the person and the signed document");
  const [r] = await db
    .insert(identityReleases)
    .values({
      profile_id: args.profileId,
      person,
      evidence_ref: ref,
      signed_at: args.signedAt.toISOString(),
    })
    .returning();
  return r!;
}

export async function revokeRelease(profileId: string, releaseId: string) {
  await db
    .update(identityReleases)
    .set({ revoked_at: new Date().toISOString() })
    .where(
      and(
        eq(identityReleases.id, releaseId),
        eq(identityReleases.profile_id, profileId),
        isNull(identityReleases.revoked_at),
      ),
    );
}

export async function addAsset(args: {
  profileId: string;
  kind: "video" | "photo";
  url: string;
  contentType: string;
  description: string;
  shotBy: string;
  personAppears: boolean;
  identityReleaseId?: string | null;
  source?: "upload" | "drive" | "footage";
}) {
  const description = args.description.trim().slice(0, 300);
  const shotBy = args.shotBy.trim().slice(0, 120);
  if (description === "") throw new LibraryError("say what the asset shows");
  if (shotBy === "") throw new LibraryError("say who shot it");
  if (args.identityReleaseId) {
    const [r] = await db
      .select({ id: identityReleases.id })
      .from(identityReleases)
      .where(
        and(
          eq(identityReleases.id, args.identityReleaseId),
          eq(identityReleases.profile_id, args.profileId),
        ),
      );
    if (!r) throw new LibraryError("no such release", 404);
  }
  const [a] = await db
    .insert(libraryAssets)
    .values({
      profile_id: args.profileId,
      kind: args.kind,
      url: args.url,
      content_type: args.contentType,
      description,
      source: args.source ?? "upload",
      shot_by: shotBy,
      person_appears: args.personAppears,
      identity_release_id: args.identityReleaseId ?? null,
    })
    .returning();
  return a!;
}

export async function useAsset(assetId: string, contentItemId: string) {
  await db
    .insert(assetUsages)
    .values({ asset_id: assetId, content_item_id: contentItemId })
    .onConflictDoNothing();
}

/** The library with each asset's usage count, newest first. */
export async function libraryOf(profileId: string) {
  const rows = await db
    .select({
      asset: libraryAssets,
      uses: sql<number>`(select count(*)::int from asset_usages u where u.asset_id = "library_assets"."id")`,
    })
    .from(libraryAssets)
    .where(eq(libraryAssets.profile_id, profileId))
    .orderBy(desc(libraryAssets.created_at));
  return rows;
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3),
  );

/**
 * §10.4: "You're running low on footage of X." For each thing the recent
 * briefs need, how many matching assets the library holds (an asset matches
 * when it shares a meaningful word with the need) against how many are needed.
 */
export async function runningLow(profileId: string, recentBriefs = 10) {
  const briefs = await db
    .select({ needs: creativeBriefs.assets_required })
    .from(creativeBriefs)
    .where(eq(creativeBriefs.profile_id, profileId))
    .orderBy(desc(creativeBriefs.created_at))
    .limit(recentBriefs);
  const assets = await db
    .select({ kind: libraryAssets.kind, description: libraryAssets.description })
    .from(libraryAssets)
    .where(eq(libraryAssets.profile_id, profileId));
  const out: { description: string; kind: string; have: number; need: number }[] = [];
  for (const b of briefs) {
    for (const n of b.needs ?? []) {
      const want = words(n.description);
      const have = assets.filter(
        (a) => a.kind === n.kind && [...words(a.description)].some((w) => want.has(w)),
      ).length;
      if (have < n.quantity)
        out.push({ description: n.description, kind: n.kind, have, need: n.quantity });
    }
  }
  return out;
}

// ── §10.3: the brand voice, as words ─────────────────────────────────────

/** Pure: the voice card as a few plain sentences the owner can read and correct. */
export function voiceWords(card: Pick<VoiceCard, "traits" | "boundaries">): string {
  const lines = card.traits.map((t) => t.statement.trim()).filter((s) => s !== "");
  if (card.boundaries.length > 0) lines.push(`Never: ${card.boundaries.join("; ")}.`);
  return lines.join("\n");
}

export async function currentVoice(profileId: string) {
  const [v] = await db
    .select()
    .from(brandVoiceProfiles)
    .where(
      and(eq(brandVoiceProfiles.profile_id, profileId), isNull(brandVoiceProfiles.superseded_at)),
    );
  return v ?? null;
}

/** Build (or rebuild) the draft from the voice card. A confirmed profile is never replaced by a draft. */
export async function buildVoice(
  profileId: string,
  card: Pick<VoiceCard, "traits" | "boundaries">,
) {
  const live = await currentVoice(profileId);
  if (live?.status === "confirmed") return live;
  const description = voiceWords(card) || "Plain, friendly and direct.";
  return db.transaction(async (tx) => {
    if (live) {
      await tx
        .update(brandVoiceProfiles)
        .set({ superseded_at: new Date().toISOString() })
        .where(eq(brandVoiceProfiles.id, live.id));
    }
    const [v] = await tx
      .insert(brandVoiceProfiles)
      .values({
        profile_id: profileId,
        description,
        traits: card.traits.map((t) => ({ statement: t.statement, source: t.source })),
      })
      .returning();
    return v!;
  });
}

/** The owner's words replace SYB's: a new confirmed version, the old one kept. */
export async function editVoice(profileId: string, userId: string, description: string) {
  const text = description.trim();
  if (text === "") throw new LibraryError("describe the voice in a few words");
  if (text.length > 2_000) throw new LibraryError("keep it under 2,000 characters");
  const live = await currentVoice(profileId);
  const at = new Date().toISOString();
  return db.transaction(async (tx) => {
    if (live)
      await tx
        .update(brandVoiceProfiles)
        .set({ superseded_at: at })
        .where(eq(brandVoiceProfiles.id, live.id));
    const [v] = await tx
      .insert(brandVoiceProfiles)
      .values({
        profile_id: profileId,
        description: text,
        traits: live?.traits ?? [],
        status: "confirmed",
        edited_by_owner: true,
        confirmed_by: userId,
        confirmed_at: at,
      })
      .returning();
    return v!;
  });
}

/** The owner read SYB's words and agrees with them as they are. */
export async function confirmVoice(profileId: string, userId: string) {
  const live = await currentVoice(profileId);
  if (!live) throw new LibraryError("there is no voice description yet", 404);
  if (live.status === "confirmed") return live;
  const [v] = await db
    .update(brandVoiceProfiles)
    .set({ status: "confirmed", confirmed_by: userId, confirmed_at: new Date().toISOString() })
    .where(eq(brandVoiceProfiles.id, live.id))
    .returning();
  return v!;
}

// ── §9.3 / §10.6: labelling records ──────────────────────────────────────

export { LABEL_STANDARD };

export async function recordLabelling(args: {
  profileId: string;
  mediaUrl: string;
  label: string;
  media: "image" | "video";
  contentItemId?: string | null;
  generationId?: string | null;
  candidateId?: string | null;
  at?: Date;
  /** The labelled file's bytes, when at hand, for the manifest's hash. */
  bytes?: Uint8Array | null;
}) {
  const at = args.at ?? new Date();
  const method = args.media === "image" ? "iptc_xmp+jpeg_comment" : "mp4_comment";
  const [r] = await db
    .insert(labellingRecords)
    .values({
      profile_id: args.profileId,
      media_url: args.mediaUrl,
      content_item_id: args.contentItemId ?? null,
      generation_id: args.generationId ?? null,
      candidate_id: args.candidateId ?? null,
      method,
      standard_version: LABEL_STANDARD,
      label: args.label,
      manifest: provenanceManifest({
        media: args.media,
        label: args.label,
        method,
        at,
        bytes: args.bytes ?? null,
      }),
      labelled_at: at.toISOString(),
    })
    .returning();
  return r!;
}

/** Who published it, and when, on the record that covers the item's media. */
export async function markLabellingPublished(
  contentItemId: string,
  mediaUrl: string | null,
  by: string | null,
) {
  await db
    .update(labellingRecords)
    .set({ published_by: by, published_at: new Date().toISOString() })
    .where(
      and(
        isNull(labellingRecords.published_at),
        mediaUrl
          ? sql`(${labellingRecords.content_item_id} = ${contentItemId} or ${labellingRecords.media_url} = ${mediaUrl})`
          : eq(labellingRecords.content_item_id, contentItemId),
      ),
    );
}

// ── §10.3: the first three pieces ────────────────────────────────────────

export const FIRST_PIECES = 3;

/** True while fewer than three generated pieces have been published: each still waits for a yes. */
export async function firstThreePending(profileId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.profile_id, profileId),
        eq(contentItems.status, "published"),
        sql`(${contentItems.provenance} -> 'media' ->> 'is_ai_generated') = 'true'`,
      ),
    );
  return (row?.n ?? 0) < FIRST_PIECES;
}
