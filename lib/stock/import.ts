// Stock file import — feature 34, for a business with no store connector:
// a salon's retail shelf counted into a spreadsheet, a till's stock export.
//
// The file becomes observations exactly like a connector's (rule 2: no bare
// values). Every figure lands in metric_observations under the account's
// one "import" connection (db/schema.ts connectionPurpose), dated the day
// the owner says the stock was counted, observed at the moment of import,
// and the batch is one decision-log entry with counts and a hash. A
// re-import of the same day replaces that day's figures (the natural key),
// and a later count supersedes an earlier one by date, never by overwrite.
//
// The columns are mapped AS DATA (rule 4): STOCK_COLUMNS lists, per role,
// the header spellings that mean it. Reading a spreadsheet is not
// inference, so no model is anywhere near it (cost rule), and a cell that
// can't be read is left out and COUNTED, never guessed (rule 5's spirit:
// a gap is a finding). Money is integer minor units with the currency the
// owner names for the file (rule 1); a value more precise than the
// currency allows is unreadable, not rounded.

import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, connections, decisionLog } from "../../db/schema";
import type { DecimalStyle } from "../core/money";
import {
  DECIMAL_STYLE_MESSAGES,
  isIsoCurrency,
  parseAmountMinor,
  settleDecimalStyle,
} from "../core/money";
import type { Observation } from "../connectors/provider";
import { upsertObservations } from "../connectors/service";
import { parseCsv, parseDate } from "../crm/import";

/** The import connection's provider id. Never in the scope registry: it holds no credential. */
export const STOCK_IMPORT_PROVIDER = "stock_import";

export const STOCK_IMPORT_LIMITS = { max_rows: 5_000, max_bytes: 1_000_000 } as const;

/**
 * The column map, as data: role → the header spellings that mean it,
 * compared after lower-casing and dropping spaces, dashes and underscores.
 * The first header that matches a role takes it; a header matches one role
 * at most, in this order.
 */
export const STOCK_COLUMNS = {
  sku: ["sku", "code", "itemcode", "productcode", "barcode", "ean", "ref", "reference"],
  item: ["item", "itemname", "name", "product", "productname", "title", "description"],
  on_hand: [
    "onhand",
    "quantityonhand",
    "qtyonhand",
    "instock",
    "stock",
    "stocklevel",
    "stockonhand",
    "quantity",
    "qty",
    "available",
    "count",
  ],
  unit_cost: [
    "unitcost",
    "cost",
    "costprice",
    "costperunit",
    "buyprice",
    "buyingprice",
    "purchaseprice",
    "wholesale",
    "wholesaleprice",
  ],
  price: ["price", "retailprice", "sellprice", "sellingprice", "saleprice", "unitprice", "rrp"],
  last_sold: ["lastsold", "lastsolddate", "lastsale", "lastsaledate", "datelastsold", "lastsoldon"],
  units_sold: ["unitssold", "sold", "qtysold", "quantitysold", "unitssoldinwindow", "sales"],
} as const;

export type StockRole = keyof typeof STOCK_COLUMNS;
export const STOCK_ROLES = Object.keys(STOCK_COLUMNS) as StockRole[];

export class StockImportError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "StockImportError";
    this.status = status;
  }
}

const normHeader = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s_\-.]+/g, "");

/** Pure: header row → the column index of each role, −1 where none matches. */
export function mapStockHeader(header: readonly string[]): Record<StockRole, number> {
  const taken = new Set<number>();
  const out = {} as Record<StockRole, number>;
  for (const role of STOCK_ROLES) {
    const names: readonly string[] = STOCK_COLUMNS[role];
    const index = header.findIndex((h, i) => !taken.has(i) && names.includes(normHeader(h)));
    out[role] = index;
    if (index !== -1) taken.add(index);
  }
  return out;
}

