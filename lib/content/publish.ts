// Publish proposals — P3-21a (Session D, layer D2), rule 12.
//
// The owner approves the finished item, not just the plan: the calendar
// proposal (P3-15) was approved before a word was drafted, so every
// drafted item headed for a connected Meta asset gets its OWN proposal,
// carrying what will go out, where, and when. Approving it is the
// recorded human approval the publish path will execute under.
//
// What this does NOT do: send anything. The proposal names its item,
// platform and target and carries no pre-bound execution plan; since
// P3-21b the due runner routes an approved one to the Meta executor
// through lib/content/publishing's publishPlan, which picks the op from
// the item itself. Nothing here calls Meta.
//
// Which items qualify is data, not code (rule 4): the item's channel has
// a `platform` field from the channel_platform vocabulary, and
// PUBLISH_PLATFORMS says which of those values Meta publishing serves and
// what each needs. Every item that doesn't qualify carries a reason the
// queue shows, in the owner's words.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, contentItems } from "../../db/schema";
import { activeExecutionConnection, executionSecret } from "../execution/connections";
import { parseMetaExecutionCredential } from "../execution/providers/meta";
import { parseTikTokCredential } from "../execution/providers/tiktok";
import { ensureTimezone } from "../hours/timezone";
import { readCurrentField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import {
  checkHardLimits,
  ensureHardLimits,
  limitCaption,
  liveLimitLlm,
} from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal } from "../proposals/service";
import { suppressedKinds } from "../trust/suppression";
import { enumCode } from "../core/enum-value";
import { mediaOf } from "./media-item";
import type { PublishBlock } from "./publish-words";
import { ZONE_UNKNOWN, blockWords } from "./publish-words";

export const PUBLISH_KIND = "content_publishing";
/** The local hour a publish proposal posts at unless the owner picks another (P3-21a). */
export const DEFAULT_POSTING_HOUR = 10;
export const PUBLISH_EXPIRY_DAYS = 14;
export const PUBLISH_UNDO = "ScaleX deletes the post; Meta keeps no copy.";
/**
 * 2026-11-08: TikTok's API has no delete, so a TikTok post is labelled
 * irreversible ("hard") before approval and says how it comes down.
 */
export const TIKTOK_PUBLISH_UNDO =
  "TikTok doesn't let apps delete a post, so ScaleX can't take it down: delete it in the TikTok app.";

export type PublishPlatform = "facebook" | "instagram" | "tiktok";

/** channel_platform vocabulary value → what publishing needs for it (Meta, and TikTok since 2026-11-08). */
export const PUBLISH_PLATFORMS: Readonly<
  Record<
    PublishPlatform,
    { label: string; target: "page_id" | "ig_user_id" | "open_id"; needs_media: boolean }
  >
> = {
  facebook: { label: "Facebook", target: "page_id", needs_media: false },
  instagram: { label: "Instagram", target: "ig_user_id", needs_media: true },
  tiktok: { label: "TikTok", target: "open_id", needs_media: true },
};

/** The connected TikTok account's id (2026-11-08). */
export interface TikTokAssets {
  open_id: string;
}

/** Item kinds that are published as posts. Shot lists are filmed; emails are sent elsewhere. */
const PUBLISHABLE_KINDS: ReadonlySet<string> = new Set(["post", "video"]);

export interface MetaAssets {
  page_id: string;
  ig_user_id: string | null;
}

export interface PublishTarget {
  page_id?: string;
  ig_user_id?: string;
  open_id?: string;
}

export interface ReadinessItem {
  kind: string;
  status: string;
  channel_label: string;
  scheduled_for: string | null;
  media_path: string | null;
  publish_proposal_id: string | null;
}

export type Readiness =
  { ok: true; platform: PublishPlatform; target: PublishTarget } | { ok: false; reason: string };

type Check =
  | { ok: true; platform: PublishPlatform; target: PublishTarget }
  | { ok: false; block: PublishBlock };

