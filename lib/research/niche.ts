// Niche research — P3-50's service: the best businesses' ads, for one
// business, read from Meta's Ad Library and kept as a cache.
//
// What it reads FROM. The owner's own facts: the country (1.1b), what kind
// of business it is (1.2), its strongest offers, and the competitors they
// listed (feature 35). Search terms are derived from those — or are the
// owner's own, typed on the studio screen, which then stick for the next
// read. Branching on the business type is a lookup in a table, not code.
//
// What it never does. It never writes anything anywhere (the reader is GET
// only, rule 9). It never reads outside the Library's coverage: a business
// outside the EU and UK gets a sentence, not a read of political ads. It
// never stores more than the analysis needs (lib/research/ad-library.ts:
// LibraryAd). And it never calls a model — ranking, hooks, offers and calls
// to action are arithmetic and patterns (lib/research/niche-ads.ts).
//
// Caps. One read makes at most AD_LIBRARY_CAPS.max_requests_per_read
// requests and keeps at most max_ads_per_read ads; a read is reused for
// NICHE_CAPS.cache_days, and a fresh one is allowed once a day.

import { and, desc, eq, inArray, isNull, like } from "drizzle-orm";
import { db } from "../../db";
import { withAdvisoryLock } from "../../db/advisory-lock";
import { fieldRecords, nicheAdReads, offers } from "../../db/schema";
import { loadCompetitors } from "../competitors/service";
import { logSafeError } from "../core/log-safe";
import { metaAdLibraryToken } from "../env";
import type { AdLibraryFetch, Coverage, LibraryAd } from "./ad-library";
import {
  AD_LIBRARY_CAPS,
  AD_LIBRARY_SOURCE,
  AdLibraryError,
  adLibraryCoverage,
  createAdLibraryClient,
  parseAd,
} from "./ad-library";
import type { NicheAdGroup } from "./niche-ads";
import { rankNicheAds } from "./niche-ads";

export const NICHE_CAPS = {
  /** Search terms per read. */
  max_terms: 2,
  /** Characters per search term. */
  max_term_chars: 60,
  /** Listed competitors searched by name per read (page ids go in one request). */
  max_competitor_names: 2,
  /** A read is reused this long before the screen offers a fresh one. */
  cache_days: 7,
  /** A fresh read is allowed this often per business. */
  refresh_cooldown_ms: 24 * 60 * 60 * 1000,
  /** Ad concepts shown and handed to the brief. */
  top_groups: 10,
} as const;

/**
 * Business type (vocabulary business_type) → a search term the ads of that
 * niche would carry. Null where the type says nothing an ad would (a web
 * shop sells anything): the offers then supply the terms.
 */
export const NICHE_TERM_BY_TYPE: Readonly<Record<string, string | null>> = {
  retail_shop: null,
  ecommerce_store: null,
  restaurant: "restaurant",
  cafe: "cafe",
  bar: "bar",
  food_production: null,
  salon_beauty: "beauty salon",
  barber: "barber",
  gym_fitness: "gym",
  wellness_spa: "spa",
  clinic_health: "clinic",
  construction: "builder",
  trades_services: null,
  cleaning_services: "cleaning",
  automotive: "car service",
  professional_services: null,
  consulting: "consulting",
  agency_marketing: "marketing agency",
  it_services: "IT support",
  software_saas: "software",
  education_training: "course",
  childcare: "childcare",
  real_estate: "estate agent",
  logistics: "delivery",
  manufacturing: null,
  wholesale: "wholesale",
  agriculture: null,
  events: "events",
  photography_creative: "photographer",
  tourism_accommodation: "holiday",
  transport: null,
  nonprofit: null,
  other: null,
};

/** Offer-name endings that say nothing about the niche ("Starter Kit" → no term). */
const GENERIC_ENDINGS = new Set([
  "set",
  "kit",
  "box",
  "pack",
  "bundle",
  "item",
  "product",
  "service",
  "package",
  "plan",
  "special",
  "deal",
  "offer",
]);

export class NicheError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "NicheError";
    this.status = status;
  }
}

