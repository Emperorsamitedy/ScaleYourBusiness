// The AI fallback for media — P3-53 (Session K, owner decision 2026-10-26:
// "real footage first, AI generation as the fallback").
//
// When an item has no footage, SYB may PROPOSE generating an image or a
// short clip for it, from the item's own words (its caption, or its
// planned slot's focus) and — when a creative brief has one — a hook and
// script. It is a proposal like any other (rule 12): it states the cost
// estimate and the caps it sits under, the hard limits (13.5) and the
// suppression rule (P3-28) apply, and NOTHING is generated until a named
// human approves it and asks for it. Generation is internal production,
// like drafting (./produce): it spends money but writes to no platform, so
// it does not pass the Session B engine. The proposal still flips to
// executed through the Session A service, and the decision log records it.
//
// Money (rule 1) and the caps, in code — not configuration:
//   - every attempt's charge is recorded in media_generations, in integer
//     minor units with its currency
//   - per item: ITEM_CAP_MINOR across every generation for that item
//   - per account, per calendar month (UTC): MONTHLY_CAP_MINOR
//   - MAX_GENERATION_ATTEMPTS attempts, then it stops
//   - a provider pricing in another currency is refused, never converted
//
// Labelled as GENERATED (rule 17, stronger than "AI-assisted"): in the
// file (./generate/label), in the caption's disclosure (mediaDisclosureLabel),
// and in the item's provenance (media.is_ai_generated). Instagram's
// is_ai_generated flag is set on every container by the executor anyway.
//
// Refused before anything is proposed: a real person's likeness or a named
// brand (./generate/guard, competitors included), and any item that has
// the owner's footage — real footage always wins (./media-item).
//
// The brief input is an optional {hook, script}: Session K's creative brief
// (P3-51, built on a sibling branch) is wired to it at merge.

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  competitors,
  contentItems,
  footageClips,
  mediaGenerations,
  proposals,
} from "../../db/schema";
import type { Money } from "../core/money";
import { format, money } from "../core/money";
import { logSafeError } from "../core/log-safe";
import { mediaProviderSetting } from "../env";
import type { MediaProviderSetting } from "../env";
import { readCurrentField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import {
  checkHardLimits,
  ensureHardLimits,
  limitCaption,
  liveLimitLlm,
} from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal, recordExecution } from "../proposals/service";
import { suppressedKinds } from "../trust/suppression";
import { relabel } from "./disclosure";
import { fakeMediaProvider } from "./generate/fake";
import { readJpegLabels, readVideoComment, stampJpeg, stampVideo } from "./generate/label";
import type { GeneratedMedia, GenerationRequest, MediaProvider } from "./generate/provider";
import { FIXED_INSTRUCTION, GENERATED_CLIP_SECONDS, ProviderError } from "./generate/provider";
import { screenPrompt } from "./generate/guard";
import { vendorMediaProvider } from "./generate/vendor";
import type { MediaStore } from "./media";
import { configuredMediaStore } from "./media";
import type { ContentItemRow } from "./media-item";
import { hasFootageFor, mediaOf, mediaTargetRefusal, placeMedia } from "./media-item";
import { mediaDisclosureLabel } from "./disclosure";
import { ContentError } from "./plan";
import { assertNotWatching, contentWatchUntil } from "./watch";

export const GENERATION_KIND = "media_generation";
/** The caps' currency. The budget is in euro (CLAUDE.md, cost discipline). */
export const GENERATION_CURRENCY = "EUR";
/** €2.00 per item, every attempt and every regeneration together. */
export const ITEM_CAP_MINOR = 200;
/** €10.00 per account per calendar month (UTC). */
export const MONTHLY_CAP_MINOR = 1000;
/** Hard attempt cap — the database checks it too. */
export const MAX_GENERATION_ATTEMPTS = 2;
export const GENERATION_EXPIRY_DAYS = 7;
/** The prompt never runs on: what goes to the provider is short and readable on the card. */
export const PROMPT_MAX = 1200;
export const DIRECTION_MAX = 300;

/** What a creative brief can add (Session K, P3-51 — wired at merge, never imported here). */
export interface BriefInput {
  hook?: string;
  script?: string;
}

/* ── is generation set up? ── */

export interface GenerationSetup {
  provider: MediaProvider | null;
  /** The owner's sentence when it isn't. */
  reason: string | null;
  setting: MediaProviderSetting;
}