/** A refusal as its code and values (L-4c). */
function no(code: PublishBlock["code"], values?: PublishBlock["values"]): Check {
  return { ok: false, block: values ? { code, values } : { code } };
}

type ReadinessArgs = {
  item: ReadinessItem;
  platform: string | null;
  assets: MetaAssets | null;
  /** The connected TikTok account, when there is one. */
  tiktok?: TikTokAssets | null;
  zone: string | null;
  zoneReason?: string;
};

/**
 * Pure: can this item get a publish proposal, and if not, why not — in
 * the words the queue shows. `platform` is the channel's vocabulary value.
 */
export function publishReadiness(args: ReadinessArgs): Readiness {
  const c = check(args);
  return c.ok ? c : { ok: false, reason: blockWords(c.block) };
}

/** L-4c: why not, as a code and its values (lib/content/publish-words); null when it qualifies. */
export function publishBlockOf(args: ReadinessArgs): PublishBlock | null {
  const c = check(args);
  return c.ok ? null : c.block;
}

function check(args: ReadinessArgs): Check {
  const { item, platform, assets } = args;
  if (item.publish_proposal_id !== null) return no("proposed");
  if (item.status !== "drafted") return no("notDraft", { status: item.status });
  if (item.kind === "shot_list") return no("shotList");
  if (item.kind === "email") return no("email");
  if (!PUBLISHABLE_KINDS.has(item.kind)) return no("kind", { kind: item.kind });
  if (platform === null || !Object.prototype.hasOwnProperty.call(PUBLISH_PLATFORMS, platform)) {
    return no("channel", { channel: item.channel_label });
  }
  const spec = PUBLISH_PLATFORMS[platform as PublishPlatform];
  if (platform === "tiktok") {
    // TikTok takes videos only (Direct Post, FILE_UPLOAD).
    const tiktok = args.tiktok ?? null;
    if (tiktok === null) return no("connectTikTok");
    if (item.media_path === null || !/\.(mp4|mov|webm)$/i.test(item.media_path)) {
      return no("tiktokNeedsVideo");
    }
    if (item.scheduled_for === null) return no("noDate");
    if (args.zone === null) return no("zone", { reason: args.zoneReason ?? ZONE_UNKNOWN });
    return { ok: true, platform: "tiktok", target: { open_id: tiktok.open_id } };
  }
  if (assets === null) return no("connect", { platform: spec.label });
  const id = spec.target === "page_id" ? assets.page_id : assets.ig_user_id;
  if (id === null) return no("noInstagram");
  if (spec.needs_media && item.media_path === null)
    return no("needsMedia", { platform: spec.label });
  if (platform === "instagram" && item.media_path !== null && /\.png$/i.test(item.media_path)) {
    return no("png");
  }
  if (item.scheduled_for === null) return no("noDate");
  if (args.zone === null) return no("zone", { reason: args.zoneReason ?? ZONE_UNKNOWN });
  return { ok: true, platform: platform as PublishPlatform, target: { [spec.target]: id } };
}

function localMs(at: Date, zone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
}

/** Pure: the instant at which a local date and hour occur in a zone (DST-aware). */
export function zonedInstant(date: string, hour: number, zone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wanted = Date.UTC(y, m - 1, d, hour, 0, 0);
  let guess = wanted;
  for (let i = 0; i < 3; i++) guess = wanted - (localMs(new Date(guess), zone) - guess);
  return new Date(guess);
}

/** The connected Meta publishing assets for an account, ids only, or null. */
export async function metaAssets(accountId: string): Promise<MetaAssets | null> {
  const row = await activeExecutionConnection(accountId, "meta_publish");
  if (!row || row.status !== "connected") return null;
  const cred = parseMetaExecutionCredential(executionSecret(row), "meta_publish");
  return cred.page_id === null ? null : { page_id: cred.page_id, ig_user_id: cred.ig_user_id };
}