/** Pure: a Facebook page's numeric id from a link the owner listed, when the link carries one. */
export function facebookPageId(raw: string | null): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|web)\./, "");
  if (host !== "facebook.com" && host !== "fb.com") return null;
  const id = url.searchParams.get("id");
  if (url.pathname.startsWith("/profile.php") && id && /^\d{5,}$/.test(id)) return id;
  const tail = /(?:^|[/-])(\d{8,})\/?$/.exec(url.pathname)?.[1];
  return tail ?? null;
}

/** Pure: an owner-typed term, cleaned — or null when nothing usable is left. */
export function cleanTerm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length < 2) return null;
  return t.slice(0, NICHE_CAPS.max_term_chars);
}

/** Pure: the terms the profile suggests — the niche's word, then the strongest offers' last words. */
export function derivedTerms(businessType: string | null, offerNames: readonly string[]): string[] {
  const out: string[] = [];
  const push = (t: string | null) => {
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  push(businessType ? (NICHE_TERM_BY_TYPE[businessType] ?? null) : null);
  for (const name of offerNames) {
    const last = name
      .toLowerCase()
      .split(/[^\p{L}]+/u)
      .filter((w) => w.length >= 3)
      .at(-1);
    if (last && !GENERIC_ENDINGS.has(last)) push(last);
  }
  return out.slice(0, NICHE_CAPS.max_terms);
}

/** Pure: two business names are the same business, loosely ("Saltmarsh Pottery Ltd" ≈ "saltmarsh pottery"). */
export function sameBusiness(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\b(ltd|limited|llc|inc|co|company|kft|gmbh|bt|the)\b/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, "");
  const x = norm(a);
  const y = norm(b);
  return x !== "" && y !== "" && (x === y || x.includes(y) || y.includes(x));
}

/* ── what the profile says ── */

interface Fact {
  value: unknown;
  status: string;
}

const textOf = (f: Fact | undefined): string | null => {
  if (!f || (f.status !== "answered" && f.status !== "inferred")) return null;
  const v = f.value;
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object" && "code" in v && typeof v.code === "string") return v.code;
  return null;
};

export interface NichePlan {
  coverage: Coverage;
  /** What a read would search for, in order. */
  terms: string[];
  /** Where the terms came from. */
  terms_from: "owner" | "profile";
  competitors: { id: string; name: string; page_id: string | null }[];
}

/** The latest stored read of a profile, of either status. */
async function latestRow(profileId: string, status?: "read" | "failed") {
  const [row] = await db
    .select()
    .from(nicheAdReads)
    .where(
      status
        ? and(eq(nicheAdReads.profile_id, profileId), eq(nicheAdReads.status, status))
        : eq(nicheAdReads.profile_id, profileId),
    )
    .orderBy(desc(nicheAdReads.read_at))
    .limit(1);
  return row ?? null;
}

export type NicheReadRow = typeof nicheAdReads.$inferSelect;

/** What a read for this profile would ask, from its own facts (and the owner's last terms). */
export async function planNicheRead(
  profileId: string,
  terms?: readonly unknown[],
): Promise<NichePlan> {
  const facts = await db
    .select({ key: fieldRecords.field_key, value: fieldRecords.value, status: fieldRecords.status })
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        isNull(fieldRecords.superseded_at),
        inArray(fieldRecords.field_key, ["legal.country", "identity.business_type"]),
      ),
    );
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const coverage = adLibraryCoverage(textOf(byKey.get("legal.country")));

  let chosen: string[];
  let from: NichePlan["terms_from"] = "profile";
  if (terms && terms.length > 0) {
    chosen = terms.flatMap((t) => cleanTerm(t) ?? []).slice(0, NICHE_CAPS.max_terms);
    from = "owner";
  } else {
    const last = await latestRow(profileId);
    const lastTerms = (last?.targets ?? []).some((t) => t["owner"] === true) ? last!.terms : [];
    if (lastTerms.length > 0) {
      chosen = lastTerms.slice(0, NICHE_CAPS.max_terms);
      from = "owner";
    } else {
      const offerRows = await db
        .select({ id: offers.id })
        .from(offers)
        .where(eq(offers.profile_id, profileId));
      const offerFacts = await db
        .select({
          key: fieldRecords.field_key,
          value: fieldRecords.value,
          status: fieldRecords.status,
        })
        .from(fieldRecords)
        .where(
          and(
            eq(fieldRecords.profile_id, profileId),
            isNull(fieldRecords.superseded_at),
            like(fieldRecords.field_key, "offers.%"),
          ),
        );
      const of = new Map(offerFacts.map((f) => [f.key, f]));
      const named = offerRows
        .map((o) => {
          const name = textOf(of.get(`offers.${o.id}.name`));
          const volume = of.get(`offers.${o.id}.volume_period`)?.value;
          return { name, volume: typeof volume === "number" ? volume : -1 };
        })
        .filter((o): o is { name: string; volume: number } => o.name !== null)
        .sort((a, b) => b.volume - a.volume);
      chosen = derivedTerms(
        textOf(byKey.get("identity.business_type")),
        named.map((o) => o.name),
      );
    }
  }

  const competitors = (await loadCompetitors(profileId))
    .filter((c) => c.tracked && c.name !== null)
    .map((c) => ({
      id: c.id,
      name: c.name as string,
      page_id: facebookPageId(c.listing_url) ?? facebookPageId(c.url),
    }));
  return { coverage, terms: chosen, terms_from: from, competitors };
}

