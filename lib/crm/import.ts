// Contact import — Phase 4 Session A (P4-03), extended in Session E (P4-13).
//
// A CSV never comes in without the owner standing behind it: every
// batch requires an ATTESTATION — the consent status these contacts
// hold and, in the owner's own words, how it was obtained ("checkout
// checkbox since 2024", "signed forms in the drawer"). The statement
// lands on every imported contact as its consent provenance, so a
// year from now any single row can say which batch it rode in on and
// what the owner claimed at the time (rule 19).
//
// The suppression list outranks the owner: an address that was erased
// or unsubscribed is refused re-entry by its reason, whatever the CSV
// says (rules 22/23). And the decision log records the BATCH — id,
// counts, a hash — never a contact's PII.
//
// Session E: a shop's customer export carries purchase history — last
// order date, order count, total spent — and that is the "measured
// data" lifecycle and segments compute from (P4-13). Money lands as
// integer minor units plus the batch's currency (rule 1); a value that
// cannot be read is left null and counted, never guessed.
//
// The parser is deliberately small and deterministic: quoted fields,
// escaped quotes, flexible header names. No model anywhere near it —
// reading a spreadsheet is not inference (cost rule).

import { countryCode } from "../hours/timezone";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { db } from "../../db";
import { businessProfiles, contacts, decisionLog } from "../../db/schema";
import { minorUnitExponent } from "../core/money";
import type { ConsentStatus } from "./contacts";
import { ContactError, isSuppressed, normalizeEmail } from "./contacts";

const MAX_ROWS = 10_000;
const MAX_BYTES = 2_000_000;

/* ── a small, honest CSV parser ── */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

interface Columns {
  email: number;
  name: number;
  phone: number;
  last_purchase: number;
  orders: number;
  spent: number;
  country: number;
}

/** Header → column role, tolerant of the spellings spreadsheets (and shop exports) grow. */
function mapHeader(header: string[]): Columns {
  const find = (...names: string[]) =>
    header.findIndex((h) =>
      names.includes(
        h
          .trim()
          .toLowerCase()
          .replace(/[\s_-]+/g, ""),
      ),
    );
  return {
    email: find("email", "emailaddress", "e-mail", "mail"),
    name: find("name", "fullname", "contactname", "customer"),
    phone: find("phone", "phonenumber", "tel", "telephone", "mobile"),
    last_purchase: find(
      "lastpurchase",
      "lastpurchaseat",
      "lastpurchasedate",
      "lastorder",
      "lastorderat",
      "lastorderdate",
      "lastordered",
    ),
    orders: find("orders", "orderscount", "ordercount", "totalorders", "numberoforders"),
    spent: find("totalspent", "totalspend", "spent", "spend", "lifetimevalue", "ltv"),
    country: find(
      "country",
      "countrycode",
      "billingcountry",
      "shippingcountry",
      "countryregion",
      "defaultaddresscountry",
      "defaultaddresscountrycode",
    ),
  };
}

/**
 * A country as an ISO alpha-2 code: the names owners' exports carry (the
 * shared country table), or any bare two-letter code. Anything else is
 * null and counted, never guessed.
 */
export function parseCountry(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  const known = countryCode(v);
  if (known) return known;
  return /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null;
}