/** The connected TikTok posting account for an account, id only, or null (2026-11-08). */
export async function tiktokAssets(accountId: string): Promise<TikTokAssets | null> {
  const row = await activeExecutionConnection(accountId, "tiktok_publish");
  if (!row || row.status !== "connected") return null;
  return { open_id: parseTikTokCredential(executionSecret(row)).open_id };
}

/** The channel_platform value behind an item, from the planned slot's channel. */
async function itemPlatform(profileId: string, provenance: unknown): Promise<string | null> {
  const channelId = (provenance as { item?: { channel_id?: unknown } } | null)?.item?.channel_id;
  if (typeof channelId !== "string") return null;
  const field = await readCurrentField<unknown>(profileId, `channels.${channelId}.platform`);
  return enumCode(field?.value);
}

function evidenceOf(provenance: unknown): string[] {
  const e = (provenance as { evidence?: unknown } | null)?.evidence;
  return Array.isArray(e) ? e.filter((x): x is string => typeof x === "string") : [];
}

export interface PublishRun {
  created: ProposalRow[];
  skipped: { item_id: string; reason: string }[];
  /** L-4c: each skipped item's reason as its code and values, for saying it in the reader's language. */
  blocks?: Record<string, PublishBlock>;
}

function skip(out: PublishRun, itemId: string, block: PublishBlock): void {
  out.skipped.push({ item_id: itemId, reason: blockWords(block) });
  out.blocks = { ...out.blocks, [itemId]: block };
}

/**
 * One publish proposal per qualifying drafted item, linked back on the
 * item. Idempotent: an item that already has one is skipped. Hard limits
 * (13.5) and suppression (P3-28) apply as to every proposal.
 */
export async function proposePublishing(
  profileId: string,
  itemIds: readonly string[],
  opts: { now?: Date; limitLlm?: LimitLlm; postingHour?: number } = {},
): Promise<PublishRun> {
  const out: PublishRun = { created: [], skipped: [], blocks: {} };
  if (itemIds.length === 0) return out;
  const now = opts.now ?? new Date();
  const hour = opts.postingHour ?? DEFAULT_POSTING_HOUR;

  const items = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.profile_id, profileId), inArray(contentItems.id, [...itemIds])));
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  const assets = profile ? await metaAssets(profile.account_id) : null;
  const tiktok = profile ? await tiktokAssets(profile.account_id) : null;
  const tz = await ensureTimezone(profileId);
  const zone = tz.zone;

  let limitsChecked = false;
  let blockedBy: string | null = null;
  const suppression = (await suppressedKinds(profileId)).get(PUBLISH_KIND);

  for (const item of items) {
    const ready = check({
      item,
      platform: await itemPlatform(profileId, item.provenance),
      assets,
      tiktok,
      zone,
      ...(tz.zone === null ? { zoneReason: tz.reason } : {}),
    });
    if (!ready.ok) {
      skip(out, item.id, ready.block);
      continue;
    }
    if (suppression) {
      skip(out, item.id, { code: "declined", values: { count: suppression.rejections } });
      continue;
    }
    const date = item.scheduled_for as string;
    const publishAt = zonedInstant(date, hour, zone as string);
    if (publishAt.getTime() <= now.getTime()) {
      skip(out, item.id, { code: "passed", values: { date } });
      continue;
    }
    if (!limitsChecked) {
      const { limits } = await ensureHardLimits(profileId, opts.limitLlm ?? liveLimitLlm);
      const verdict = checkHardLimits(limits, PUBLISH_KIND);
      blockedBy = verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null;
      limitsChecked = true;
    }

    const spec = PUBLISH_PLATFORMS[ready.platform];
    const isTikTok = ready.platform === "tiktok";
    const hh = `${String(hour).padStart(2, "0")}:00`;
    const evidence = evidenceOf(item.provenance);
    const expires = Math.min(now.getTime() + PUBLISH_EXPIRY_DAYS * 86_400_000, publishAt.getTime());
    const row = await createProposal({
      profile_id: profileId,
      module: "content",
      originating_finding: `publish:${item.id}`,
      action: {
        kind: PUBLISH_KIND,
        summary: `Publish "${item.title}" to ${spec.label} on ${date} at ${hh}`,
        detail: {
          item_id: item.id,
          platform: ready.platform,
          target: ready.target,
          posting_hour: hour,
          zone,
          publish_at: publishAt.toISOString(),
          disclosure: item.disclosure,
          evidence,
          // TikTok's AI-generated content label goes on generated clips (rule 17).
          ...(isTikTok ? { is_aigc: mediaOf(item.provenance)?.is_ai_generated === true } : {}),
        },
      },
      scenario: {
        assumptions: [
          {
            statement: `"${item.title}" goes out exactly as you read it here`,
            value: null,
            source_field: evidence[0] ?? null,
            sensitivity: "low",
          },
        ],
        base_case: {
          case: "base",
          statement: `Posted to ${spec.label} on ${date} at ${hh} (${zone}), as drafted, with its AI disclosure.`,
          profit_delta_monthly: null,
          formula: null,
        },
        downside_case: {
          case: "downside",
          statement: isTikTok
            ? "It does nothing you can measure, and ScaleX can't take it down: you'd delete it in the TikTok app."
            : "It does nothing you can measure, and you can withdraw it at any time.",
          profit_delta_monthly: null,
          formula: null,
        },
        upside_case: {
          case: "upside",
          statement:
            "Its reach is measured against your previous posts, so the next calendar learns from it.",
          profit_delta_monthly: null,
          formula: null,
        },
        breakeven_condition: "no spend: the cost is your review time",
      } as never,
      // TikTok's API has no delete: labelled irreversible BEFORE approval (rule 16).
      reversibility: isTikTok
        ? { level: "hard", if_you_change_your_mind: TIKTOK_PUBLISH_UNDO }
        : { level: "easy", if_you_change_your_mind: PUBLISH_UNDO },
      expires_at: new Date(expires).toISOString(),
      blocked_by_limit: blockedBy,
    });
    await db
      .update(contentItems)
      .set({ publish_proposal_id: row.id })
      .where(eq(contentItems.id, item.id));
    out.created.push(row);
  }
  return out;
}

