// Matching a provider's items to the owner's profile — P2-15 (products),
// P2-18 (channels).
//
// A store's products and the owner's offers are two lists describing the
// same things in different words; so are an analytics property's traffic
// channels and the owner's sales channels. The system SUGGESTS matches
// with plain arithmetic (no model call: CLAUDE.md's cost rule), the OWNER
// confirms each one, and a confirmed match is stored as a fact whose
// source is the owner (rule 2), under
//
//   offers.<offer_id>.product_ref.<provider>
//   channels.<channel_id>.channel_ref.<provider>
//
// "No match" is a recorded answer too (status not_applicable), so an
// unmapped entity or item stays a visible gap, never a guess.
//
// Facts supersede like any other (rule 3): changing a match keeps the old
// one in history, and derivations read the current one, so a correction
// takes effect on the next derivation without re-reading the provider.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, channels, offers } from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { readCurrentField, writeField } from "../profile/field-store";
import type { ExternalItem, Provider } from "./provider";
import { getProvider } from "./registry";
import { decryptSecret } from "./secrets";
import { isProviderId } from "./scopes";
import { ConnectorError, ownedConnection } from "./service";

export type MappingKind = "product" | "channel";

/** What a provider's items map onto, or null for providers with nothing to match. */
export function mappingKindFor(provider: Provider): MappingKind | null {
  if (provider.listProducts !== undefined) return "product";
  if (provider.listChannels !== undefined) return "channel";
  return null;
}

const SPINE: Readonly<Record<MappingKind, "offers" | "channels">> = {
  product: "offers",
  channel: "channels",
};

const REF_FIELD: Readonly<Record<MappingKind, "product_ref" | "channel_ref">> = {
  product: "product_ref",
  channel: "channel_ref",
};

/** The fact key holding an entity's confirmed match on one provider. */
export function mappingKey(
  entityId: string,
  provider: string,
  kind: MappingKind = "product",
): string {
  return `${SPINE[kind]}.${entityId}.${REF_FIELD[kind]}.${provider}`;
}

/** What a confirmed match stores. label_raw makes the fact sheet show the title. */
export interface MappedProduct {
  product_ref: string;
  label_raw: string;
}

export interface MappedChannel {
  channel_ref: string;
  label_raw: string;
}

/* ── suggestions: products by name ── */

export function normaliseTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * 1 for the same name once normalised, including when only spacing differs
 * ("500ml" and "500 ml"); otherwise shared words ÷ all words.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normaliseTitle(a);
  const nb = normaliseTitle(b);
  if (na === "" || nb === "") return 0;
  if (na === nb || na.replace(/ /g, "") === nb.replace(/ /g, "")) return 1;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let shared = 0;
  for (const word of ta) if (tb.has(word)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/* ── suggestions: channels by kind ── */

/**
 * Which of the owner's channel types and platforms (the question bank's
 * channel_type and channel_platform vocabularies) a GA4 default channel
 * group describes. A matching type is worth 0.6, a matching platform 0.4.
 */
const CHANNEL_GROUPS: Readonly<Record<string, { types: string[]; platforms: string[] }>> = {
  Direct: { types: ["website"], platforms: ["own_website"] },
  "Organic Search": { types: ["website"], platforms: ["google_search", "own_website"] },
  "Paid Search": { types: ["paid_ads"], platforms: ["google_ads"] },
  "Paid Shopping": { types: ["paid_ads"], platforms: ["google_ads"] },
  Display: { types: ["paid_ads"], platforms: ["google_ads"] },
  "Paid Social": { types: ["paid_ads"], platforms: ["meta_ads", "tiktok_ads"] },
  "Paid Video": { types: ["paid_ads"], platforms: ["youtube"] },
  "Organic Social": {
    types: ["social_organic"],
    platforms: ["instagram", "tiktok", "facebook", "linkedin", "pinterest"],
  },
  "Organic Video": { types: ["social_organic"], platforms: ["youtube", "tiktok"] },
  Email: { types: ["email"], platforms: [] },
  SMS: { types: ["direct_message"], platforms: ["whatsapp", "messenger"] },
  Referral: { types: ["referrals", "partners"], platforms: [] },
  Affiliates: { types: ["partners", "resellers"], platforms: [] },
  "Organic Shopping": { types: ["marketplace"], platforms: [] },
};

export function channelSimilarity(
  group: string,
  type: string | null,
  platform: string | null,
): number {
  const spec = CHANNEL_GROUPS[group];
  if (!spec || type === null || !spec.types.includes(type)) return 0;
  return 0.6 + (platform !== null && spec.platforms.includes(platform) ? 0.4 : 0);
}

export const SUGGESTION_THRESHOLD = 0.5;

/** An entity on the owner's side, with what suggestions can go on. */
export interface MatchableEntity {
  entity_id: string;
  name: string;
  type?: string | null;
  platform?: string | null;
}

export interface Suggestion {
  entity_id: string;
  item: ExternalItem;
  score: number;
}

function similarity(kind: MappingKind, entity: MatchableEntity, item: ExternalItem): number {
  return kind === "product"
    ? titleSimilarity(entity.name, item.title)
    : channelSimilarity(item.ref, entity.type ?? null, entity.platform ?? null);
}

/**
 * Best one-to-one suggestions at or above the threshold, strongest first,
 * each entity and each item used at most once. Deterministic.
 */
export function suggestMatches(
  entities: readonly MatchableEntity[],
  items: readonly ExternalItem[],
  kind: MappingKind = "product",
): Suggestion[] {
  const pairs: Suggestion[] = [];
  for (const entity of entities) {
    for (const item of items) {
      const score = similarity(kind, entity, item);
      if (score >= SUGGESTION_THRESHOLD) pairs.push({ entity_id: entity.entity_id, item, score });
    }
  }
  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0) ||
      (a.item.ref < b.item.ref ? -1 : a.item.ref > b.item.ref ? 1 : 0),
  );
  const usedEntities = new Set<string>();
  const usedItems = new Set<string>();
  const out: Suggestion[] = [];
  for (const pair of pairs) {
    if (usedEntities.has(pair.entity_id) || usedItems.has(pair.item.ref)) continue;
    usedEntities.add(pair.entity_id);
    usedItems.add(pair.item.ref);
    out.push(pair);
  }
  return out;
}