/** ISO-ish dates and the common day-month-year spellings; anything else is null, never guessed. */
export function parseDate(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) {
    const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(v);
  if (dmy) {
    const t = Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function parseCount(raw: string): number | null {
  const v = raw.trim().replace(/[\s,]/g, "");
  if (!/^\d+$/.test(v)) return null;
  return Number.parseInt(v, 10);
}

/** "1 234.50", "1,234.50", "€1234.5", "1234" → integer minor units for the currency. */
export function parseMoneyMinor(raw: string, currency: string): number | null {
  let v = raw.trim().replace(/[^\d.,-]/g, "");
  if (v === "" || v === "-") return null;
  // Two separators: the last one is the decimal mark. One: decimal if followed by 1–2 digits.
  const lastComma = v.lastIndexOf(",");
  const lastDot = v.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    v = lastComma > lastDot ? v.replace(/\./g, "").replace(",", ".") : v.replace(/,/g, "");
  } else if (lastComma !== -1) {
    v = /,\d{1,2}$/.test(v) ? v.replace(",", ".") : v.replace(/,/g, "");
  }
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
  const exponent = minorUnitExponent(currency);
  const minor = Math.round(Number.parseFloat(v) * 10 ** exponent);
  return Number.isFinite(minor) ? minor : null;
}

/* ── the import ── */

export interface ImportAttestation {
  status: ConsentStatus;
  /** The owner's words: what these contacts consented to, and how. */
  statement: string;
}

export interface ImportOptions {
  /** ISO 4217 for the spent column. Required when the CSV carries one; the column is ignored otherwise. */
  currency?: string;
}

export type RowOutcome =
  | { outcome: "imported"; contact_id: string }
  | { outcome: "suppressed"; reason: string }
  | { outcome: "already_exists"; refreshed?: true }
  | { outcome: "duplicate_in_batch" }
  | { outcome: "invalid"; reason: string };

export interface ImportResult {
  batch_id: string;
  imported: number;
  skipped: {
    suppressed: number;
    already_exists: number;
    duplicate_in_batch: number;
    invalid: number;
  };
  /**
   * Purchase columns present in the header, values that could not be read
   * (left null), and — P4-17 — how many contacts already here had their
   * purchase history refreshed from this file (consent never moves).
   */
  purchase: { columns: string[]; unreadable: number; refreshed: number };
  /** Whether the file had a country column, and how many values could not be read (left null). */
  country: { column: boolean; unreadable: number };
  rows: RowOutcome[];
}

/**
 * Import a CSV of contacts under one attestation. Row-level honesty:
 * every line gets an outcome, nothing is silently dropped, and the
 * batch is one decision-log entry with counts and a hash — no PII.
 */
export async function importContacts(
  accountId: string,
  csv: string,
  attestation: ImportAttestation,
  options: ImportOptions = {},
): Promise<ImportResult> {
  if (attestation.statement.trim() === "") {
    throw new ContactError(
      "an import needs your attestation — what did these contacts consent to, and how?",
      422,
    );
  }
  if (csv.length > MAX_BYTES) {
    throw new ContactError("that file is too large for one import — split it", 413);
  }
  const parsed = parseCsv(csv);
  if (parsed.length < 2) {
    throw new ContactError("the CSV needs a header row and at least one contact", 422);
  }
  if (parsed.length - 1 > MAX_ROWS) {
    throw new ContactError(`one import takes up to ${MAX_ROWS} rows — split the file`, 413);
  }
  const columns = mapHeader(parsed[0] as string[]);
  if (columns.email === -1 && columns.name === -1 && columns.phone === -1) {
    throw new ContactError(
      "no usable columns found — the header needs at least one of: email, name, phone",
      422,
    );
  }
  const currency = options.currency?.trim().toUpperCase() ?? "";
  if (columns.spent !== -1 && !/^[A-Z]{3}$/.test(currency)) {
    throw new ContactError(
      "the file has a spent column — say which currency it is in (three letters, e.g. EUR)",
      422,
    );
  }
  const purchaseColumns = (["last_purchase", "orders", "spent"] as const).filter(
    (c) => columns[c] !== -1,
  );

  const batchId = crypto.randomUUID();
  const source = `import batch ${batchId}: "${attestation.statement.trim()}"`;
  const seenInBatch = new Set<string>();
  const rows: RowOutcome[] = [];
  const counts = { suppressed: 0, already_exists: 0, duplicate_in_batch: 0, invalid: 0 };
  let imported = 0;
  let refreshed = 0;
  let unreadable = 0;
  let countryUnreadable = 0;
  const hasCountry = columns.country !== -1;

  for (const raw of parsed.slice(1)) {
    const cell = (i: number) => (i >= 0 ? (raw[i] ?? "").trim() : "");
    const email = cell(columns.email);
    const name = cell(columns.name);
    const phone = cell(columns.phone);

    if (!email && !name && !phone) {
      counts.invalid++;
      rows.push({ outcome: "invalid", reason: "empty row" });
      continue;
    }
    if (email && !email.includes("@")) {
      counts.invalid++;
      rows.push({ outcome: "invalid", reason: "not an email address" });
      continue;
    }
    const normalized = email ? normalizeEmail(email) : null;
    if (normalized) {
      if (seenInBatch.has(normalized)) {
        counts.duplicate_in_batch++;
        rows.push({ outcome: "duplicate_in_batch" });
        continue;
      }
      seenInBatch.add(normalized);
    }
    const suppressed = normalized ? await isSuppressed(accountId, normalized) : null;

    // Purchase history: read what can be read, count what cannot, invent nothing.
    const lastPurchaseRaw = cell(columns.last_purchase);
    const ordersRaw = cell(columns.orders);
    const spentRaw = cell(columns.spent);
    const lastPurchase = lastPurchaseRaw ? parseDate(lastPurchaseRaw) : null;
    const orders = ordersRaw ? parseCount(ordersRaw) : null;
    const spent = spentRaw ? parseMoneyMinor(spentRaw, currency) : null;
    if (lastPurchaseRaw && lastPurchase === null) unreadable++;
    if (ordersRaw && orders === null) unreadable++;
    if (spentRaw && spent === null) unreadable++;
    const countryRaw = cell(columns.country);
    const country = countryRaw ? parseCountry(countryRaw) : null;
    if (countryRaw && country === null) countryUnreadable++;

    // P4-17: a file with a last-order column measures purchases as of now.
    const at = new Date().toISOString();
    const hasDates = columns.last_purchase !== -1;
    const refresh = (email: string) =>
      purchaseColumns.length > 0
        ? refreshPurchases(accountId, email, {
            lastPurchase,
            orders,
            spent,
            currency,
            at: hasDates ? at : null,
          })
        : Promise.resolve(false);

    if (normalized && suppressed) {
      // Never re-added (rules 22/23). An unsubscribed customer who is still
      // on the books has their purchases refreshed all the same — what they
      // bought is not marketing, and the campaign readback would otherwise
      // lose exactly the recipients who said no. An erased one has no row.
      counts.suppressed++;
      if (await refresh(normalized)) refreshed++;
      rows.push({ outcome: "suppressed", reason: suppressed });
      continue;
    }
    try {
      const [inserted] = await db
        .insert(contacts)
        .values({
          account_id: accountId,
          email: normalized,
          name: name || null,
          phone: phone || null,
          consent_status: attestation.status,
          consent_source: source,
          last_purchase_at: lastPurchase,
          last_activity_at: lastPurchase,
          orders_count: orders,
          total_spent_minor: spent,
          spent_currency: spent === null ? null : currency,
          country,
          purchase_refreshed_at: hasDates ? at : null,
        })
        .returning({ id: contacts.id });
      imported++;
      rows.push({ outcome: "imported", contact_id: inserted!.id });
    } catch (error) {
      const constraint = (error as { cause?: { constraint?: string } }).cause?.constraint;
      if (constraint === "contacts_account_email_idx") {
        counts.already_exists++;
        // P4-17: the shop's later export refreshes what it measures — the
        // purchase history, and nothing else. Consent, name, phone and
        // country stay as recorded; an unreadable or empty cell leaves the
        // stored value alone; the last order date never moves backwards (an
        // older file can't un-happen a purchase).
        const did = normalized !== null && (await refresh(normalized));
        if (did) refreshed++;
        rows.push(
          did ? { outcome: "already_exists", refreshed: true } : { outcome: "already_exists" },
        );
        continue;
      }
      throw error;
    }
  }

  // The batch on the record — counts and a hash, no PII (rule 22).
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, accountId));
  if (profile) {
    await db.insert(decisionLog).values({
      profile_id: profile.id,
      actor: "owner",
      kind: "import",
      ref_id: batchId,
      payload_hash: createHash("sha256")
        .update(
          JSON.stringify({
            account_id: accountId,
            batch_id: batchId,
            attestation_status: attestation.status,
            attestation_statement: attestation.statement.trim(),
            imported,
            ...counts,
            purchase_columns: purchaseColumns,
            purchase_refreshed: refreshed,
            country_column: hasCountry,
          }),
        )
        .digest("hex"),
    });
  }
  console.log(
    JSON.stringify({
      event: "contacts_imported",
      account_id: accountId,
      batch_id: batchId,
      imported,
      ...counts,
      purchase_columns: purchaseColumns,
      purchase_refreshed: refreshed,
      unreadable,
      country_column: hasCountry,
      country_unreadable: countryUnreadable,
    }),
  );
  return {
    batch_id: batchId,
    imported,
    skipped: counts,
    purchase: { columns: purchaseColumns, unreadable, refreshed },
    country: { column: hasCountry, unreadable: countryUnreadable },
    rows,
  };
}

