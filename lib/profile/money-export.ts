// The accountant export — idea 49 (2026-10-26). The business's money facts
// as CSV, for whoever keeps its books: one row per CURRENT fact, and a
// second file of the superseded history (rule 3 — the old figures are
// kept, so they can be handed over too).
//
// What counts as a money fact is read from data, never from a list in
// code (rule 4): a value that IS money (integer minor units + currency,
// rule 1), or a field the current bank asks for as money — so a revenue
// the owner said they don't know still has its row, "unknown", because
// a gap is a finding (rule 5). Entity fields count the same way: the
// bank's entity schemas say which of an offer's fields are money.
//
// Amounts leave as a plain decimal string in major units beside the
// currency, built from the integer's digits (lib/core/money
// toDecimalString) — no float anywhere. Inferred figures carry their
// derived_from and formula (rule 6).
//
// Only the business's own facts: field_records hold no customer contacts
// (those live in the CRM tables, which this module never reads), and every
// query is scoped by the account AND the profile.

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  bankEntitySchemas,
  bankQuestions,
  bankVersions,
  businessProfiles,
  fieldRecords,
} from "../../db/schema";
import { displaySourceKind } from "../connectors/measured";
import { isIsoCurrency, money, toDecimalString } from "../core/money";
import { sourceDetail } from "./factsheet";

/** Hard cap per file: the export is a record, and a runaway profile must not stream forever. */
export const EXPORT_ROW_CAP = 5_000;

/* ── what is money: read from the bank ── */

export interface MoneyKeys {
  /** Scalar field keys the bank asks for as money ("revenue.monthly_revenue"). */
  scalar: ReadonlySet<string>;
  /** Entity field names the bank's schemas type as money ("price", "amount"). */
  entityFields: ReadonlySet<string>;
}

const ENTITY_KEY =
  /^[a-z_]+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z_]+)$/;

interface MoneyValue {
  amount_minor: number;
  currency: string;
}

/** Pure: a stored value that is Money — a safe integer of minor units and an ISO currency. */
export function isMoneyValue(v: unknown): v is MoneyValue {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { amount_minor?: unknown; currency?: unknown };
  return (
    typeof o.amount_minor === "number" &&
    Number.isSafeInteger(o.amount_minor) &&
    typeof o.currency === "string" &&
    isIsoCurrency(o.currency)
  );
}

/** Pure: whether a fact belongs in the money export. */
export function isMoneyFact(key: string, value: unknown, keys: MoneyKeys): boolean {
  if (isMoneyValue(value)) return true;
  if (keys.scalar.has(key)) return true;
  const entity = ENTITY_KEY.exec(key);
  return entity !== null && keys.entityFields.has(entity[1] ?? "");
}

const inputType = (input: unknown): unknown =>
  typeof input === "object" && input !== null ? (input as { type?: unknown }).type : undefined;

/** The money keys and their prompts, from the CURRENT bank. */
export async function moneyKeysFromBank(): Promise<MoneyKeys & { labels: Map<string, string> }> {
  const [bank] = await db
    .select({ version: bankVersions.version })
    .from(bankVersions)
    .where(eq(bankVersions.is_current, true));
  const scalar = new Set<string>();
  const entityFields = new Set<string>();
  const labels = new Map<string, string>();
  if (!bank) return { scalar, entityFields, labels };
  const [questions, schemas] = await Promise.all([
    db
      .select({
        writes_to: bankQuestions.writes_to,
        input: bankQuestions.input,
        prompt: bankQuestions.prompt,
      })
      .from(bankQuestions)
      .where(eq(bankQuestions.bank_version, bank.version)),
    db
      .select({ fields: bankEntitySchemas.fields })
      .from(bankEntitySchemas)
      .where(eq(bankEntitySchemas.bank_version, bank.version)),
  ]);
  for (const q of questions) {
    if (inputType(q.input) !== "money") continue;
    scalar.add(q.writes_to);
    const en = (q.prompt as { en?: unknown } | null)?.en;
    if (typeof en === "string") labels.set(q.writes_to, en);
  }
  for (const s of schemas) {
    for (const f of (s.fields as { key?: unknown; input?: unknown }[] | null) ?? []) {
      if (typeof f.key === "string" && inputType(f.input) === "money") entityFields.add(f.key);
    }
  }
  return { scalar, entityFields, labels };
}

