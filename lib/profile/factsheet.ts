// The fact sheet — P1-59/60. Everything the owner has told us, with its
// provenance, and everything they haven't, with what answering it buys.
//
// Reads from a SNAPSHOT (ensureSnapshot dedupes by content hash), so
// what the owner sees is a stable, reproducible view — the same read a
// report will render from — never a live query that can shift under
// them mid-scroll. Gaps come from the applicability resolver: a
// services-only business is not "missing" inventory questions that do
// not exist for it. All of it is deterministic arithmetic; no model is
// consulted to describe the owner's own data.

import { datesInWords, noteWords } from "./note-words";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { fieldRecords } from "../../db/schema";
import { PRIORITY_WEIGHTS, computeCompleteness } from "../scorer/completeness";
import type { ApplicableQuestion } from "../resolver/applicability";
import { applicableQuestions } from "../resolver/applicability";
import { englishLabels } from "../bank/english-labels";
import { displaySourceKind } from "../connectors/measured";
import type { Field } from "../core/field";
import { toDecimalString } from "../core/money";
import { moneyDigits } from "../core/currency-table";
import { SIZE_BAND_KEY, TEAM_SIZE_KEY, resolveSizeBand } from "./size-band";
import { ensureSnapshot, readSnapshot } from "./snapshot";
import type { ProfileSection } from "./sections";
import { sectionOfFieldKey } from "./sections";

function sectionFor(key: string): ProfileSection | null {
  try {
    return sectionOfFieldKey(key);
  } catch {
    return null;
  }
}

/* ── the view ── */

export interface FactRow {
  key: string;
  /** Humanised value — money as an amount + currency, enums by label. */
  value: string | null;
  status: string;
  confidence: number;
  source_kind: string;
  /** URL, question id, or derivation formula — whatever the source names. */
  source_detail: string | null;
  observed_at: string;
  /** When the record was written — what "changed this month" is measured on. */
  recorded_at: string;
  note: string | null;
}

/**
 * One superseded record (rule 3): a value the field held until something
 * better came in. Kept forever; shown struck through, never erased.
 */
export interface SupersededFact {
  key: string;
  value: string | null;
  status: string;
  source_kind: string;
  source_detail: string | null;
  observed_at: string;
  recorded_at: string;
  /** When its successor replaced it. */
  superseded_at: string;
  note: string | null;
}

/** field_key → its superseded records, newest first. */
export type FactHistory = Record<string, SupersededFact[]>;

export interface EntityGroup {
  /** "competitors.<id>" — the field-key prefix the rows share. */
  id: string;
  spine: string;
  /** The entity's own name field, when it has one. */
  name: string | null;
  facts: FactRow[];
}

export interface GapRow {
  question_id: string;
  prompt: string;
  section: ProfileSection;
  priority: ApplicableQuestion["priority"];
  /** Why answering is worth it — deterministic copy, never a model's. */
  buys: string;
  /** True when this gap alone holds the diagnosis back. */
  blocking: boolean;
}

export interface FactSheet {
  profile_id: string;
  snapshot_id: string;
  taken_at: string;
  fact_count: number;
  completeness: {
    overall: number;
    core_complete: boolean;
    by_section: { section: ProfileSection; score: number }[];
  };
  /** Counts by source kind — where the 214 came from. */
  provenance: { kind: string; count: number }[];
  /** Scalar facts, grouped by profile section. */
  sections: { section: ProfileSection; facts: FactRow[] }[];
  /** Entity facts (offers, competitors, …), grouped per entity. */
  entities: EntityGroup[];
  gaps: GapRow[];
  /** Superseded records for the facts above, by full field_key (rule 3). */
  history: FactHistory;
  /** Start of the current calendar month (UTC) — what "changed this month" counts from. */
  changed_since: string;
  /** Keys whose value was replaced since `changed_since`. */
  changed: string[];
}

/** Pure: the first instant of `now`'s calendar month, UTC. */
export function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/* ── humanising values: deterministic, no model ── */

const isMoney = (v: unknown): v is { amount_minor: number; currency: string } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { amount_minor?: unknown }).amount_minor === "number" &&
  typeof (v as { currency?: unknown }).currency === "string";