/* ── the view ── */

export interface EntityMappingRow {
  entity_id: string;
  name: string;
  /** The owner's confirmed match, if any. */
  mapped: { ref: string; label_raw: string } | null;
  /** The owner said none of the provider's items is this entity. */
  no_match: boolean;
  /** Only for entities the owner hasn't answered yet. */
  suggestion: { ref: string; title: string; score: number } | null;
}

export interface MappingView {
  connection_id: string;
  provider: string;
  label: string;
  kind: MappingKind;
  /** "offer" | "channel" — what the owner's rows are called. */
  entity_noun: string;
  /** "product" | "traffic channel" — what the provider's items are called. */
  item_noun: string;
  entities: EntityMappingRow[];
  items: ExternalItem[];
  /** Provider items no entity is matched to: a gap, shown as one. */
  unmapped_items: ExternalItem[];
}

async function profileFor(accountId: string): Promise<string> {
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, accountId));
  if (!profile) throw new ConnectorError("this account has no business profile yet", 409);
  return profile.id;
}

async function context(accountId: string, connectionId: string) {
  const conn = await ownedConnection(accountId, connectionId);
  if (!isProviderId(conn.provider)) throw new ConnectorError("unknown provider", 400);
  const provider = getProvider(conn.provider);
  const kind = mappingKindFor(provider);
  if (kind === null) {
    throw new ConnectorError(`${provider.label} has nothing to match`, 400);
  }
  if (conn.status === "disconnected" || conn.encrypted_secret === null) {
    throw new ConnectorError(`reconnect ${provider.label} to match its ${kind}s`, 409);
  }
  const secret = decryptSecret(conn.encrypted_secret);
  const items =
    kind === "product"
      ? await provider.listProducts!(secret)
      : await provider.listChannels!(secret);
  return { conn, provider, kind, items };
}

const asCode = (v: unknown): string | null => {
  if (typeof v === "string" && v !== "") return v;
  if (v !== null && typeof v === "object" && typeof (v as { code?: unknown }).code === "string") {
    return (v as { code: string }).code;
  }
  return null;
};

const words = (code: string | null): string | null =>
  code === null ? null : code.replace(/_/g, " ");

interface EntityState extends MatchableEntity {
  mapped: { ref: string; label_raw: string } | null;
  no_match: boolean;
}