export const GENERATION_OFF =
  "AI generation isn't set up here, so SYB doesn't propose it. Film it instead: real footage always comes first.";

export function generationSetup(
  setting: MediaProviderSetting = mediaProviderSetting(),
): GenerationSetup {
  if (setting === "fake") return { provider: fakeMediaProvider(), reason: null, setting };
  if (setting === "vendor") {
    return { provider: null, reason: vendorMediaProvider.unavailable, setting };
  }
  return { provider: null, reason: GENERATION_OFF, setting };
}

/* ── the prompt, built from the item's own words ── */

/** Pure: the item's words with labels, links and hashtags taken off. */
function wordsOf(text: string): string {
  return relabel(text, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pure: what the provider is asked to make. The owner's direction, when
 * given, replaces the item's words as the subject; a brief's hook and
 * script are added. Shot-list templates are never sent: they ask for the
 * owner on camera, and the owner is a real person.
 */
export function buildPrompt(args: {
  item: Pick<ContentItemRow, "kind" | "title" | "body" | "provenance">;
  media: GeneratedMedia;
  brief?: BriefInput | null;
  direction?: string | null;
}): string {
  const planned = (args.item.provenance as { item?: { focus?: unknown; brief?: unknown } } | null)
    ?.item;
  const fromItem =
    args.item.kind === "post"
      ? wordsOf(args.item.body)
      : [planned?.focus, planned?.brief]
          .filter((x): x is string => typeof x === "string" && x.trim() !== "")
          .join(". ") || args.item.title.replace(/^(Film for [^—]+— |Shot list — )/, "");
  const subject = args.direction?.trim() || fromItem;
  const parts = [
    args.media === "image"
      ? "A single still image, 4:5 portrait, for a social media post."
      : `A ${GENERATED_CLIP_SECONDS}-second vertical 9:16 video clip for a social media post.`,
    `Subject: ${wordsOf(subject)}.`,
  ];
  const hook = args.brief?.hook?.trim();
  const script = args.brief?.script?.trim();
  if (hook) parts.push(`Hook: ${wordsOf(hook)}.`);
  if (script) parts.push(`Script: ${wordsOf(script)}`);
  const prompt = parts.join(" ").replace(/\.\.+/g, ".");
  return prompt.length > PROMPT_MAX ? `${prompt.slice(0, PROMPT_MAX - 1)}…` : prompt;
}

export function promptHash(prompt: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, prompt, instruction: FIXED_INSTRUCTION }))
    .digest("hex");
}

async function competitorNames(profileId: string): Promise<string[]> {
  const rows = await db
    .select({ id: competitors.id })
    .from(competitors)
    .where(eq(competitors.profile_id, profileId));
  const names: string[] = [];
  for (const r of rows) {
    const f = await readCurrentField<unknown>(profileId, `competitors.${r.id}.name`);
    if (typeof f?.value === "string" && f.value.trim() !== "") names.push(f.value.trim());
  }
  return names;
}

/* ── the caps, as arithmetic over the ledger ── */

/** Pure: the first instant of the UTC calendar month `at` falls in. */
export function monthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

async function spent(where: ReturnType<typeof and>): Promise<number> {
  const [row] = await db
    .select({
      // Settled rows count what they cost; a run still generating counts its estimate.
      total: sql<string>`coalesce(sum(coalesce(${mediaGenerations.cost_minor}, ${mediaGenerations.estimate_minor})), 0)`,
    })
    .from(mediaGenerations)
    .where(where);
  return Number(row?.total ?? 0);
}

export interface CapRoom {
  item_spent: Money;
  month_spent: Money;
  item_cap: Money;
  month_cap: Money;
}

export async function capRoom(args: {
  accountId: string;
  targetItemId: string;
  now: Date;
}): Promise<CapRoom> {
  const cur = eq(mediaGenerations.currency, GENERATION_CURRENCY);
  const [item, month] = await Promise.all([
    spent(and(eq(mediaGenerations.target_item_id, args.targetItemId), cur)),
    spent(
      and(
        eq(mediaGenerations.account_id, args.accountId),
        gte(mediaGenerations.created_at, monthStart(args.now).toISOString()),
        cur,
      ),
    ),
  ]);
  return {
    item_spent: money(item, GENERATION_CURRENCY),
    month_spent: money(month, GENERATION_CURRENCY),
    item_cap: money(ITEM_CAP_MINOR, GENERATION_CURRENCY),
    month_cap: money(MONTHLY_CAP_MINOR, GENERATION_CURRENCY),
  };
}

