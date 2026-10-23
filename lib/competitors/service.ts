// Competitors — feature 35's database side: the owner's list, the reads,
// and the weekly run.
//
// Every fact goes through the one write path (writeField: supersession,
// rule 3, and a decision-log entry, rule 7). The owner's list is the bank
// entity (question 12.1 creates the rows) plus what the owner adds, edits
// and removes on the Competitors screen; removal writes `tracked = false`
// and keeps everything. Reading writes what was seen as web_research
// facts at confidence 0.5 (§8.1) and the changes to the watch log.
//
// Nothing here executes anything. There is no write to any other system,
// no proposal is created, no price is changed (rule 12): this module
// reads public pages and records what they said.

import { and, desc, eq, inArray, isNull, like } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  competitors,
  fieldRecords,
  offers,
  watchActivity,
} from "../../db/schema";
import { createField } from "../core/field";
import { logSafeError } from "../core/log-safe";
import type { FieldStatus } from "../core/field-status";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { Money } from "../core/money";
import type { SourceRef } from "../core/source-ref";
import { withAdvisoryLock } from "../../db/advisory-lock";
import { writeField } from "../profile/field-store";
import type { PageFetcher } from "../site/fetch";
import type { CompetitorChange, ObservedOffer, ObservedOffers, ObservedRating } from "./changes";
import {
  MAX_OFFERS_PER_COMPETITOR,
  detectChanges,
  offersLabel,
  offersSignature,
  ratingLabel,
  ratingSignature,
} from "./changes";
import type { OwnOffer } from "./compare";
import type { SeenOffer } from "./extract";
import { METHOD_ORDER, needsModel } from "./extract";
import type { ModelPage, PriceLlm, RunBudget } from "./model";
import { livePriceLlm, newRunBudget, readWithModel } from "./model";
import type { PageOutcome, PageOutcomeKind } from "./read";
import { READ_CAPS, competitorFetcher, normalizePageUrl, readListedPages } from "./read";
import type { RobotsRules } from "./robots";

export class CompetitorError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "CompetitorError";
    this.status = status;
  }
}

/** §8.1: a competitor's own page is weaker evidence than the owner. */
export const OBSERVED_CONFIDENCE = 0.5;
const OWNER_CONFIDENCE = 0.75;

/** An owner may ask for a fresh read this often per competitor. */
export const OWNER_READ_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** The weekly run skips a competitor read more recently than this. */
export const WEEKLY_MIN_AGE_MS = 6 * 24 * 60 * 60 * 1000;
/** Per business per run, and per run in all. A slow week finishes next week. */
export const RUN_CAPS = {
  max_competitors_per_profile: 10,
  max_competitors_per_run: 60,
  /** Stop starting new reads after this long; the cron route has 300 s. */
  run_deadline_ms: 240_000,
} as const;
/** Listed pages per competitor: the website, the listing page, and up to three more. */
export const MAX_PRICE_PAGES = READ_CAPS.max_pages_per_competitor - 2;

export const WATCH_KIND_CHANGE = "competitor_change";
export const WATCH_KIND_FIRST_READ = "competitor_read";

const key = (id: string, field: string): string => `competitors.${id}.${field}`;

/* ── the record ── */

export interface ReadStatus {
  read_at: string;
  pages: { url: string; outcome: PageOutcomeKind; reason: string | null }[];
  offers_seen: number;
  /** "used", or why the model fallback was wanted and not used; null when not wanted. */
  model: string | null;
}

export interface CompetitorRecord {
  id: string;
  /** Where the row came from: the owner (interview or screen) or research. */
  origin: "owner" | "research";
  created_at: string;
  name: string | null;
  url: string | null;
  listing_url: string | null;
  price_pages: string[];
  tracked: boolean;
  offers: ObservedOffers | null;
  offers_since: string | null;
  rating: ObservedRating | null;
  status: ReadStatus | null;
  matches: Record<string, string>;
}

/** A current fact as this module reads it. */
interface Fact {
  value: unknown;
  status: FieldStatus;
  observed_at: string;
}