async function entityRows(
  profileId: string,
  providerId: string,
  kind: MappingKind,
): Promise<EntityState[]> {
  const table = kind === "product" ? offers : channels;
  const spine = await db
    .select({ id: table.id })
    .from(table)
    .where(eq(table.profile_id, profileId))
    .orderBy(table.created_at);
  const refField = REF_FIELD[kind];
  const rows: EntityState[] = [];
  for (const { id } of spine) {
    const mapping = await readCurrentField<unknown>(profileId, mappingKey(id, providerId, kind));
    const value = mapping?.value as Record<string, unknown> | null | undefined;
    const ref = value?.[refField];
    const mapped =
      mapping?.status === "answered" && typeof ref === "string"
        ? { ref, label_raw: String(value?.["label_raw"] ?? "") }
        : null;
    const no_match = mapping?.status === "not_applicable";

    if (kind === "product") {
      const name = await readCurrentField<unknown>(profileId, `offers.${id}.name`);
      rows.push({
        entity_id: id,
        name: typeof name?.value === "string" && name.value !== "" ? name.value : "Unnamed offer",
        mapped,
        no_match,
      });
    } else {
      const type = asCode(
        (await readCurrentField<unknown>(profileId, `channels.${id}.type`))?.value,
      );
      const platform = asCode(
        (await readCurrentField<unknown>(profileId, `channels.${id}.platform`))?.value,
      );
      const name =
        [words(type), words(platform)].filter((w): w is string => w !== null).join(" · ") ||
        "Channel";
      rows.push({ entity_id: id, name, type, platform, mapped, no_match });
    }
  }
  return rows;
}

export async function mappingView(accountId: string, connectionId: string): Promise<MappingView> {
  const { conn, provider, kind, items } = await context(accountId, connectionId);
  const profileId = await profileFor(accountId);
  const rows = await entityRows(profileId, conn.provider, kind);

  const mappedRefs = new Set(rows.flatMap((r) => (r.mapped ? [r.mapped.ref] : [])));
  const open = rows.filter((r) => r.mapped === null && !r.no_match);
  const available = items.filter((i) => !mappedRefs.has(i.ref));
  const suggestions = new Map(suggestMatches(open, available, kind).map((s) => [s.entity_id, s]));

  return {
    connection_id: conn.id,
    provider: conn.provider,
    label: provider.label,
    kind,
    entity_noun: kind === "product" ? "offer" : "channel",
    item_noun: kind === "product" ? "product" : "traffic channel",
    entities: rows.map((r) => {
      const s = suggestions.get(r.entity_id);
      return {
        entity_id: r.entity_id,
        name: r.name,
        mapped: r.mapped,
        no_match: r.no_match,
        suggestion: s
          ? { ref: s.item.ref, title: s.item.title, score: Math.round(s.score * 100) / 100 }
          : null,
      };
    }),
    items,
    unmapped_items: available,
  };
}

/**
 * The owner's answer for one entity: an item from this provider, or null
 * for "none of these". Refuses an item that isn't on the provider's side
 * or is already matched to another entity.
 */
export async function confirmMapping(args: {
  accountId: string;
  connectionId: string;
  entityId: string;
  ref: string | null;
}): Promise<MappingView> {
  const { conn, provider, kind, items } = await context(args.accountId, args.connectionId);
  const profileId = await profileFor(args.accountId);
  const rows = await entityRows(profileId, conn.provider, kind);
  const entity = rows.find((r) => r.entity_id === args.entityId);
  if (!entity)
    throw new ConnectorError(`${kind === "product" ? "offer" : "channel"} not found`, 404);

  const at = isoDateTime(new Date().toISOString());
  const key = fieldId(mappingKey(entity.entity_id, conn.provider, kind));
  if (args.ref === null) {
    await writeField(
      profileId,
      createField<unknown>({
        id: key,
        value: null,
        status: "not_applicable",
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: at,
        recorded_at: at,
        note: `No matching ${kind === "product" ? "product" : "traffic channel"} in ${provider.label}.`,
      }),
    );
    return mappingView(args.accountId, args.connectionId);
  }

  const item = items.find((i) => i.ref === args.ref);
  if (!item) throw new ConnectorError(`that isn't in this ${provider.label} account`, 404);
  const taken = rows.find((r) => r.entity_id !== entity.entity_id && r.mapped?.ref === item.ref);
  if (taken) {
    throw new ConnectorError(`"${item.title}" is already matched to ${taken.name}`, 409);
  }

  await writeField(
    profileId,
    createField<Record<string, string>>({
      id: key,
      value: { [REF_FIELD[kind]]: item.ref, label_raw: item.title },
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note: `Matched to ${provider.label} "${item.title}".`,
    }),
  );
  return mappingView(args.accountId, args.connectionId);
}