/* ── the rows ── */

export interface MoneyExportRow {
  field: string;
  /** The bank's own words for the field, or the entity it belongs to ("Szörp 0.5L · price"). */
  label: string;
  /** Major units as a decimal string ("4990.00"); empty when the fact holds no amount. */
  amount: string;
  /** ISO 4217; empty when the fact holds no amount. */
  currency: string;
  status: string;
  source: string;
  /** Question id, URL, or the formula — whatever the source names. */
  source_detail: string;
  confidence: string;
  observed_at: string;
  recorded_at: string;
  /** Inferred facts only (rule 6): the inputs, separated by " | ". */
  derived_from: string;
  /** Inferred facts only: the method / formula. */
  formula: string;
  /** History file only: when a newer record replaced this one. */
  superseded_at?: string;
}

export interface StoredFact {
  field_key: string;
  value: unknown;
  status: string;
  confidence: string;
  source: unknown;
  observed_at: string;
  recorded_at: string;
  superseded_at: string | null;
}

/** Pure: one stored record as an export row. */
export function toExportRow(
  fact: StoredFact,
  label: string,
  withSuperseded: boolean,
): MoneyExportRow {
  const src = (typeof fact.source === "object" && fact.source !== null ? fact.source : {}) as {
    kind?: unknown;
    derived_from?: unknown;
    method?: unknown;
  };
  const inferred = src.kind === "inferred";
  const amount = isMoneyValue(fact.value)
    ? toDecimalString(money(fact.value.amount_minor, fact.value.currency))
    : "";
  return {
    field: fact.field_key,
    label,
    amount,
    currency: isMoneyValue(fact.value) ? fact.value.currency : "",
    status: fact.status,
    source: displaySourceKind(fact.source),
    source_detail: sourceDetail(fact.source) ?? "",
    confidence: fact.confidence,
    observed_at: isoInstant(fact.observed_at),
    recorded_at: isoInstant(fact.recorded_at),
    derived_from:
      inferred && Array.isArray(src.derived_from)
        ? src.derived_from.filter((d): d is string => typeof d === "string").join(" | ")
        : "",
    formula: inferred && typeof src.method === "string" ? src.method : "",
    ...(withSuperseded ? { superseded_at: isoInstant(fact.superseded_at) } : {}),
  };
}

/* ── CSV: RFC 4180, injection-safe ── */