const text = (f: Fact | undefined): string | null =>
  f && f.status === "answered" && typeof f.value === "string" && f.value.trim() !== ""
    ? f.value.trim()
    : null;

/** Pure: the listed pages of a competitor, in reading order, deduplicated. */
export function pagesOf(
  c: Pick<CompetitorRecord, "url" | "listing_url" | "price_pages">,
): string[] {
  const out: string[] = [];
  for (const raw of [c.url, c.listing_url, ...c.price_pages]) {
    if (!raw) continue;
    const u = normalizePageUrl(raw);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

function splitLines(v: string | null): string[] {
  return (v ?? "")
    .split(/[\n\r]+/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** Every competitor of a profile, with its current facts. Removed ones too; callers filter on `tracked`. */
export async function loadCompetitors(profileId: string): Promise<CompetitorRecord[]> {
  const rows = await db
    .select()
    .from(competitors)
    .where(eq(competitors.profile_id, profileId))
    .orderBy(competitors.created_at);
  if (rows.length === 0) return [];
  const facts = await db
    .select()
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        like(fieldRecords.field_key, "competitors.%"),
        isNull(fieldRecords.superseded_at),
      ),
    );
  const byKey = new Map<string, Fact>();
  for (const f of facts) {
    byKey.set(f.field_key, { value: f.value, status: f.status, observed_at: f.observed_at });
  }
  return rows.map((r) => {
    const get = (field: string) => byKey.get(key(r.id, field));
    const tracked = get("tracked");
    const observed = get("observed_offers");
    const rating = get("observed_rating");
    const status = get("read_status");
    const matches = get("offer_matches");
    const kind = (r.source as { kind?: string } | null)?.kind;
    return {
      id: r.id,
      origin: kind === "web_research" ? "research" : "owner",
      created_at: r.created_at,
      name: text(get("name")),
      url: text(get("url")),
      listing_url: text(get("listing_url")),
      price_pages: splitLines(text(get("price_pages"))),
      tracked: !(tracked && tracked.status === "answered" && tracked.value === false),
      offers: observed?.status === "answered" ? (observed.value as ObservedOffers) : null,
      offers_since: observed?.status === "answered" ? observed.observed_at : null,
      rating: rating?.status === "answered" ? (rating.value as ObservedRating) : null,
      status: status?.status === "answered" ? (status.value as ReadStatus) : null,
      matches:
        matches?.status === "answered" &&
        typeof matches.value === "object" &&
        matches.value !== null
          ? (matches.value as Record<string, string>)
          : {},
    } satisfies CompetitorRecord;
  });
}

/** The owner's own offers with a name, and their price where stated. */
export async function loadOwnOffers(profileId: string): Promise<OwnOffer[]> {
  const rows = await db
    .select({ id: offers.id })
    .from(offers)
    .where(eq(offers.profile_id, profileId));
  if (rows.length === 0) return [];
  const facts = await db
    .select()
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        like(fieldRecords.field_key, "offers.%"),
        isNull(fieldRecords.superseded_at),
      ),
    );
  const by = new Map(facts.map((f) => [f.field_key, f]));
  const out: OwnOffer[] = [];
  for (const r of rows) {
    const name = by.get(`offers.${r.id}.name`);
    if (!name || name.status !== "answered" || typeof name.value !== "string") continue;
    const price = by.get(`offers.${r.id}.price`);
    const m = price?.status === "answered" ? (price.value as Money | null) : null;
    out.push({
      id: r.id,
      name: name.value,
      price: m && Number.isSafeInteger(m.amount_minor) && typeof m.currency === "string" ? m : null,
    });
  }
  return out;
}

/* ── the owner's edits, through the one write path ── */

export interface CompetitorInput {
  name?: unknown;
  url?: unknown;
  listing_url?: unknown;
  price_pages?: unknown;
}

interface CleanInput {
  name: string | null;
  url: string | null;
  listing_url: string | null;
  price_pages: string | null;
}