/** Pure: the sentence when one more charge of `next` would break a cap, else null. */
export function capRefusal(room: CapRoom, next: Money): string | null {
  if (next.currency !== GENERATION_CURRENCY) {
    return `the provider prices in ${next.currency} and the caps are in ${GENERATION_CURRENCY} — SYB doesn't convert money silently`;
  }
  if (room.item_spent.amount_minor + next.amount_minor > ITEM_CAP_MINOR) {
    return `it would take this item past its ${format(room.item_cap)} cap (${format(room.item_spent)} spent on it so far)`;
  }
  if (room.month_spent.amount_minor + next.amount_minor > MONTHLY_CAP_MINOR) {
    return `it would take this month past its ${format(room.month_cap)} cap (${format(room.month_spent)} spent so far)`;
  }
  return null;
}

/* ── which items can have media generated, and why the rest can't ── */

async function accountOf(profileId: string): Promise<string> {
  const [row] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!row) throw new ContentError("no such business", 404);
  return row.account_id;
}

async function ownedItem(profileId: string, itemId: string): Promise<ContentItemRow> {
  const [item] = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.id, itemId), eq(contentItems.profile_id, profileId)));
  if (!item) throw new ContentError("no such content item", 404);
  return item;
}

/** Why this item can't have media generated, or null. Footage first, always. */
export async function generationRefusal(item: ContentItemRow): Promise<string | null> {
  const refusal = mediaTargetRefusal(item);
  if (refusal) return refusal;
  if (item.kind === "post" && item.status !== "drafted") return `it is ${item.status}`;
  if (await hasFootageFor(item.profile_id, item.id)) {
    return "it has your own footage — real footage always comes first";
  }
  const [clip] = await db
    .select({ id: footageClips.id })
    .from(footageClips)
    .where(and(eq(footageClips.item_id, item.id), eq(footageClips.status, "uploaded")))
    .limit(1);
  if (clip) return "you've uploaded clips for it — cut those instead";
  if (item.kind === "post" && item.media_path !== null) {
    return mediaOf(item.provenance)?.is_ai_generated
      ? "it already has a generated picture"
      : "it already has media";
  }
  if (item.kind === "shot_list") {
    const [video] = await db
      .select({ id: contentItems.id })
      .from(contentItems)
      .where(
        and(
          eq(contentItems.profile_id, item.profile_id),
          eq(contentItems.kind, "video"),
          inArray(contentItems.status, ["drafted", "queued", "publishing", "published"]),
          sql`${contentItems.provenance}->'media'->>'source_item_id' = ${item.id}`,
        ),
      )
      .limit(1);
    if (video) return "its video already has media";
  }
  return null;
}

/* ── proposing ── */

/** True for a media generation proposal — never a calendar to draft, never a post to publish. */
export function isGenerationProposal(action: unknown): boolean {
  return (action as { kind?: unknown } | null)?.kind === GENERATION_KIND;
}