/**
 * P4-17: refresh an existing contact's purchase history from a later shop
 * export. Only readable values are written; the last order date is the
 * later of the stored and the exported one. `at` (set when the file has a
 * last-order column) records that the export measured this contact now.
 * Returns whether anything was written.
 */
async function refreshPurchases(
  accountId: string,
  email: string,
  v: {
    lastPurchase: string | null;
    orders: number | null;
    spent: number | null;
    currency: string;
    at: string | null;
  },
): Promise<boolean> {
  const set: PgUpdateSetSource<typeof contacts> = {};
  if (v.lastPurchase !== null) {
    set.last_purchase_at = sql`GREATEST(${contacts.last_purchase_at}, ${v.lastPurchase}::timestamptz)`;
    set.last_activity_at = sql`GREATEST(${contacts.last_activity_at}, ${v.lastPurchase}::timestamptz)`;
  }
  if (v.orders !== null) set.orders_count = v.orders;
  if (v.spent !== null) {
    set.total_spent_minor = v.spent;
    set.spent_currency = v.currency;
  }
  if (v.at !== null) set.purchase_refreshed_at = v.at;
  if (Object.keys(set).length === 0) return false;
  const rows = await db
    .update(contacts)
    .set(set)
    .where(and(eq(contacts.account_id, accountId), eq(contacts.email, email)))
    .returning({ id: contacts.id });
  return rows.length === 1;
}