function cleanUrl(v: unknown, label: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new CompetitorError(`${label} must be text`);
  if (v.trim() === "") return null;
  const u = normalizePageUrl(v);
  if (u === null) throw new CompetitorError(`${label} isn't a web address I can read`);
  return u;
}

/** Validate an add or edit. Undefined fields are left alone on an edit. */
function cleanInput(input: CompetitorInput, requireName: boolean): Partial<CleanInput> {
  const out: Partial<CleanInput> = {};
  if (input.name !== undefined || requireName) {
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
    if (name === "") throw new CompetitorError("a competitor needs a name");
    out.name = name;
  }
  if (input.url !== undefined) out.url = cleanUrl(input.url, "Their website");
  if (input.listing_url !== undefined)
    out.listing_url = cleanUrl(input.listing_url, "Their listing page");
  if (input.price_pages !== undefined) {
    const raw = Array.isArray(input.price_pages)
      ? input.price_pages
      : typeof input.price_pages === "string"
        ? splitLines(input.price_pages)
        : null;
    if (raw === null) throw new CompetitorError("Other pages must be links, one per line");
    const pages = raw
      .map((p) => cleanUrl(p, "Each other page"))
      .filter((p): p is string => p !== null);
    if (pages.length > MAX_PRICE_PAGES) {
      throw new CompetitorError(
        `at most ${MAX_PRICE_PAGES} other pages: I read ${READ_CAPS.max_pages_per_competitor} pages per competitor in all`,
      );
    }
    out.price_pages = pages.length > 0 ? pages.join("\n") : null;
  }
  return out;
}

async function writeOwnerFact(
  profileId: string,
  k: string,
  value: unknown,
  note: string | null = null,
) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(k),
      value,
      status: value === null ? "unknown" : "answered",
      confidence: OWNER_CONFIDENCE,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note,
    }),
  );
}

/** The marker record of question 12.1: the tracked competitors' ids. */
async function writeMarker(profileId: string): Promise<void> {
  const list = (await loadCompetitors(profileId)).filter((c) => c.tracked).map((c) => c.id);
  await writeOwnerFact(profileId, "competitors", { entity_ids: list });
}

async function ownCompetitor(profileId: string, id: string): Promise<CompetitorRecord> {
  const found = (await loadCompetitors(profileId)).find((c) => c.id === id);
  if (!found) throw new CompetitorError("no such competitor on this business", 404);
  return found;
}

export async function addCompetitor(profileId: string, input: CompetitorInput): Promise<string> {
  const clean = cleanInput(input, true);
  const tracked = (await loadCompetitors(profileId)).filter((c) => c.tracked).length;
  if (tracked >= 25) throw new CompetitorError("25 competitors is the most I keep an eye on");
  const [row] = await db
    .insert(competitors)
    .values({ profile_id: profileId, source: { kind: "owner_input" } })
    .returning({ id: competitors.id });
  if (!row) throw new Error("competitor insert failed");
  for (const [field, value] of Object.entries(clean)) {
    if (value !== null) await writeOwnerFact(profileId, key(row.id, field), value);
  }
  await writeMarker(profileId);
  return row.id;
}

export async function editCompetitor(
  profileId: string,
  id: string,
  input: CompetitorInput,
): Promise<void> {
  const current = await ownCompetitor(profileId, id);
  const clean = cleanInput(input, false);
  const now: Record<keyof CleanInput, string | null> = {
    name: current.name,
    url: current.url,
    listing_url: current.listing_url,
    price_pages: current.price_pages.length > 0 ? current.price_pages.join("\n") : null,
  };
  for (const [field, value] of Object.entries(clean) as [keyof CleanInput, string | null][]) {
    if (value === now[field]) continue; // unchanged: no new record
    await writeOwnerFact(
      profileId,
      key(id, field),
      value,
      value === null ? "cleared by the owner" : null,
    );
  }
  if (!current.tracked) await writeOwnerFact(profileId, key(id, "tracked"), true);
}

export async function removeCompetitor(profileId: string, id: string): Promise<void> {
  const current = await ownCompetitor(profileId, id);
  if (!current.tracked) return;
  await writeOwnerFact(profileId, key(id, "tracked"), false);
  await writeMarker(profileId);
}