export async function proposeGeneration(args: {
  profileId: string;
  itemId: string;
  media: unknown;
  brief?: BriefInput | null;
  direction?: unknown;
  now?: Date;
  limitLlm?: LimitLlm;
  setup?: GenerationSetup;
}): Promise<ProposalRow> {
  const now = args.now ?? new Date();
  if (args.media !== "image" && args.media !== "video") {
    throw new ContentError('media must be "image" or "video"', 422);
  }
  const media: GeneratedMedia = args.media;
  const direction = typeof args.direction === "string" ? args.direction.trim() : "";
  if (direction.length > DIRECTION_MAX) {
    throw new ContentError(`the direction can be up to ${DIRECTION_MAX} characters`, 422);
  }
  await assertNotWatching(args.profileId, now);
  const setup = args.setup ?? generationSetup();
  if (!setup.provider) throw new ContentError(setup.reason ?? GENERATION_OFF, 503);
  const provider = setup.provider;

  const item = await ownedItem(args.profileId, args.itemId);
  const refusal = await generationRefusal(item);
  if (refusal)
    throw new ContentError(`SYB won't propose generating media for this: ${refusal}`, 409);

  const [pending] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, args.profileId),
        eq(proposals.originating_finding, `generate:${item.id}`),
        inArray(proposals.status, ["pending", "approved"]),
      ),
    )
    .limit(1);
  if (pending) throw new ContentError("generating media for this is already in your queue", 409);

  const suppressed = (await suppressedKinds(args.profileId)).get(GENERATION_KIND);
  if (suppressed) {
    throw new ContentError(
      `you've declined generated media ${suppressed.rejections} times — I've stopped proposing it`,
      409,
    );
  }

  const prompt = buildPrompt({
    item,
    media,
    ...(args.brief ? { brief: args.brief } : {}),
    ...(direction ? { direction } : {}),
  });
  const verdict = screenPrompt(prompt, await competitorNames(args.profileId));
  if (!verdict.ok) {
    throw new ContentError(
      `SYB won't propose that: ${verdict.reason} ("${verdict.matched}"). Reword the direction, or film it.`,
      422,
    );
  }

  const seconds = media === "video" ? GENERATED_CLIP_SECONDS : undefined;
  const estimate = provider.estimate({ media, ...(seconds ? { seconds } : {}) });
  const accountId = await accountOf(args.profileId);
  const room = await capRoom({ accountId, targetItemId: item.id, now });
  const over = capRefusal(room, estimate);
  if (over) throw new ContentError(`SYB won't propose that: ${over}`, 409);

  const { limits } = await ensureHardLimits(args.profileId, args.limitLlm ?? liveLimitLlm);
  // Generated media exists to be published: the owner's content limits apply to it.
  const limit = checkHardLimits(limits, "content_publishing");

  const what = media === "image" ? "an image" : `a ${GENERATED_CLIP_SECONDS}-second clip`;
  const label = mediaDisclosureLabel(item.kind === "post" ? "post" : "video", `generated_${media}`);
  const cost = format(estimate);
  return createProposal({
    profile_id: args.profileId,
    module: "content",
    originating_finding: `generate:${item.id}`,
    action: {
      kind: GENERATION_KIND,
      summary: `Generate ${what} for "${item.title}" with AI — about ${cost}, because there's no footage for it`,
      detail: {
        target_item_id: item.id,
        media,
        ...(seconds ? { seconds } : {}),
        provider: provider.id,
        prompt,
        instruction: FIXED_INSTRUCTION,
        prompt_sha256: promptHash(prompt),
        estimate,
        caps: {
          item: room.item_cap,
          item_spent: room.item_spent,
          month: room.month_cap,
          month_spent: room.month_spent,
          max_attempts: MAX_GENERATION_ATTEMPTS,
        },
        label,
        ...(args.brief ? { brief: args.brief } : {}),
        ...(direction ? { direction } : {}),
        manual_limits: limit.manual.map((l) => l.quote),
        rationale:
          "Real footage first: this is the fallback for an item with none. What it makes is labelled as AI-generated in the file, in the caption and in its record, and it still needs its own yes before it is published.",
      },
    },
    scenario: {
      assumptions: [
        {
          statement: `One attempt costs about ${cost} (${provider.id} provider's price); at most ${MAX_GENERATION_ATTEMPTS} attempts are made`,
          value: null,
          source_field: null,
          sensitivity: "low",
        },
      ],
      base_case: {
        case: "base",
        statement: `${what[0]!.toUpperCase()}${what.slice(1)} for "${item.title}", labelled "${label}", ready for its own publish proposal.`,
        profit_delta_monthly: null,
        formula: null,
      },
      downside_case: {
        case: "downside",
        statement: `It isn't usable and ${cost} (or up to ${format(money(estimate.amount_minor * MAX_GENERATION_ATTEMPTS, estimate.currency))} across both attempts) is spent. Nothing is published either way without your yes.`,
        profit_delta_monthly: null,
        formula: null,
      },
      upside_case: {
        case: "upside",
        statement:
          "The item can go out on time, and you can swap in your own footage whenever you film it.",
        profit_delta_monthly: null,
        formula: null,
      },
      breakeven_condition: `costs about ${cost}, under a ${format(room.item_cap)} per-item and ${format(room.month_cap)} per-month cap`,
    } as never,
    reversibility: {
      level: "moderate",
      if_you_change_your_mind:
        "The money spent on generating isn't refundable. The media publishes nowhere until you approve it separately, and your own footage replaces it whenever you upload it.",
    },
    expires_at: new Date(now.getTime() + GENERATION_EXPIRY_DAYS * 86_400_000).toISOString(),
    blocked_by_limit: limit.verdict === "blocked" ? limitCaption(limit.limit) : null,
  });
}