export function repr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // A bare vocabulary code ("social_organic") reads as words; anything
  // with spaces, capitals or punctuation is owner text and stays verbatim.
  if (typeof value === "string")
    return /^[a-z0-9]+(_[a-z0-9]+)+$/.test(value) ? value.replace(/_/g, " ") : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isMoney(value)) {
    // From the integer's digits (hard rule 1): thousands grouped by spaces,
    // trailing zero decimals dropped — the evidence's form as it always was.
    const [whole = "0", fraction = ""] = toDecimalString(value).split(".");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    const decimals = fraction.replace(/0+$/, "");
    return `${grouped}${decimals ? `.${decimals}` : ""} ${value.currency}`;
  }
  if (Array.isArray(value)) {
    const parts = value.map(repr).filter((p): p is string => p !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const o = value as { label_raw?: unknown; code?: unknown; value?: unknown };
    if (typeof o.label_raw === "string" && o.label_raw !== "") return o.label_raw;
    if (typeof o.code === "string") return o.code.replace(/_/g, " ");
    if (typeof o.value === "string") return o.value;
    return JSON.stringify(value).slice(0, 120);
  }
  return String(value);
}

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const isPeriod = (p: unknown): p is { open: string; close: string } =>
  typeof p === "object" &&
  p !== null &&
  typeof (p as { open?: unknown }).open === "string" &&
  typeof (p as { close?: unknown }).close === "string";

/**
 * An opening schedule (lib/hours/schedule.ts OpeningSchedule) in words:
 * "Mon closed · Tue 20:00–01:00 · …". A day the answer never mentioned
 * says "not stated" — unknown is not closed (rule 5). Null for anything
 * that is not a schedule.
 */
export function scheduleWords(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const days = (value as { days?: unknown }).days;
  if (typeof days !== "object" || days === null || Array.isArray(days)) return null;
  const map = days as Record<string, unknown>;
  if (!WEEK.some((d) => Array.isArray(map[d]))) return null;
  const unstated = new Set(
    Array.isArray((value as { unstated?: unknown }).unstated)
      ? ((value as { unstated: unknown[] }).unstated.filter(
          (d) => typeof d === "string",
        ) as string[])
      : [],
  );
  const name = (d: string) => d.charAt(0).toUpperCase() + d.slice(1);
  return WEEK.map((d) => {
    const periods = map[d];
    if (unstated.has(d) || !Array.isArray(periods)) return `${name(d)} not stated`;
    const ok = periods.filter(isPeriod);
    if (ok.length === 0) return `${name(d)} closed`;
    return `${name(d)} ${ok.map((p) => `${p.open} to ${p.close}`).join(", ")}`;
  }).join(" · ");
}

/** An entity's id → its recorded name ("Speckled Everyday Mug"). */
export type EntityNames = ReadonlyMap<string, string>;
const NO_NAMES: EntityNames = new Map();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTITY_FIELD =
  /^[a-z_]+\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z_]+)$/;
/**
 * What names an entity, best first: most schemas have a name; a cost
 * has a label, a role a title, a goal its statement, and a channel
 * only its platform or type.
 */
const NAME_FIELDS = ["name", "label", "role_title", "statement", "platform", "type"] as const;
const NAME_MAX = 60;

/** Pure: every entity's name in a set of facts, from the best field it has (NAME_FIELDS). */
export function entityNamesOf(facts: Iterable<readonly [string, { value: unknown }]>): EntityNames {
  const best = new Map<string, { rank: number; name: string }>();
  for (const [key, f] of facts) {
    const m = ENTITY_FIELD.exec(key);
    if (!m) continue;
    const rank = (NAME_FIELDS as readonly string[]).indexOf(m[2] ?? "");
    if (rank < 0) continue;
    const id = m[1] as string;
    const had = best.get(id);
    if (had !== undefined && had.rank <= rank) continue;
    const text = repr(f.value)?.trim();
    if (!text) continue;
    best.set(id, {
      rank,
      name: text.length > NAME_MAX ? `${text.slice(0, NAME_MAX - 1).trimEnd()}…` : text,
    });
  }
  return new Map([...best].map(([id, b]) => [id, b.name]));
}

/** The current names of these entities, by id (NAME_FIELDS), read from the profile. */
export async function loadEntityNames(
  profileId: string,
  ids: readonly string[],
): Promise<EntityNames> {
  const wanted = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ key: fieldRecords.field_key, value: fieldRecords.value })
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        isNull(fieldRecords.superseded_at),
        or(...wanted.map((id) => sql`${fieldRecords.field_key} like ${`%.${id}.%`}`)),
      ),
    );
  return entityNamesOf(rows.map((r) => [r.key, { value: r.value }] as const));
}