/* ── the read ── */

export type NicheReadOutcome =
  | { status: "read"; read: NicheReadRow; fresh: boolean }
  | { status: "not_set_up"; why: string }
  | { status: "outside_coverage"; why: string; country: string | null }
  | { status: "nothing_to_search"; why: string }
  | { status: "cooldown"; why: string; read: NicheReadRow }
  | { status: "failed"; why: string };

export const NOT_SET_UP =
  "Niche research isn't set up yet: it needs a Meta Ad Library token (META_AD_LIBRARY_TOKEN) from a developer account whose identity Meta has confirmed.";

interface Target {
  kind: "term" | "competitor_pages" | "competitor_name";
  label: string;
  term?: string;
  page_ids?: string[];
  competitor_id?: string;
  /** The owner typed this term (it sticks for the next read). */
  owner?: boolean;
}

function targetsOf(plan: NichePlan): Target[] {
  const targets: Target[] = [];
  const withPages = plan.competitors.filter((c) => c.page_id !== null);
  if (withPages.length > 0) {
    targets.push({
      kind: "competitor_pages",
      label: withPages.map((c) => c.name).join(", "),
      page_ids: withPages.slice(0, AD_LIBRARY_CAPS.max_page_ids).map((c) => c.page_id as string),
    });
  }
  for (const c of plan.competitors
    .filter((c) => c.page_id === null)
    .slice(0, NICHE_CAPS.max_competitor_names)) {
    targets.push({ kind: "competitor_name", label: c.name, term: c.name, competitor_id: c.id });
  }
  for (const term of plan.terms) {
    targets.push({
      kind: "term",
      label: term,
      term,
      ...(plan.terms_from === "owner" ? { owner: true } : {}),
    });
  }
  return targets;
}

/** A stored timestamp (Postgres text form) as milliseconds. */
const msOf = (stamp: string) => Date.parse(stamp);
/** A stored timestamp as ISO 8601, for the screen. */
const isoOf = (stamp: string) => new Date(Date.parse(stamp)).toISOString();