/** A whole, non-negative count: "12", "1,200", "1 200". Anything else is null. */
export function parseUnits(raw: string): number | null {
  const v = raw.trim().replace(/[\s,]/g, "");
  if (!/^\d+$/.test(v)) return null;
  const n = Number.parseInt(v, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * "€12.50", "12,50", "1.234,50", "1,234.50" → integer minor units, through
 * the one exact path (lib/core/money.ts readAmount → digitsToMinor, no
 * float). Null when unreadable, negative, more precise than the currency
 * allows, or ambiguous ("1.200") without the file's style to settle it
 * (review 2026-10-23, #4: "12.000" HUF had been read as 12 Ft).
 */
export function parseStockMoney(
  raw: string,
  currency: string,
  style: DecimalStyle | null = null,
): number | null {
  const r = parseAmountMinor(raw, currency, style);
  return r.ok && r.minor >= 0 ? r.minor : null;
}

/** The key an imported item's series is stored under: its SKU, else its name, normalised. */
export function itemRef(sku: string, name: string): string | null {
  const key = (sku.trim() || name.trim()).toLowerCase().replace(/\s+/g, " ");
  if (key === "") return null;
  return `import:${sku.trim() ? "sku" : "name"}:${key}`;
}

export interface StockImportOptions {
  /** ISO 4217 for the cost and price columns. Required when the file has either. */
  currency?: string;
  /**
   * Which mark is the decimal one in the money columns, when the file can't
   * prove it itself (only values like "1.200"). Asked, never guessed.
   */
  decimal_style?: DecimalStyle | null;
  /** The window the units-sold column covers, in days. Required when the file has one. */
  window_days?: number;
  /** "YYYY-MM-DD": the day the stock was counted. Defaults to the day of import. */
  as_of?: string;
  now?: Date;
}

export interface StockImportResult {
  batch_id: string;
  as_of: string;
  imported: number;
  /** Which roles the header was read as, by the header's own words. */
  columns: Partial<Record<StockRole, string>>;
  skipped: { no_item: number; on_hand_unreadable: number; duplicate_in_file: number };
  /** Values left out because they couldn't be read, per column — never guessed. */
  unreadable: { unit_cost: number; price: number; last_sold: number; units_sold: number };
}

const MAX_WINDOW_DAYS = 730;

/** Pure: the file → observations, plus the counts that say what was left out. */
export function stockFileObservations(
  csv: string,
  options: Required<Pick<StockImportOptions, "as_of">> & StockImportOptions,
  observedAt: string,
): { observations: Observation[]; result: Omit<StockImportResult, "batch_id"> } {
  if (csv.length > STOCK_IMPORT_LIMITS.max_bytes) {
    throw new StockImportError("that file is too large for one import — split it", 413);
  }
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new StockImportError("the file needs a header row and one item");
  if (rows.length - 1 > STOCK_IMPORT_LIMITS.max_rows) {
    throw new StockImportError(
      `one import takes up to ${STOCK_IMPORT_LIMITS.max_rows} items — split the file`,
      413,
    );
  }
  const header = rows[0] as string[];
  const col = mapStockHeader(header);
  if (col.item === -1 && col.sku === -1) {
    throw new StockImportError(
      "no item column found — the header needs a name or a SKU column (item, name, product, sku)",
    );
  }
  if (col.on_hand === -1) {
    throw new StockImportError(
      "no stock column found — the header needs how many are on hand (on hand, stock, quantity)",
    );
  }
  const currency = options.currency?.trim().toUpperCase() ?? "";
  if ((col.unit_cost !== -1 || col.price !== -1) && !isIsoCurrency(currency)) {
    throw new StockImportError(
      "the file has a cost or price column — say which currency it is in (three letters, e.g. EUR)",
    );
  }
  // The money columns' style, settled by the file or the owner's word, as a date order is.
  const moneyCells = rows
    .slice(1)
    .flatMap((r) => [col.unit_cost, col.price].filter((i) => i !== -1).map((i) => r[i] ?? ""));
  const settled = settleDecimalStyle(moneyCells, options.decimal_style ?? null);
  if (!settled.ok) throw new StockImportError(DECIMAL_STYLE_MESSAGES[settled.reason]);
  const style = settled.style;
  const windowDays = options.window_days;
  if (
    col.units_sold !== -1 &&
    (windowDays === undefined ||
      !Number.isSafeInteger(windowDays) ||
      windowDays < 1 ||
      windowDays > MAX_WINDOW_DAYS)
  ) {
    throw new StockImportError(
      "the file has a units-sold column — say how many days it covers (for example 90)",
    );
  }

  const asOf = options.as_of;
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const columns: Partial<Record<StockRole, string>> = {};
  for (const role of STOCK_ROLES) {
    const i = col[role];
    if (i !== -1) columns[role] = (header[i] ?? "").trim();
  }
  const skipped = { no_item: 0, on_hand_unreadable: 0, duplicate_in_file: 0 };
  const unreadable = { unit_cost: 0, price: 0, last_sold: 0, units_sold: 0 };
  const seen = new Set<string>();
  const out: Observation[] = [];
  let imported = 0;

  for (const raw of rows.slice(1)) {
    const cell = (i: number) => (i >= 0 ? (raw[i] ?? "").trim() : "");
    const sku = cell(col.sku);
    const name = cell(col.item) || sku;
    const ref = itemRef(sku, name);
    if (ref === null) {
      skipped.no_item++;
      continue;
    }
    if (seen.has(ref)) {
      skipped.duplicate_in_file++;
      continue;
    }
    const onHand = parseUnits(cell(col.on_hand));
    if (onHand === null) {
      skipped.on_hand_unreadable++;
      continue;
    }
    seen.add(ref);
    imported++;
    const dims = { product_ref: ref, item_name: name };
    const at = { period_date: asOf, observed_at: observedAt };
    out.push({ metric_key: "stock.on_hand", dimensions: dims, value_num: onHand, ...at });

    const money = (role: "unit_cost" | "price") => {
      const text = cell(col[role]);
      if (text === "") return null;
      const minor = parseStockMoney(text, currency, style);
      if (minor === null) unreadable[role]++;
      return minor;
    };
    const cost = money("unit_cost");
    if (cost !== null) {
      out.push({
        metric_key: "stock.value_at_cost",
        dimensions: { ...dims, currency },
        value_minor: onHand * cost,
        ...at,
      });
    }
    const price = money("price");
    if (price !== null) {
      out.push({
        metric_key: "stock.value_at_price",
        dimensions: { ...dims, currency },
        value_minor: onHand * price,
        ...at,
      });
    }

    const lastText = cell(col.last_sold);
    if (lastText !== "") {
      const iso = parseDate(lastText);
      const ms = iso === null ? Number.NaN : Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
      // A sale after the count date can't have happened yet as of the count.
      if (!Number.isFinite(ms) || ms > asOfMs) unreadable.last_sold++;
      else {
        out.push({
          metric_key: "stock.days_since_sale",
          dimensions: dims,
          value_num: Math.round((asOfMs - ms) / 86_400_000),
          ...at,
        });
      }
    }
    const soldText = cell(col.units_sold);
    if (soldText !== "") {
      const sold = parseUnits(soldText);
      if (sold === null) unreadable.units_sold++;
      else {
        out.push({
          metric_key: "stock.units_sold_window",
          dimensions: { ...dims, window_days: String(windowDays) },
          value_num: sold,
          ...at,
        });
      }
    }
  }
  return { observations: out, result: { as_of: asOf, imported, columns, skipped, unreadable } };
}

/** The account's one import connection, created on first use. Holds no secret and no scopes. */
async function importConnection(accountId: string): Promise<string> {
  const where = and(
    eq(connections.account_id, accountId),
    eq(connections.provider, STOCK_IMPORT_PROVIDER),
    eq(connections.purpose, "import"),
    ne(connections.status, "disconnected"),
  );
  const [existing] = await db.select({ id: connections.id }).from(connections).where(where);
  if (existing) return existing.id;
  const [row] = await db
    .insert(connections)
    .values({
      account_id: accountId,
      provider: STOCK_IMPORT_PROVIDER,
      purpose: "import",
      status: "connected",
      encrypted_secret: null,
      granted_scopes: [],
    })
    .onConflictDoNothing()
    .returning({ id: connections.id });
  if (row) return row.id;
  const [raced] = await db.select({ id: connections.id }).from(connections).where(where);
  if (!raced) throw new StockImportError("the import could not be recorded", 500);
  return raced.id;
}

/**
 * Import a stock file for an account: observations under its import
 * connection, and one decision-log entry for the batch (counts and a hash).
 */
export async function importStockFile(
  accountId: string,
  csv: string,
  options: StockImportOptions = {},
): Promise<StockImportResult> {
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const asOf = options.as_of?.trim() || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) {
    throw new StockImportError("the count date must be a day, like 2026-10-22");
  }
  if (asOf > today) throw new StockImportError("the count date can't be in the future");
  const { observations, result } = stockFileObservations(
    csv,
    { ...options, as_of: asOf },
    now.toISOString(),
  );
  if (result.imported === 0) {
    throw new StockImportError("no item in the file could be read — nothing was imported");
  }

  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, accountId));
  if (!profile) throw new StockImportError("this account has no business profile yet", 409);

  const connectionId = await importConnection(accountId);
  const batchId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await upsertObservations(connectionId, STOCK_IMPORT_PROVIDER, observations, tx);
    await tx.insert(decisionLog).values({
      profile_id: profile.id,
      actor: "owner",
      kind: "import",
      ref_id: batchId,
      payload_hash: createHash("sha256")
        .update(
          JSON.stringify({
            kind: "stock_import",
            account_id: accountId,
            batch_id: batchId,
            connection_id: connectionId,
            as_of: asOf,
            imported: result.imported,
            columns: result.columns,
            skipped: result.skipped,
            unreadable: result.unreadable,
            sha256: createHash("sha256").update(csv).digest("hex"),
          }),
        )
        .digest("hex"),
    });
  });
  console.log(
    JSON.stringify({
      event: "stock_imported",
      account_id: accountId,
      batch_id: batchId,
      as_of: asOf,
      imported: result.imported,
      skipped: result.skipped,
      unreadable: result.unreadable,
    }),
  );
  return { batch_id: batchId, ...result };
}