/** The owner's correction of a match: an offer of theirs, "none", or null to go back to the table's guess. */
export async function setOfferMatch(
  profileId: string,
  id: string,
  offerKeyValue: string,
  ownOfferId: string | null,
): Promise<void> {
  const current = await ownCompetitor(profileId, id);
  if (!current.offers?.offers.some((o) => o.key === offerKeyValue)) {
    throw new CompetitorError("that offer isn't on their pages as I last read them");
  }
  if (ownOfferId !== null && ownOfferId !== "none") {
    const own = await loadOwnOffers(profileId);
    if (!own.some((o) => o.id === ownOfferId))
      throw new CompetitorError("that isn't one of your offers");
  }
  const next = { ...current.matches };
  if (ownOfferId === null) delete next[offerKeyValue];
  else next[offerKeyValue] = ownOfferId;
  await writeOwnerFact(profileId, key(id, "offer_matches"), next);
}

/* ── reading ── */

export interface ReadDeps {
  fetcher?: PageFetcher;
  llm?: PriceLlm;
  budget?: RunBudget;
  now?: () => Date;
  usage?: (accountId: string, now: Date) => Promise<{ account_calls: number; total_eur: number }>;
  /** Epoch ms (on `clock`) after which no page or model read is started. */
  deadline?: number;
  /** The clock the deadline is read against: real time unless a test says otherwise. */
  clock?: () => number;
}

/** Why a page that wanted the model didn't get it: the run's time was spent. */
export const MODEL_DEADLINE_REASON = "the weekly run ran out of time for the model read";

export interface CompetitorReadResult {
  competitor_id: string;
  pages: { url: string; outcome: PageOutcomeKind; reason: string | null }[];
  offers_seen: number;
  changes: CompetitorChange[];
  first_read: boolean;
  wrote_offers: boolean;
  model: string | null;
}

function webSource(url: string | undefined): SourceRef {
  return { kind: "web_research", researched_url: url ?? "about:blank" };
}

async function writeObserved(
  profileId: string,
  k: string,
  value: unknown,
  url: string | undefined,
  at: string,
) {
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(k),
      value,
      status: "answered",
      confidence: OBSERVED_CONFIDENCE,
      source: webSource(url),
      observed_at: isoDateTime(at),
      recorded_at: isoDateTime(new Date().toISOString()),
      note: null,
    }),
  );
}

/**
 * Read these competitors of one business: fetch their listed pages, run
 * the deterministic parsers, send the pages they couldn't read to the
 * model in ONE batch (if the caps allow), then record what was seen and
 * what changed. Competitors with no pages are skipped.
 */