export interface ReadNicheArgs {
  profileId: string;
  accountId: string;
  /** Owner-typed terms; absent = the plan's. */
  terms?: readonly unknown[];
  /** Ask the Library again even inside the cache window (once a day). */
  fresh?: boolean;
  now?: Date;
  /** Test seams. Absent = META_AD_LIBRARY_TOKEN and the real fetch. */
  token?: string | null;
  fetch?: AdLibraryFetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Read the niche's ads, or reuse the read that is still fresh. Never
 * throws for the Library's sake: every refusal is an outcome with words.
 */
export async function readNicheAds(args: ReadNicheArgs): Promise<NicheReadOutcome> {
  const now = args.now ?? new Date();
  const token = args.token !== undefined ? args.token : metaAdLibraryToken();
  if (token === null) return { status: "not_set_up", why: NOT_SET_UP };

  const plan = await planNicheRead(args.profileId, args.terms);
  if (!plan.coverage.covered) {
    return { status: "outside_coverage", why: plan.coverage.why, country: plan.coverage.country };
  }
  const targets = targetsOf(plan);
  if (targets.length === 0) {
    return {
      status: "nothing_to_search",
      why: "I have nothing to search for yet: type a word your niche's ads would use, or list a competitor.",
    };
  }

  const ownerTerms = args.terms !== undefined && args.terms.length > 0;
  const last = await latestRow(args.profileId, "read");
  const sameAsk =
    last !== null &&
    JSON.stringify(last.terms) === JSON.stringify(plan.terms) &&
    last.country === plan.coverage.country;
  const age = last ? now.getTime() - msOf(last.read_at) : Infinity;
  if (last && sameAsk && !args.fresh && age < NICHE_CAPS.cache_days * 86_400_000) {
    return { status: "read", read: last, fresh: false };
  }
  if (last && (args.fresh || ownerTerms) && age < NICHE_CAPS.refresh_cooldown_ms) {
    return {
      status: "cooldown",
      why: "I read the Ad Library for you within the last day; a fresh read is allowed once a day.",
      read: last,
    };
  }

  return withAdvisoryLock(
    `niche:${args.profileId}`,
    () => runRead(args, plan, targets, token, now),
    () => ({
      status: "failed",
      why: "A read of the Ad Library for this business is already running.",
    }),
  );
}

async function runRead(
  args: ReadNicheArgs,
  plan: NichePlan,
  targets: Target[],
  token: string,
  now: Date,
): Promise<NicheReadOutcome> {
  const country = (plan.coverage as { country: string }).country;
  const client = createAdLibraryClient({
    token,
    ...(args.fetch ? { fetch: args.fetch } : {}),
    ...(args.sleep ? { sleep: args.sleep } : {}),
  });
  const since = new Date(now.getTime() - AD_LIBRARY_CAPS.lookback_days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const ads = new Map<string, LibraryAd>();
  const storedTargets = targets.map((t) => ({
    kind: t.kind,
    label: t.label,
    ...(t.competitor_id ? { competitor_id: t.competitor_id } : {}),
    ...(t.owner ? { owner: true } : {}),
  }));
  const competitorByPage = new Map(
    plan.competitors.filter((c) => c.page_id).map((c) => [c.page_id as string, c.id]),
  );

  try {
    await client.checkToken();
    outer: for (const target of targets) {
      for (const media of ["VIDEO", "IMAGE"] as const) {
        if (ads.size >= AD_LIBRARY_CAPS.max_ads_per_read) break outer;
        if (client.requests >= AD_LIBRARY_CAPS.max_requests_per_read) break outer;
        const rows = await client.search({
          country,
          ...(target.page_ids ? { page_ids: target.page_ids } : {}),
          ...(target.term ? { term: target.term } : {}),
          exact: target.kind === "competitor_name",
          media,
          delivered_since: since,
        });
        for (const raw of rows) {
          const pageId = (raw as { page_id?: unknown } | null)?.page_id;
          const competitorId =
            target.kind === "competitor_name"
              ? target.competitor_id!
              : typeof pageId === "string"
                ? (competitorByPage.get(pageId) ?? null)
                : null;
          const ad = parseAd(
            raw,
            media,
            competitorId
              ? { kind: "competitor", competitor_id: competitorId }
              : { kind: "term", term: target.label },
          );
          if (!ad) continue;
          // A name search finds ads that MENTION the name; only the business's own page counts.
          if (target.kind === "competitor_name" && !sameBusiness(ad.page_name, target.label))
            continue;
          const seen = ads.get(ad.id);
          if (seen) {
            // Seen as a video first: keep that format; a competitor tag beats a term.
            if (seen.found_by.kind === "term" && ad.found_by.kind === "competitor") {
              ads.set(ad.id, { ...seen, found_by: ad.found_by });
            }
            continue;
          }
          if (ads.size < AD_LIBRARY_CAPS.max_ads_per_read) ads.set(ad.id, ad);
        }
      }
    }
  } catch (error) {
    const why =
      error instanceof AdLibraryError ? error.message : "Meta's Ad Library could not be read";
    console.error(
      JSON.stringify({
        event: "niche_read_failed",
        account_id: args.accountId,
        profile_id: args.profileId,
        requests: client.requests,
        ...logSafeError(error),
      }),
    );
    await db.insert(nicheAdReads).values({
      profile_id: args.profileId,
      source: AD_LIBRARY_SOURCE,
      status: "failed",
      read_at: now.toISOString(),
      country,
      terms: plan.terms,
      targets: storedTargets,
      requests: client.requests,
      ads: [],
      reason: why,
    });
    return { status: "failed", why };
  }

  const [row] = await db
    .insert(nicheAdReads)
    .values({
      profile_id: args.profileId,
      source: AD_LIBRARY_SOURCE,
      status: "read",
      read_at: now.toISOString(),
      country,
      terms: plan.terms,
      targets: storedTargets,
      requests: client.requests,
      ads: [...ads.values()] as unknown as Record<string, unknown>[],
    })
    .returning();
  console.log(
    JSON.stringify({
      event: "niche_read",
      account_id: args.accountId,
      profile_id: args.profileId,
      requests: client.requests,
      ads: ads.size,
    }),
  );
  return { status: "read", read: row!, fresh: true };
}

/* ── what the screen and the brief read ── */

/** The ads of a stored read, as LibraryAd. */
export function adsOf(read: Pick<NicheReadRow, "ads">): LibraryAd[] {
  return read.ads as unknown as LibraryAd[];
}

/** The latest successful read, or null. */
export async function latestNicheRead(profileId: string): Promise<NicheReadRow | null> {
  return latestRow(profileId, "read");
}

/** The honesty the screen prints beside the ads, every time. */
export const NICHE_CAVEATS = [
  "Meta's Ad Library shows no results for ordinary business ads: no spend, no reach, no sales. I rank by how long an ad has run and how many versions its business keeps live — advertisers rarely keep paying for an ad that doesn't work, but it is a proxy, not a measurement.",
  "It covers ads that reached the EU or the UK. A business's ads elsewhere are not in it.",
  "Format is as far as the Library's fields tell: video or image from the search, and several headlines meaning several cards or versions.",
] as const;

export interface NicheView {
  set_up: boolean;
  /** Why there is nothing to read, in words, when there isn't. */
  blocked: string | null;
  coverage: Coverage;
  plan_terms: string[];
  terms_from: NichePlan["terms_from"];
  competitors: { id: string; name: string; by: "page_id" | "name" }[];
  last_read: {
    id: string;
    read_at: string;
    country: string | null;
    terms: string[];
    ads_read: number;
    requests: number;
    /** A fresh read is allowed from then. */
    refresh_from: string;
    /** Whether the owner may ask for a fresh read now. */
    refresh_allowed: boolean;
  } | null;
  last_failure: { at: string; reason: string } | null;
  groups: NicheAdGroup[];
  caveats: readonly string[];
}

export async function nicheView(profileId: string, now = new Date()): Promise<NicheView> {
  const token = metaAdLibraryToken();
  const plan = await planNicheRead(profileId);
  const [read, failure] = await Promise.all([
    latestRow(profileId, "read"),
    latestRow(profileId, "failed"),
  ]);
  const competitorNames = new Map(plan.competitors.map((c) => [c.id, c.name]));
  const groups = read
    ? rankNicheAds(adsOf(read), isoOf(read.read_at).slice(0, 10), { limit: NICHE_CAPS.top_groups })
    : [];
  return {
    set_up: token !== null,
    blocked: token === null ? NOT_SET_UP : plan.coverage.covered ? null : plan.coverage.why,
    coverage: plan.coverage,
    plan_terms: plan.terms,
    terms_from: plan.terms_from,
    competitors: plan.competitors.map((c) => ({
      id: c.id,
      name: c.name,
      by: c.page_id ? "page_id" : "name",
    })),
    last_read: read
      ? {
          id: read.id,
          read_at: isoOf(read.read_at),
          country: read.country,
          terms: read.terms,
          ads_read: adsOf(read).length,
          requests: read.requests,
          refresh_from: new Date(msOf(read.read_at) + NICHE_CAPS.refresh_cooldown_ms).toISOString(),
          refresh_allowed: now.getTime() >= msOf(read.read_at) + NICHE_CAPS.refresh_cooldown_ms,
        }
      : null,
    last_failure:
      failure && (!read || msOf(failure.read_at) > msOf(read.read_at))
        ? { at: isoOf(failure.read_at), reason: failure.reason ?? "the read failed" }
        : null,
    // A competitor the owner has since removed is no longer named as one.
    groups: groups.map((g) => ({
      ...g,
      competitor_id:
        g.competitor_id && competitorNames.has(g.competitor_id) ? g.competitor_id : null,
    })),
    caveats: NICHE_CAVEATS,
  };
}