const KEY_ENTITY =
  /^[a-z_]+\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(.+)$/;

/**
 * Pure: profile keys an answer was built from, in words — each entity by
 * its name with the fields used ("Speckled Everyday Mug (name, price)"),
 * any other key by its last part ("business name"). Never a raw id.
 */
export function keysInWords(keys: readonly string[], names: EntityNames): string {
  const groups = new Map<string, string[]>();
  const plain: string[] = [];
  for (const key of keys) {
    const m = KEY_ENTITY.exec(key);
    if (m) {
      const fields = groups.get(m[1] as string) ?? [];
      fields.push((m[2] as string).replace(/[._]/g, " "));
      groups.set(m[1] as string, fields);
    } else {
      plain.push((key.split(".").pop() ?? key).replace(/_/g, " "));
    }
  }
  const named = [...groups].map(
    ([id, fields]) => `${names.get(id) ?? "one of your entries"} (${fields.join(", ")})`,
  );
  return [...named, ...new Set(plain)].join("; ");
}

/**
 * An answer that points at entities — an id, a { code: id } reference,
 * a list of them, or the entity-list marker { entity_ids } — with each
 * id swapped for its name.
 * An id with no recorded name stays as it is.
 */
function named(value: unknown, names: EntityNames): unknown {
  if (typeof value === "string") return UUID.test(value) ? (names.get(value) ?? value) : value;
  if (Array.isArray(value)) return value.map((v) => named(v, names));
  // An entity reference is stored as a code: { code: "<id>" }.
  const code = (value as { code?: unknown } | null)?.code;
  if (typeof code === "string" && UUID.test(code)) return names.get(code) ?? code;
  if (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { entity_ids?: unknown }).entity_ids)
  )
    return named((value as { entity_ids: unknown[] }).entity_ids, names);
  return value;
}

/**
 * The value as the fact sheet and the report print it: repr(), except a
 * schedule reads as days and hours, a yes/no answer as "yes" or "no",
 * and an answer naming entities by id as their names. Display only —
 * repr() itself stays byte-for-byte what the diagnosis evidence was
 * written from.
 */
export function displayValue(value: unknown, names: EntityNames = NO_NAMES): string | null {
  if (typeof value === "boolean") return value ? "yes" : "no";
  return (
    scheduleWords(value) ?? goalWords(value) ?? siteCheckWords(value) ?? repr(named(value, names))
  );
}

/**
 * The site checks (lib/blindspots): what the pages read show and what
 * they don't — "4 pages read · shows: prices, delivery · not found: faq,
 * reviews" — instead of their JSON. Null for any other value.
 */
