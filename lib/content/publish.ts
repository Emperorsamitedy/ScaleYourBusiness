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

export const PUBLISH_KIND = "content_publishing";
/** The local hour a publish proposal posts at unless the owner picks another (P3-21a). */
export const DEFAULT_POSTING_HOUR = 10;
export const PUBLISH_EXPIRY_DAYS = 14;
export const PUBLISH_UNDO = "SYB deletes the post; Meta keeps no copy.";

export type PublishPlatform = "facebook" | "instagram";

/** channel_platform vocabulary value → what Meta publishing needs for it. */
export const PUBLISH_PLATFORMS: Readonly<
  Record<PublishPlatform, { label: string; target: "page_id" | "ig_user_id"; needs_media: boolean }>
> = {
  facebook: { label: "Facebook", target: "page_id", needs_media: false },
  instagram: { label: "Instagram", target: "ig_user_id", needs_media: true },
};

/** Item kinds that are published as posts. Shot lists are filmed; emails are sent elsewhere. */
const PUBLISHABLE_KINDS: ReadonlySet<string> = new Set(["post", "video"]);

export interface MetaAssets {
  page_id: string;
  ig_user_id: string | null;
}

export interface PublishTarget {
  page_id?: string;
  ig_user_id?: string;
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

/**
 * Pure: can this item get a publish proposal, and if not, why not — in
 * the words the queue shows. `platform` is the channel's vocabulary value.
 */
export function publishReadiness(args: {
  item: ReadinessItem;
  platform: string | null;
  assets: MetaAssets | null;
  zone: string | null;
  zoneReason?: string;
}): Readiness {
  const { item, platform, assets } = args;
  if (item.publish_proposal_id !== null)
    return { ok: false, reason: "already proposed for publishing" };
  if (item.status !== "drafted") return { ok: false, reason: `it is ${item.status}, not a draft` };
  if (item.kind === "shot_list")
    return { ok: false, reason: "a shot list is for filming, not publishing" };
  if (item.kind === "email") return { ok: false, reason: "emails aren't sent through SYB yet" };
  if (!PUBLISHABLE_KINDS.has(item.kind))
    return { ok: false, reason: `a ${item.kind} isn't published` };
  if (platform === null || !Object.prototype.hasOwnProperty.call(PUBLISH_PLATFORMS, platform)) {
    return {
      ok: false,
      reason: `SYB can't publish to ${item.channel_label} — only to a Facebook Page or Instagram account you connect`,
    };
  }
  const spec = PUBLISH_PLATFORMS[platform as PublishPlatform];
  if (assets === null) {
    return {
      ok: false,
      reason: `connect Meta publishing on Connections to publish this to ${spec.label}`,
    };
  }
  const id = spec.target === "page_id" ? assets.page_id : assets.ig_user_id;
  if (id === null) {
    return {
      ok: false,
      reason:
        "the Meta connection has no Instagram account — reconnect with its id to publish there",
    };
  }
  if (spec.needs_media && item.media_path === null) {
    return {
      ok: false,
      reason: `${spec.label} needs an image or a video, and this item has none yet`,
    };
  }
  if (platform === "instagram" && item.media_path !== null && /\.png$/i.test(item.media_path)) {
    return {
      ok: false,
      reason: "Instagram takes JPEG images only, and this item's image is a PNG",
    };
  }
  if (item.scheduled_for === null) return { ok: false, reason: "it has no date to go out on" };
  if (args.zone === null) {
    return {
      ok: false,
      reason: `the posting time can't be set: ${args.zoneReason ?? "the business's timezone isn't known"}`,
    };
  }
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
  const out: PublishRun = { created: [], skipped: [] };
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
  const tz = await ensureTimezone(profileId);
  const zone = tz.zone;

  let limitsChecked = false;
  let blockedBy: string | null = null;
  const suppression = (await suppressedKinds(profileId)).get(PUBLISH_KIND);

  for (const item of items) {
    const ready = publishReadiness({
      item,
      platform: await itemPlatform(profileId, item.provenance),
      assets,
      zone,
      ...(tz.zone === null ? { zoneReason: tz.reason } : {}),
    });
    if (!ready.ok) {
      out.skipped.push({ item_id: item.id, reason: ready.reason });
      continue;
    }
    if (suppression) {
      out.skipped.push({
        item_id: item.id,
        reason: `you've declined publishing ${suppression.rejections} times — I've stopped proposing it`,
      });
      continue;
    }
    const date = item.scheduled_for as string;
    const publishAt = zonedInstant(date, hour, zone as string);
    if (publishAt.getTime() <= now.getTime()) {
      out.skipped.push({ item_id: item.id, reason: `its date (${date}) has passed` });
      continue;
    }
    if (!limitsChecked) {
      const { limits } = await ensureHardLimits(profileId, opts.limitLlm ?? liveLimitLlm);
      const verdict = checkHardLimits(limits, PUBLISH_KIND);
      blockedBy = verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null;
      limitsChecked = true;
    }

    const spec = PUBLISH_PLATFORMS[ready.platform];
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
          statement: "It does nothing you can measure — and you can withdraw it at any time.",
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
        breakeven_condition: "no spend — the cost is your review time",
      } as never,
      reversibility: { level: "easy", if_you_change_your_mind: PUBLISH_UNDO },
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
  const drafted = items.filter((i) => i.status === "drafted" && i.publish_proposal_id === null);
  if (drafted.length === 0) return {};
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  const assets = profile ? await metaAssets(profile.account_id) : null;
  const tz = await ensureTimezone(profileId);
  const notes: Record<string, string> = {};
  for (const item of drafted) {
    const ready = publishReadiness({
      item,
      platform: await itemPlatform(profileId, item.provenance),
      assets,
      zone: tz.zone,
      ...(tz.zone === null ? { zoneReason: tz.reason } : {}),
    });
    if (!ready.ok) notes[item.id] = ready.reason;
  }
  return notes;
}