/** A plain number ("-12.50", "0.750") is data, not a formula, and stays readable as one. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
/** What a spreadsheet would start evaluating (OWASP CSV injection), tab and CR included. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Pure: one cell, neutralised and quoted as needed. */
export function csvCell(raw: string): string {
  const safe = FORMULA_START.test(raw) && !PLAIN_NUMBER.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CURRENT_COLUMNS = [
  "field",
  "label",
  "amount",
  "currency",
  "status",
  "source",
  "source_detail",
  "confidence",
  "observed_at",
  "recorded_at",
  "derived_from",
  "formula",
] as const;

export const HISTORY_COLUMNS = [...CURRENT_COLUMNS, "superseded_at"] as const;

/** Pure: the file — a BOM so spreadsheet apps read "Szörp" right, a header, CRLF lines. */
export function toCsv(columns: readonly string[], rows: readonly MoneyExportRow[]): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    const record = row as unknown as Record<string, string | undefined>;
    lines.push(columns.map((c) => csvCell(record[c] ?? "")).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/* ── the read ── */

export type ExportPart = "current" | "history";

/**
 * The money facts of ONE business, as rows. Scoped by account AND profile:
 * the join refuses a profile id that isn't this account's, so a mismatched
 * pair reads nothing rather than someone else's books.
 */
export async function moneyExportRows(args: {
  accountId: string;
  profileId: string;
  part: ExportPart;
}): Promise<MoneyExportRow[]> {
  const keys = await moneyKeysFromBank();
  const scope = and(
    eq(fieldRecords.profile_id, args.profileId),
    eq(businessProfiles.account_id, args.accountId),
  );
  const columns = {
    field_key: fieldRecords.field_key,
    value: fieldRecords.value,
    status: fieldRecords.status,
    confidence: fieldRecords.confidence,
    source: fieldRecords.source,
    observed_at: fieldRecords.observed_at,
    recorded_at: fieldRecords.recorded_at,
    superseded_at: fieldRecords.superseded_at,
  };
  const facts: StoredFact[] =
    args.part === "current"
      ? await db
          .select(columns)
          .from(fieldRecords)
          .innerJoin(businessProfiles, eq(businessProfiles.id, fieldRecords.profile_id))
          .where(and(scope, isNull(fieldRecords.superseded_at)))
          .orderBy(fieldRecords.field_key)
      : await db
          .select(columns)
          .from(fieldRecords)
          .innerJoin(businessProfiles, eq(businessProfiles.id, fieldRecords.profile_id))
          .where(and(scope, isNotNull(fieldRecords.superseded_at)))
          .orderBy(fieldRecords.field_key, desc(fieldRecords.superseded_at));

  // Entity names, so "offers.<id>.price" reads as "Szörp 0.5L · price". Current names only;
  // an entity with no name field goes by its label, role or platform (a cost, a staff role, a channel).
  const nameRows = await db
    .select({ field_key: fieldRecords.field_key, value: fieldRecords.value })
    .from(fieldRecords)
    .innerJoin(businessProfiles, eq(businessProfiles.id, fieldRecords.profile_id))
    .where(and(scope, isNull(fieldRecords.superseded_at)));
  const names = entityNames(nameRows);
  const labelOf = (key: string): string => {
    const own = keys.labels.get(key);
    if (own !== undefined) return own;
    const entity = ENTITY_KEY.exec(key);
    if (entity) {
      const prefix = key.slice(0, key.length - (entity[1] ?? "").length - 1);
      const name = names.get(prefix);
      return name !== undefined ? `${name} · ${(entity[1] ?? "").replace(/_/g, " ")}` : "";
    }
    return "";
  };

  return facts
    .filter((f) => isMoneyFact(f.field_key, f.value, keys))
    .slice(0, EXPORT_ROW_CAP)
    .map((f) => toExportRow(f, labelOf(f.field_key), args.part === "history"));
}

/** Which field names an entity, best first. */
const NAME_FIELDS = ["name", "label", "role_title", "platform", "type"] as const;

/** Pure: entity prefix ("offers.<id>") → the words that name it, from its current facts. */
export function entityNames(
  rows: readonly { field_key: string; value: unknown }[],
): Map<string, string> {
  const best = new Map<string, { rank: number; words: string }>();
  for (const r of rows) {
    const m = /^(.+)\.([a-z_]+)$/.exec(r.field_key);
    if (!m || !ENTITY_KEY.test(r.field_key) || typeof r.value !== "string") continue;
    const rank = (NAME_FIELDS as readonly string[]).indexOf(m[2] ?? "");
    if (rank === -1 || r.value.trim() === "") continue;
    const prefix = m[1] ?? "";
    const seen = best.get(prefix);
    if (seen === undefined || rank < seen.rank) {
      best.set(prefix, { rank, words: r.value.replace(/_/g, " ") });
    }
  }
  return new Map([...best].map(([k, v]) => [k, v.words]));
}

/** Pure: a stored timestamp as ISO 8601 UTC ("2026-09-30T20:10:07.079Z"), or as stored if unreadable. */
export function isoInstant(raw: string | null): string {
  if (raw === null) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

/** The download's file name: no business name in it, only the date and the part. */
export function exportFileName(part: ExportPart, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return part === "current" ? `syb-money-facts-${day}.csv` : `syb-money-history-${day}.csv`;
}