export function siteCheckWords(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as { pages?: unknown; results?: unknown };
  if (!Array.isArray(v.pages) || typeof v.results !== "object" || v.results === null) return null;
  const results = Object.entries(v.results as Record<string, unknown>);
  const word = (k: string) => k.replace(/_/g, " ");
  const shows = results.filter(([, at]) => typeof at === "string").map(([k]) => word(k));
  const missing = results.filter(([, at]) => at === null).map(([k]) => word(k));
  const n = v.pages.length;
  return [
    `${n} page${n === 1 ? "" : "s"} read`,
    shows.length > 0 ? `shows: ${shows.join(", ")}` : null,
    missing.length > 0 ? `not found: ${missing.join(", ")}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
}

/** A goal's metric in words (lib/care/goal-measure GOAL_METRICS' labels). */
const GOAL_METRIC_WORDS: Readonly<Record<string, string>> = {
  revenue: "revenue",
  orders: "orders",
  sessions: "website visits",
};

/** A level per 30 days, in whole units: money in its currency (stored in minor units, rule 1), else a count. */
function levelWords(per30d: number, currency: unknown): string {
  const grouped = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  if (typeof currency === "string" && currency !== "" && Number.isSafeInteger(per30d)) {
    // Money: whole major units from the integer's digits (hard rule 1).
    const d = moneyDigits({ amount_minor: per30d, currency }, { whole: true });
    return `${d.negative ? "-" : ""}${grouped(d.whole)} ${currency}`;
  }
  const n = Math.round(per30d); // not money: a count per 30 days
  return `${n < 0 ? "-" : ""}${grouped(String(Math.abs(n)))}`;
}

/**
 * A goal's measure ("raise orders to 750 per 30 days by 2027-04-21") or
 * its measured baseline ("660 per 30 days, measured 2026-09-23 to
 * 2026-10-20 (23 days)") in words, instead of their JSON. Null for any
 * other value.
 */
export function goalWords(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.metric === "string" &&
    typeof v.target_per_30d === "number" &&
    typeof v.deadline === "string"
  ) {
    const metric = GOAL_METRIC_WORDS[v.metric] ?? v.metric.replace(/_/g, " ");
    const verb = v.direction === "decrease" ? "lower" : "raise";
    return `${verb} ${metric} to ${levelWords(v.target_per_30d, v.currency)} per 30 days by ${v.deadline}`;
  }
  if (
    typeof v.per_30d === "number" &&
    typeof v.from === "string" &&
    typeof v.to === "string" &&
    typeof v.days_measured === "number"
  ) {
    return `${levelWords(v.per_30d, v.currency)} per 30 days, measured ${v.from} to ${v.to} (${v.days_measured} day${v.days_measured === 1 ? "" : "s"})`;
  }
  return null;
}

export function sourceDetail(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;
  const s = source as {
    researched_url?: unknown;
    question_id?: unknown;
    method?: unknown;
    derived_from?: unknown;
  };
  if (typeof s.researched_url === "string") return s.researched_url;
  // A measured fact's method names its connection by id; the reader only
  // needs the platform ("… from shopify").
  if (typeof s.method === "string")
    return s.method.replace(
      / \(?connection [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)?/g,
      "",
    );
  if (typeof s.question_id === "string") return s.question_id;
  return null;
}

export { datesInWords, noteWords };

function toRow(
  key: string,
  field: Field<unknown>,
  labels: OptionLabels = new Map(),
  names: EntityNames = NO_NAMES,
): FactRow {
  return {
    key,
    value: datesInWords(labelledValue(key, field.value, labels, names)),
    status: field.status,
    confidence: field.confidence,
    // "connector" for a measured fact, so its pill says "measured" (P2-10).
    source_kind: displaySourceKind(field.source),
    source_detail: noteWords(sourceDetail(field.source)),
    observed_at: field.observed_at,
    recorded_at: field.recorded_at,
    note: noteWords(field.note ?? null),
  };
}

/* ── history: the superseded records, read-only ── */

/** The raw columns of a field_records row the history view needs. */
export interface SupersededRowInput {
  field_key: string;
  value: unknown;
  status: string;
  source: unknown;
  observed_at: string;
  recorded_at: string;
  superseded_at: string | null;
  note: string | null;
}

const isoOf = (t: string): string => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toISOString();
};

/** Pure: a stored row as a history line. Null for a row that is still current. */
export function toSupersededFact(row: SupersededRowInput): SupersededFact | null {
  if (row.superseded_at === null) return null;
  return {
    key: row.field_key,
    value: datesInWords(displayValue(row.value)),
    status: row.status,
    source_kind: displaySourceKind(row.source),
    source_detail: noteWords(sourceDetail(row.source)),
    observed_at: isoOf(row.observed_at),
    recorded_at: isoOf(row.recorded_at),
    superseded_at: isoOf(row.superseded_at),
    note: noteWords(row.note),
  };
}

/** Pure: group history lines by key, newest supersession first, at most `perKey` each. */
export function groupHistory(facts: readonly SupersededFact[], perKey = 12): FactHistory {
  const out: FactHistory = {};
  const sorted = [...facts].sort(
    (a, b) =>
      b.superseded_at.localeCompare(a.superseded_at) || b.recorded_at.localeCompare(a.recorded_at),
  );
  for (const f of sorted) {
    const list = (out[f.key] ??= []);
    if (list.length < perKey) list.push(f);
  }
  return out;
}

/** Pure: the keys whose value was replaced at or after `sinceIso` — "changed this month". */
export function changedSince(history: FactHistory, sinceIso: string): Set<string> {
  const since = Date.parse(sinceIso);
  const keys = new Set<string>();
  for (const [key, list] of Object.entries(history)) {
    if (list.some((f) => Date.parse(f.superseded_at) >= since)) keys.add(key);
  }
  return keys;
}

/** Hard cap on history rows read per profile — the view is a record, not an export. */
const HISTORY_ROW_CAP = 2000;

/**
 * Every superseded record of a profile (optionally only for `keys`),
 * grouped by key. Read-only: it selects, it never writes.
 */
export async function readSupersededFacts(
  profileId: string,
  keys?: readonly string[],
): Promise<FactHistory> {
  if (keys !== undefined && keys.length === 0) return {};
  const where = and(
    eq(fieldRecords.profile_id, profileId),
    isNotNull(fieldRecords.superseded_at),
    ...(keys !== undefined ? [inArray(fieldRecords.field_key, [...keys])] : []),
  );
  const rows = await db
    .select({
      field_key: fieldRecords.field_key,
      value: fieldRecords.value,
      status: fieldRecords.status,
      source: fieldRecords.source,
      observed_at: fieldRecords.observed_at,
      recorded_at: fieldRecords.recorded_at,
      superseded_at: fieldRecords.superseded_at,
      note: fieldRecords.note,
    })
    .from(fieldRecords)
    .where(where)
    .orderBy(desc(fieldRecords.superseded_at))
    .limit(HISTORY_ROW_CAP);
  return groupHistory(rows.map(toSupersededFact).filter((f): f is SupersededFact => f !== null));
}

/* ── the bank's own words for a code ── */

/** field key → code → the owner-facing label, from the questions' option_labels. */
export type OptionLabels = ReadonlyMap<string, Readonly<Record<string, string>>>;

/** Pure: the English option labels each question carries, by the key it writes. */
export function optionLabelsOf(
  questions: readonly Pick<ApplicableQuestion, "writes_to" | "input">[],
): OptionLabels {
  const out = new Map<string, Record<string, string>>();
  for (const q of questions) {
    const input = q.input as { option_labels?: unknown; vocabulary_id?: unknown } | null;
    // The vocabulary's English words (specs/vocabulary-labels-en.json) first;
    // a question's own option_labels win over them.
    const words: Record<string, string> = {
      ...(typeof input?.vocabulary_id === "string" ? englishLabels()[input.vocabulary_id] : {}),
    };
    const labels = input?.option_labels;
    if (typeof labels !== "object" || labels === null) {
      if (Object.keys(words).length > 0) out.set(q.writes_to, words);
      continue;
    }
    for (const [code, text] of Object.entries(labels as Record<string, unknown>)) {
      const en = (text as { en?: unknown } | null)?.en;
      if (typeof en === "string" && en.trim() !== "") words[code] = en.trim();
    }
    if (Object.keys(words).length > 0) out.set(q.writes_to, words);
  }
  return out;
}

/**
 * Pure: a value in the bank's words when its question labels its codes
 * ("solo" → "Just me"); otherwise exactly displayValue(). Display only.
 */
export function labelledValue(
  key: string,
  value: unknown,
  labels: OptionLabels,
  names: EntityNames = NO_NAMES,
): string | null {
  const words = labels.get(key);
  if (words !== undefined) {
    const label = (v: unknown): string | null => {
      const code = (v as { code?: unknown } | null)?.code;
      return typeof code === "string" && words[code] !== undefined ? words[code] : null;
    };
    if (Array.isArray(value)) {
      const parts = value.map((v) => label(v) ?? repr(v));
      if (parts.every((p): p is string => p !== null) && parts.length > 0) return parts.join(", ");
    } else {
      const one = label(value);
      if (one !== null) return one;
    }
  }
  return displayValue(value, names);
}

/** "competitors.<uuid>.name" → the entity prefix and trailing field. */
const ENTITY_KEY =
  /^(offers|competitors|suppliers|channels|staff_roles|locations)\.([0-9a-f-]{36})\.(.+)$/;

/* ── what a gap buys: priority-derived copy, never inference ── */

export function gapBuys(q: Pick<ApplicableQuestion, "priority" | "unlocks">): string {
  const unlockCount = Array.isArray(q.unlocks) ? q.unlocks.length : 0;
  const followUps =
    unlockCount > 0 ? ` and opens ${unlockCount} follow-up${unlockCount === 1 ? "" : "s"}` : "";
  switch (q.priority) {
    case "core":
      return `part of the core set: the diagnosis will not run without it${followUps}`;
    case "important":
      return `sharpens the findings that touch it${followUps}`;
    case "deep":
      return `adds precision once the core picture exists${followUps}`;
    default:
      return `context, when you feel like it${followUps}`;
  }
}

/* ── the read ── */

export async function buildFactSheet(profileId: string): Promise<FactSheet> {
  const summary = await ensureSnapshot(profileId, "manual");
  const [view, completeness, applicable, history] = await Promise.all([
    readSnapshot(summary.id),
    computeCompleteness(profileId),
    applicableQuestions(profileId),
    readSupersededFacts(profileId),
  ]);
  const since = monthStart(new Date());
  const labels = optionLabelsOf(applicable);
  // History lines were humanised by repr() ("small team" for small_team);
  // a labelled code reads in the bank's words there too.
  for (const list of Object.values(history)) {
    for (const h of list) {
      const words = labels.get(h.key);
      if (words === undefined || h.value === null) continue;
      const code = Object.keys(words).find((c) => c.replace(/_/g, " ") === h.value);
      if (code !== undefined) h.value = words[code] ?? h.value;
    }
  }

  // The size band: until the owner states it (1.6a), the band inferred
  // from their headcount shows as a DERIVED fact with its formula, in
  // place of the gap row; the open question stays in "Still open", so
  // the owner can put it in their own words. Never stored (size-band.ts).
  const facts = new Map(view.facts);
  const sized = resolveSizeBand(facts.get(SIZE_BAND_KEY), facts.get(TEAM_SIZE_KEY));
  if (sized?.via === "inferred") facts.set(SIZE_BAND_KEY, sized.field);

  const sections = new Map<ProfileSection, FactRow[]>();
  const entities = new Map<string, EntityGroup>();
  const provenance = new Map<string, number>();

  const names = entityNamesOf(facts);
  for (const [key, field] of facts) {
    const row = toRow(key, field, labels, names);
    provenance.set(row.source_kind, (provenance.get(row.source_kind) ?? 0) + 1);

    const entity = ENTITY_KEY.exec(key);
    if (entity) {
      const [, spine, id, fieldName] = entity as unknown as [string, string, string, string];
      const groupId = `${spine}.${id}`;
      const group = entities.get(groupId) ?? { id: groupId, spine, name: null, facts: [] };
      group.facts.push({ ...row, key: fieldName });
      if (fieldName === "name" && row.value !== null) group.name = row.value;
      entities.set(groupId, group);
      continue;
    }

    // The section a key is filed under, bank namespaces included: service.*
    // (booking, capacity, the bookings measures) lives in offers. Splitting on
    // the first dot alone dropped every service.* fact from the sheet.
    const section = sectionFor(key);
    if (section === null) continue;
    const rows = sections.get(section) ?? [];
    rows.push(row);
    sections.set(section, rows);
  }

  for (const rows of sections.values()) rows.sort((a, b) => a.key.localeCompare(b.key));
  for (const group of entities.values()) group.facts.sort((a, b) => a.key.localeCompare(b.key));

  // Gaps: applicable questions the snapshot holds no response for. The
  // scorer's definition of "responded" is the one that counts — an
  // explicit unknown is an answer, not a gap (rule 5).
  const respondedKeys = new Set(
    [...view.facts.entries()]
      .filter(
        ([, f]) => f.status === "answered" || f.status === "inferred" || f.status === "unknown",
      )
      .map(([key]) => key),
  );
  const blocking = new Set(completeness.blocking_gaps);
  const gaps: GapRow[] = applicable
    .filter((q) => !respondedKeys.has(q.writes_to))
    .map((q) => ({
      question_id: q.id,
      prompt:
        typeof (q.prompt as { en?: unknown })?.en === "string"
          ? (q.prompt as { en: string }).en
          : q.id,
      section: q.section,
      priority: q.priority,
      buys: gapBuys(q),
      blocking: blocking.has(q.writes_to),
    }))
    .sort(
      (a, b) =>
        PRIORITY_WEIGHTS[b.priority] - PRIORITY_WEIGHTS[a.priority] ||
        a.question_id.localeCompare(b.question_id),
    );

  return {
    profile_id: profileId,
    snapshot_id: summary.id,
    taken_at: summary.taken_at,
    fact_count: summary.fact_count,
    completeness: {
      overall: completeness.overall,
      core_complete: completeness.core_complete,
      by_section: [...completeness.by_section.entries()]
        .map(([section, score]) => ({ section, score }))
        .sort((a, b) => a.section.localeCompare(b.section)),
    },
    provenance: [...provenance.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count),
    sections: [...sections.entries()]
      .map(([section, facts]) => ({ section, facts }))
      .sort((a, b) => a.section.localeCompare(b.section)),
    entities: [...entities.values()].sort((a, b) => a.spine.localeCompare(b.spine)),
    gaps,
    history,
    changed_since: since,
    changed: [...changedSince(history, since)].sort(),
  };
}