export async function readCompetitors(
  profileId: string,
  competitorIds: readonly string[] | null,
  deps: ReadDeps = {},
): Promise<CompetitorReadResult[]> {
  const fetcher = deps.fetcher ?? competitorFetcher;
  const now = deps.now ?? (() => new Date());
  const budget = deps.budget ?? newRunBudget();
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) throw new CompetitorError("no such business", 404);

  const all = (await loadCompetitors(profileId)).filter((c) => c.tracked);
  const chosen = competitorIds === null ? all : all.filter((c) => competitorIds.includes(c.id));
  const robotsCache = new Map<string, RobotsRules | { refused: string }>();

  const clock = deps.clock ?? Date.now;
  const late = () => deps.deadline !== undefined && clock() >= deps.deadline;
  const results: CompetitorReadResult[] = [];
  const noModel = { byUrl: new Map<string, SeenOffer[]>(), skipped: new Map<string, string>() };

  // 1 · fetch and parse, deterministic only. A competitor none of whose
  // pages wants the model is recorded at once; the rest wait for the one
  // batched model read below.
  const waitingFor: { c: CompetitorRecord; pages: PageOutcome[] }[] = [];
  for (const c of chosen) {
    if (late()) break; // not started: still the oldest read, first next week
    const urls = pagesOf(c);
    if (urls.length === 0) continue;
    const pages = await readListedPages({
      urls,
      fetcher,
      now,
      robotsCache,
      ...(deps.deadline !== undefined ? { deadline: deps.deadline, clock } : {}),
    });
    if (pages.some((p) => p.extract && needsModel(p.extract))) waitingFor.push({ c, pages });
    else results.push(await recordRead(profileId, c, pages, noModel, now));
  }
  if (waitingFor.length === 0) return results;

  // 2 · the model, once for the whole business, only for pages that need it
  const waiting: ModelPage[] = [];
  for (const { pages } of waitingFor) {
    for (const p of pages) {
      if (p.extract && needsModel(p.extract)) {
        waiting.push({ url: p.url, text: p.extract.text, currencies: p.extract.currencies });
      }
    }
  }
  const model = late()
    ? {
        byUrl: new Map<string, SeenOffer[]>(),
        skipped: waiting.map((p) => ({ url: p.url, reason: MODEL_DEADLINE_REASON })),
      }
    : await readWithModel({
        pages: waiting,
        accountId: profile.account_id,
        budget,
        llm: deps.llm ?? livePriceLlm,
        now: now(),
        ...(deps.usage ? { usage: deps.usage } : {}),
      });
  const modelSeen = {
    byUrl: model.byUrl,
    skipped: new Map(model.skipped.map((s) => [s.url, s.reason])),
  };

  // 3 · record the ones that waited for it
  for (const { c, pages } of waitingFor) {
    results.push(await recordRead(profileId, c, pages, modelSeen, now));
  }
  // In the order asked for, whichever finished first.
  const order = new Map(chosen.map((c, i) => [c.id, i]));
  return results.sort(
    (a, b) => (order.get(a.competitor_id) ?? 0) - (order.get(b.competitor_id) ?? 0),
  );
}

/**
 * Record one competitor's read: what was seen, what changed, the watch
 * log. Called as soon as that competitor is done (review 2026-10-23,
 * finding 10), so a run cut short keeps everything it finished.
 */