/** True for a per-item publish proposal (it names an item), false for a calendar plan. */
export function isPublishProposal(action: unknown): boolean {
  const detail = (action as { kind?: unknown; detail?: { item_id?: unknown } } | null) ?? null;
  return detail?.kind === PUBLISH_KIND && typeof detail.detail?.item_id === "string";
}

/** The queue's "why not" line for each drafted item that has no publish proposal and can't get one. */
export async function publishNotes(
  profileId: string,
  items: readonly (ReadinessItem & { id: string; provenance: unknown })[],
): Promise<Record<string, string>> {
  const blocks = await publishBlocks(profileId, items);
  return Object.fromEntries(Object.entries(blocks).map(([id, b]) => [id, blockWords(b)]));
}

/** L-4c: the same "why not", as each item's code and values — said in the reader's language by the route. */
export async function publishBlocks(
  profileId: string,
  items: readonly (ReadinessItem & { id: string; provenance: unknown })[],
): Promise<Record<string, PublishBlock>> {
  const drafted = items.filter((i) => i.status === "drafted" && i.publish_proposal_id === null);
  if (drafted.length === 0) return {};
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  const assets = profile ? await metaAssets(profile.account_id) : null;
  const tiktok = profile ? await tiktokAssets(profile.account_id) : null;
  const tz = await ensureTimezone(profileId);
  const notes: Record<string, PublishBlock> = {};
  for (const item of drafted) {
    const block = publishBlockOf({
      item,
      platform: await itemPlatform(profileId, item.provenance),
      assets,
      tiktok,
      zone: tz.zone,
      ...(tz.zone === null ? { zoneReason: tz.reason } : {}),
    });
    if (block) notes[item.id] = block;
  }
  return notes;
}