/* ── generating, once approved ── */

export interface GenerationOutcome {
  status: "generated" | "failed" | "not_needed";
  item_id?: string;
  cost: Money;
  note: string;
}

interface GenerationDetail {
  target_item_id?: unknown;
  media?: unknown;
  seconds?: unknown;
  prompt?: unknown;
  prompt_sha256?: unknown;
  estimate?: { amount_minor?: unknown; currency?: unknown };
}

/**
 * Generate what an APPROVED generation proposal promised. Claimed once
 * (media_generations.proposal_id is unique), attempts capped, each charge
 * recorded and the caps re-checked before each attempt, the result
 * labelled in the file and placed on its item, then offered for publishing.
 */
export async function generateFromProposal(args: {
  proposalId: string;
  expectedProfileId?: string;
  setup?: GenerationSetup;
  store?: MediaStore;
  now?: Date;
  limitLlm?: LimitLlm;
}): Promise<GenerationOutcome> {
  const now = args.now ?? new Date();
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, args.proposalId));
  if (!proposal || (args.expectedProfileId && proposal.profile_id !== args.expectedProfileId)) {
    throw new ContentError("no such proposal", 404);
  }
  if (!isGenerationProposal(proposal.action)) {
    throw new ContentError("this isn't a media generation proposal", 422);
  }
  if (proposal.status !== "approved") {
    throw new ContentError(
      `only an approved proposal generates anything — this one is ${proposal.status}`,
      409,
    );
  }
  const d = ((proposal.action as { detail?: GenerationDetail }).detail ?? {}) as GenerationDetail;
  const media = d.media === "video" ? "video" : d.media === "image" ? "image" : null;
  if (!media || typeof d.target_item_id !== "string" || typeof d.prompt !== "string") {
    throw new ContentError("the proposal doesn't say what to generate", 422);
  }
  if (d.prompt_sha256 !== promptHash(d.prompt)) {
    throw new ContentError("the prompt isn't the one you approved — nothing was generated", 409);
  }
  const prompt = d.prompt;
  const seconds = media === "video" ? GENERATED_CLIP_SECONDS : undefined;

  const setup = args.setup ?? generationSetup();
  if (!setup.provider) {
    throw new ContentError(`${setup.reason ?? GENERATION_OFF} It stays approved.`, 503);
  }
  const provider = setup.provider;
  const store = args.store ?? configuredMediaStore();
  if (!store) {
    throw new ContentError("media storage isn't set up on this server. It stays approved.", 503);
  }
  const accountId = await accountOf(proposal.profile_id);
  const target = await ownedItem(proposal.profile_id, d.target_item_id);
  const zero = money(0, GENERATION_CURRENCY);

  // Footage arrived (or media did) while this waited: close it honestly, nothing generated, nothing charged.
  const refusal = await generationRefusal(target);
  if (refusal) {
    const note = `Nothing was generated and nothing was charged: ${refusal}.`;
    await recordExecution({
      proposalId: proposal.id,
      result: { generated: false, reason: refusal, cost: zero },
    });
    return { status: "not_needed", cost: zero, note };
  }
  // The screen runs again on the approved words: a competitor added since is still refused.
  const verdict = screenPrompt(prompt, await competitorNames(proposal.profile_id));
  if (!verdict.ok) {
    throw new ContentError(`Nothing was generated: ${verdict.reason} ("${verdict.matched}").`, 422);
  }

  const estimate = provider.estimate({ media, ...(seconds ? { seconds } : {}) });
  const over = capRefusal(await capRoom({ accountId, targetItemId: target.id, now }), estimate);
  if (over) throw new ContentError(`Nothing was generated: ${over}. It stays approved.`, 409);

  // The claim: one generation per approved proposal, ever.
  let claimId: string;
  try {
    const [claim] = await db
      .insert(mediaGenerations)
      .values({
        profile_id: proposal.profile_id,
        account_id: accountId,
        proposal_id: proposal.id,
        target_item_id: target.id,
        media,
        provider: provider.id,
        estimate_minor: estimate.amount_minor,
        currency: estimate.currency,
        prompt_sha256: promptHash(prompt),
        created_at: now.toISOString(),
      })
      .returning({ id: mediaGenerations.id });
    claimId = claim!.id;
  } catch (error) {
    if (
      /media_generations_proposal_uq/.test(String((error as { cause?: unknown }).cause ?? error))
    ) {
      throw new ContentError("this has already been generated, or is being generated now", 409);
    }
    throw error;
  }

  let charged = 0;
  const label = mediaDisclosureLabel(
    target.kind === "post" ? "post" : "video",
    `generated_${media}`,
  );
  const dir = path.join(os.tmpdir(), `syb-generate-${randomBytes(8).toString("hex")}`);
  const settle = async (status: "generated" | "failed", extra: Record<string, unknown>) => {
    await db
      .update(mediaGenerations)
      .set({ status, cost_minor: charged, finished_at: new Date().toISOString(), ...extra })
      .where(eq(mediaGenerations.id, claimId));
  };
  const fail = async (sentence: string): Promise<GenerationOutcome> => {
    const cost = money(charged, GENERATION_CURRENCY);
    await settle("failed", { error: sentence });
    await recordExecution({
      proposalId: proposal.id,
      result: { generated: false, error: sentence, cost },
    });
    console.error(
      JSON.stringify({
        event: "media_generation_failed",
        account_id: accountId,
        generation_id: claimId,
        provider: provider.id,
        cost_minor: charged,
        currency: GENERATION_CURRENCY,
      }),
    );
    return {
      status: "failed",
      cost,
      note: `Generating failed: ${sentence}. ${format(cost)} was charged.`,
    };
  };

  try {
    const request: GenerationRequest = {
      media,
      prompt,
      instruction: FIXED_INSTRUCTION,
      aspect: media === "image" ? "4:5" : "9:16",
      ...(seconds ? { seconds } : {}),
      account_id: accountId,
    };
    let output: Awaited<ReturnType<MediaProvider["generate"]>> | null = null;
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
      await db
        .update(mediaGenerations)
        .set({ attempts: attempt, cost_minor: null })
        .where(eq(mediaGenerations.id, claimId));
      if (attempt > 1) {
        // Each attempt re-checks the caps, this run's own charges included.
        const room = await capRoom({ accountId, targetItemId: target.id, now });
        const roomNow = {
          ...room,
          item_spent: money(
            room.item_spent.amount_minor - estimate.amount_minor + charged,
            GENERATION_CURRENCY,
          ),
          month_spent: money(
            room.month_spent.amount_minor - estimate.amount_minor + charged,
            GENERATION_CURRENCY,
          ),
        };
        const stop = capRefusal(roomNow, estimate);
        if (stop) return await fail(`a retry ${stop}`);
      }
      try {
        output = await provider.generate(request);
        if (output.cost.currency !== GENERATION_CURRENCY) {
          return await fail(
            `the provider charged in ${output.cost.currency}, not ${GENERATION_CURRENCY}`,
          );
        }
        charged += output.cost.amount_minor;
        break;
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        if (error.cost && error.cost.currency === GENERATION_CURRENCY) {
          charged += error.cost.amount_minor;
        }
        if (!error.retryable || attempt === MAX_GENERATION_ATTEMPTS) {
          return await fail(error.message);
        }
      }
    }
    if (!output) return await fail("the provider returned nothing");

    const want = media === "image" ? "image/jpeg" : "video/mp4";
    if (output.content_type !== want || output.bytes.byteLength === 0) {
      return await fail(`the provider returned ${output.content_type}, not ${want}`);
    }

    // Rule 17, in the file: stamped here, read back, or refused.
    await fs.mkdir(dir, { recursive: true });
    let file: string;
    if (media === "image") {
      const stamped = stampJpeg(output.bytes, label);
      const read = readJpegLabels(stamped);
      if (!read.generated || !read.comments.includes(label)) {
        return await fail("the image couldn't be labelled as generated");
      }
      file = path.join(dir, "generated.jpg");
      await fs.writeFile(file, stamped);
    } else {
      const raw = path.join(dir, "raw.mp4");
      await fs.writeFile(raw, output.bytes);
      file = await stampVideo(raw, path.join(dir, "generated.mp4"), label);
      if ((await readVideoComment(file)) !== label) {
        return await fail("the clip couldn't be labelled as generated");
      }
    }

    const cost = money(charged, GENERATION_CURRENCY);
    const placed = await placeMedia({
      target,
      file,
      source: {
        kind: "generated",
        media,
        generation_id: claimId,
        proposal_id: proposal.id,
        provider: provider.id,
        model: output.model,
        cost,
        prompt_sha256: promptHash(prompt),
      },
      store,
      ...(args.limitLlm ? { limitLlm: args.limitLlm } : {}),
      now,
    });
    await settle("generated", { result_item_id: placed.item.id });
    await recordExecution({
      proposalId: proposal.id,
      result: { generated: true, item_id: placed.item.id, media, cost, model: output.model },
    });
    console.log(
      JSON.stringify({
        event: "media_generated",
        account_id: accountId,
        generation_id: claimId,
        provider: provider.id,
        model: output.model,
        media,
        cost_minor: charged,
        currency: GENERATION_CURRENCY,
        item_id: placed.item.id,
      }),
    );
    const proposed = placed.publishing.created.length > 0;
    const skipped = placed.publishing.skipped[0]?.reason;
    return {
      status: "generated",
      item_id: placed.item.id,
      cost,
      note: `Generated for ${format(cost)}, labelled as AI-generated.${
        proposed
          ? " Its publish proposal is in your queue."
          : skipped
            ? ` Not proposed for publishing yet: ${skipped}.`
            : ""
      }`,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "media_generation_error",
        account_id: accountId,
        generation_id: claimId,
        ...logSafeError(error),
      }),
    );
    return await fail(
      error instanceof ContentError ? error.message : "something went wrong on our side",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* ── what /content shows ── */

export interface GenerationView {
  /** Null = it can be proposed; otherwise why not. */
  refusal: string | null;
  estimates: { image: Money | null; video: Money | null };
  latest: {
    status: string;
    media: string;
    cost: Money | null;
    error: string | null;
    result_item_id: string | null;
  } | null;
  /** An approved generation proposal waiting for "Generate it". */
  approved_proposal_id: string | null;
  pending_proposal_id: string | null;
}

export async function generationView(
  profileId: string,
  items: readonly ContentItemRow[],
  setup: GenerationSetup = generationSetup(),
): Promise<{
  setup: { available: boolean; reason: string | null };
  items: Record<string, GenerationView>;
}> {
  const out: Record<string, GenerationView> = {};
  const targets = items.filter((i) => mediaTargetRefusal(i) === null);
  if (targets.length === 0) {
    return { setup: { available: setup.provider !== null, reason: setup.reason }, items: out };
  }
  const ids = targets.map((t) => t.id);
  const [gens, props] = await Promise.all([
    db
      .select()
      .from(mediaGenerations)
      .where(inArray(mediaGenerations.target_item_id, ids))
      .orderBy(sql`${mediaGenerations.created_at} desc`),
    db
      .select({
        id: proposals.id,
        status: proposals.status,
        finding: proposals.originating_finding,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.profile_id, profileId),
          inArray(proposals.status, ["pending", "approved"]),
          inArray(
            proposals.originating_finding,
            ids.map((id) => `generate:${id}`),
          ),
        ),
      ),
  ]);
  const p = setup.provider;
  // Rule 15: while the watch runs nothing is proposed — the screen says so instead of offering it.
  const watching = await contentWatchUntil(profileId);
  const estimates = {
    image: p ? p.estimate({ media: "image" }) : null,
    video: p ? p.estimate({ media: "video", seconds: GENERATED_CLIP_SECONDS }) : null,
  };
  for (const item of targets) {
    const g = gens.find((x) => x.target_item_id === item.id);
    const mine = props.filter((x) => x.finding === `generate:${item.id}`);
    out[item.id] = {
      refusal: !p
        ? setup.reason
        : ((await generationRefusal(item)) ??
          (watching
            ? `I'm still watching the business until ${watching}, and propose nothing before then`
            : null)),
      estimates,
      latest: g
        ? {
            status: g.status,
            media: g.media,
            cost: g.cost_minor === null ? null : money(g.cost_minor, g.currency),
            error: g.error,
            result_item_id: g.result_item_id,
          }
        : null,
      approved_proposal_id: mine.find((x) => x.status === "approved")?.id ?? null,
      pending_proposal_id: mine.find((x) => x.status === "pending")?.id ?? null,
    };
  }
  return { setup: { available: p !== null, reason: setup.reason }, items: out };
}