async function recordRead(
  profileId: string,
  c: CompetitorRecord,
  pages: PageOutcome[],
  model: { byUrl: Map<string, SeenOffer[]>; skipped: Map<string, string> },
  now: () => Date,
): Promise<CompetitorReadResult> {
  const skippedModel = model.skipped;
  const before = c.offers?.offers ?? [];
  const fresh: ObservedOffer[] = [];
  const freshUrls = new Set<string>();
  const carried: ObservedOffer[] = [];
  let modelNote: string | null = null;
  for (const p of pages) {
    const previous = before.filter((o) => o.url === p.url);
    if (p.outcome !== "read" || !p.extract) {
      carried.push(...previous); // not reading is not the same as gone
      continue;
    }
    const seen = [...p.extract.offers];
    const wantedModel = needsModel(p.extract);
    if (wantedModel) {
      const byModel = model.byUrl.get(p.url);
      if (byModel) {
        seen.push(...byModel);
        modelNote = "used";
      } else {
        modelNote = skippedModel.get(p.url) ?? "not used";
        // Unverified this week: keep what the model saw before.
        carried.push(...previous.filter((o) => o.method === "model"));
      }
    }
    if (!wantedModel || model.byUrl.has(p.url)) freshUrls.add(p.url);
    for (const o of seen) fresh.push({ ...o, url: p.url, fetched_at: p.fetched_at });
  }

  // One offer per key: the stronger method, then the earlier page.
  const merged = new Map<string, ObservedOffer>();
  for (const o of [...fresh, ...carried]) {
    const had = merged.get(o.key);
    if (!had || METHOD_ORDER.indexOf(o.method) < METHOD_ORDER.indexOf(had.method))
      merged.set(o.key, o);
  }
  const after = [...merged.values()].slice(0, MAX_OFFERS_PER_COMPETITOR);

  const ratingPage = pages.find((p) => p.extract?.rating);
  const ratingSeen = ratingPage?.extract?.rating ?? null;
  const ratingAfter: ObservedRating | null = ratingSeen
    ? {
        label_raw: ratingLabel(ratingSeen),
        rating: ratingSeen.rating,
        best: ratingSeen.best,
        count: ratingSeen.count,
        url: ratingPage!.url,
        method: ratingSeen.method,
        fetched_at: ratingPage!.fetched_at,
      }
    : null;

  const anyRead = pages.some((p) => p.outcome === "read");
  const firstRead = c.offers === null && c.rating === null;
  const name = c.name ?? "A competitor";
  const changes = firstRead
    ? []
    : detectChanges({
        competitor: name,
        before,
        after,
        freshUrls,
        ratingBefore: c.rating,
        ratingAfter: ratingAfter ?? c.rating,
      });

  const firstUrl = pages[0]?.url;
  const readAt = now().toISOString();
  let wroteOffers = false;
  if (anyRead && (c.offers === null || offersSignature(before) !== offersSignature(after))) {
    const value: ObservedOffers = { label_raw: offersLabel(after), offers: after };
    await writeObserved(profileId, key(c.id, "observed_offers"), value, firstUrl, readAt);
    wroteOffers = true;
  }
  if (ratingAfter && ratingSignature(ratingAfter) !== ratingSignature(c.rating)) {
    await writeObserved(
      profileId,
      key(c.id, "observed_rating"),
      ratingAfter,
      ratingAfter.url,
      ratingAfter.fetched_at,
    );
  }
  const status: ReadStatus = {
    read_at: readAt,
    pages: pages.map((p) => ({ url: p.url, outcome: p.outcome, reason: p.reason })),
    offers_seen: fresh.length,
    model: modelNote,
  };
  await writeObserved(profileId, key(c.id, "read_status"), status, firstUrl, readAt);

  // The watch log: one line per change, or the baseline on a first read.
  const base = Date.parse(readAt);
  if (firstRead && anyRead) {
    await db.insert(watchActivity).values({
      profile_id: profileId,
      at: new Date(base).toISOString(),
      kind: WATCH_KIND_FIRST_READ,
      detail:
        `I read ${name}'s pages for the first time: ` +
        (after.length === 0
          ? "no prices on them"
          : `${after.length} price${after.length === 1 ? "" : "s"}`) +
        (ratingAfter ? `, ${ratingLabel(ratingAfter)}` : "") +
        ".",
      meta: { competitor_id: c.id },
    });
  }
  for (const [i, ch] of changes.entries()) {
    await db.insert(watchActivity).values({
      profile_id: profileId,
      at: new Date(base + i + 1).toISOString(), // distinct instants keep the log's order
      kind: WATCH_KIND_CHANGE,
      detail: ch.sentence,
      meta: {
        competitor_id: c.id,
        flag: ch.flag,
        key: ch.key,
        before: ch.before,
        after: ch.after,
      },
    });
  }

  return {
    competitor_id: c.id,
    pages: status.pages,
    offers_seen: status.offers_seen,
    changes,
    first_read: firstRead,
    wrote_offers: wroteOffers,
    model: modelNote,
  };
}

/** The owner's "read now": one competitor, at most once per cooldown. */
export async function readOneNow(
  profileId: string,
  id: string,
  deps: ReadDeps = {},
): Promise<CompetitorReadResult> {
  await ownCompetitor(profileId, id); // a stranger's id never takes a lock
  // The cooldown check and the read it permits are one step (review
  // 2026-10-23, finding 22): an advisory lock per competitor, held until
  // the read's status is written, so a second click at the same moment is
  // refused instead of reading (and paying) twice.
  return withAdvisoryLock(
    `competitor_read:${id}`,
    async () => {
      const c = await ownCompetitor(profileId, id);
      if (!c.tracked) throw new CompetitorError("that competitor was removed from your list");
      if (pagesOf(c).length === 0)
        throw new CompetitorError("add their website or a listing page first");
      const now = (deps.now ?? (() => new Date()))();
      if (c.status && now.getTime() - Date.parse(c.status.read_at) < OWNER_READ_COOLDOWN_MS) {
        throw new CompetitorError("I read their pages in the last six hours; try again later", 429);
      }
      const [result] = await readCompetitors(profileId, [id], deps);
      if (!result) throw new CompetitorError("nothing to read");
      return result;
    },
    () => {
      throw new CompetitorError("I'm reading their pages right now; try again in a minute", 429);
    },
  );
}

/* ── the weekly run ── */

export interface WeeklyReadResult {
  profiles: number;
  competitors_read: number;
  changes: number;
  model_calls: number;
  stopped_early: boolean;
}

export async function runCompetitorReads(
  opts: ReadDeps & { profileIds?: readonly string[]; deadlineMs?: number } = {},
): Promise<WeeklyReadResult> {
  const now = opts.now ?? (() => new Date());
  const clock = opts.clock ?? Date.now;
  // One deadline for the whole run, checked before every page and raced
  // by every request (review 2026-10-23, finding 10): a profile of
  // blackholed pages used to run the cron past its 300 s and lose it all.
  const deadline = clock() + (opts.deadlineMs ?? RUN_CAPS.run_deadline_ms);
  const late = () => clock() >= deadline;
  const budget = opts.budget ?? newRunBudget();
  const profileRows = await db
    .selectDistinct({ profile_id: competitors.profile_id })
    .from(competitors)
    .where(opts.profileIds ? inArray(competitors.profile_id, [...opts.profileIds]) : undefined);

  const result: WeeklyReadResult = {
    profiles: 0,
    competitors_read: 0,
    changes: 0,
    model_calls: 0,
    stopped_early: false,
  };

  // What is due, per business, oldest read first; and the businesses in
  // the order of their oldest due read, so one that was cut short last
  // week isn't first again ahead of one that wasn't reached at all.
  const queue: { profile_id: string; due: CompetitorRecord[] }[] = [];
  for (const { profile_id } of profileRows) {
    try {
      const due = (await loadCompetitors(profile_id))
        .filter((c) => c.tracked && pagesOf(c).length > 0)
        .filter(
          (c) => !c.status || now().getTime() - Date.parse(c.status.read_at) >= WEEKLY_MIN_AGE_MS,
        )
        .sort((a, b) => (a.status?.read_at ?? "").localeCompare(b.status?.read_at ?? ""));
      if (due.length > 0) queue.push({ profile_id, due });
    } catch (error) {
      console.error(
        JSON.stringify({ event: "competitor_read_failed", profile_id, ...logSafeError(error) }),
      );
    }
  }
  queue.sort((a, b) =>
    (a.due[0]?.status?.read_at ?? "").localeCompare(b.due[0]?.status?.read_at ?? ""),
  );

  for (const { profile_id, due } of queue) {
    if (late() || result.competitors_read >= RUN_CAPS.max_competitors_per_run) {
      result.stopped_early = true;
      break;
    }
    try {
      const chosen = due.slice(
        0,
        Math.min(
          RUN_CAPS.max_competitors_per_profile,
          RUN_CAPS.max_competitors_per_run - result.competitors_read,
        ),
      );
      const callsBefore = budget.calls;
      const reads = await readCompetitors(
        profile_id,
        chosen.map((c) => c.id),
        { ...opts, budget, deadline, clock },
      );
      result.profiles++;
      result.competitors_read += reads.length;
      result.changes += reads.reduce((s, r) => s + r.changes.length, 0);
      result.model_calls += budget.calls - callsBefore;
      if (reads.length < chosen.length) result.stopped_early = true;
    } catch (error) {
      console.error(
        JSON.stringify({ event: "competitor_read_failed", profile_id, ...logSafeError(error) }),
      );
    }
  }
  if (late()) result.stopped_early = true;
  return result;
}

/** The screen's recent changes: newest first. */
export async function recentChanges(profileId: string, limit = 20) {
  const rows = await db
    .select()
    .from(watchActivity)
    .where(and(eq(watchActivity.profile_id, profileId), eq(watchActivity.kind, WATCH_KIND_CHANGE)))
    .orderBy(desc(watchActivity.at))
    .limit(limit);
  return rows;
}
