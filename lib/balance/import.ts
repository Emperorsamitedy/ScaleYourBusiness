// A bank statement's balance, imported — I-54a (owner, 2026-11-01: "go
// ahead with I-54a", then, asked which balance: a bank statement upload).
//
// The owner exports a statement from their bank as CSV and gives SYB the
// file. SYB reads two columns and nothing else: each row's date, and the
// running balance after it. Descriptions, payees and amounts aren't read
// or kept. Every day from the first row to the day the statement runs to
// gets its closing balance as an observation, exactly like a connector's
// (rule 2): `cash.balance`, integer minor units in the currency the owner
// names (rule 1), under the account's one balance-import connection, dated
// the day it was true and observed at the moment of import. A re-import of
// the same days replaces them (the natural key), and the batch is one
// decision-log entry with counts and a hash.
//
// It is a read of what the bank already says, the same as a stock count's
// file, and moves nothing: no bank is connected, there is no credential,
// and no provider for a bank exists on either side (rule 26,
// lib/cash/fence.test.ts). The cash forecast reads the balance as cash
// today (lib/cash/load), and the track record grades its weekly closing
// balances by it (lib/forecasts).
//
// The columns are mapped AS DATA (rule 4): BALANCE_COLUMNS lists the
// header spellings per role. No model reads the file (cost rule). A row
// whose date or balance can't be read is left out and counted, never
// guessed; a date order or decimal style the file can't prove is asked.
//
// Which row closes a day: a statement lists rows newest first or oldest
// first. The file's own first and last dates say which, and the row
// latest in time closes each day. A file whose dates go both ways is
// refused; within a one-day file, rows that disagree are counted, not
// guessed.

import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, connections, decisionLog } from "../../db/schema";
import type { DateOrder } from "../bookings/parse";
import { parseDateTime, parseDelimited, slashEvidence } from "../bookings/parse";
import { upsertObservations } from "../connectors/service";
import type { Observation } from "../connectors/provider";
import type { DecimalStyle } from "../core/money";
import { BALANCE_IMPORT_PROVIDER, BALANCE_METRIC } from "./source";
import {
  DECIMAL_STYLE_MESSAGES,
  isIsoCurrency,
  parseAmountMinor,
  settleDecimalStyle,
} from "../core/money";

export { BALANCE_IMPORT_PROVIDER };

export const BALANCE_IMPORT_LIMITS = {
  max_rows: 20_000,
  max_bytes: 2_000_000,
  /** Days one statement may cover, first row to the day it runs to. */
  max_days: 400,
} as const;

/**
 * The column map, as data: role → the header spellings that mean it,
 * compared after lower-casing and dropping spaces, dashes, underscores and
 * dots. The first header that matches a role takes it.
 */
export const BALANCE_COLUMNS = {
  date: [
    "date",
    "bookingdate",
    "transactiondate",
    "posteddate",
    "postingdate",
    "posted",
    "completeddate",
    "valuedate",
    "datum",
    "buchungsdatum",
    "fecha",
    "dateoperation",
    "dátum",
    "könyvelésdátuma",
  ],
  balance: [
    "balance",
    "runningbalance",
    "closingbalance",
    "balanceafter",
    "accountbalance",
    "ledgerbalance",
    "bookedbalance",
    "saldo",
    "kontostand",
    "solde",
    "egyenleg",
  ],
} as const;

export type BalanceRole = keyof typeof BALANCE_COLUMNS;

export class BalanceImportError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "BalanceImportError";
    this.status = status;
  }
}

export interface BalanceImportOptions {
  /** ISO 4217 the account is held in. Required: a balance without its currency is a bare number. */
  currency: string;
  decimal_style?: DecimalStyle | null;
  /** Day first or month first, when the file's slash dates can't prove it. */
  date_order?: DateOrder | null;
  /**
   * "YYYY-MM-DD": the last day the statement covers. Defaults to its last
   * row's day. A quiet day after that row keeps the same balance; a day
   * after this one is never assumed.
   */
  through?: string;
  now?: Date;
}

export interface BalanceImportResult {
  batch_id: string;
  from: string;
  through: string;
  /** Days given a closing balance. */
  days: number;
  rows_read: number;
  columns: Partial<Record<BalanceRole, string>>;
  /** Rows left out, by why — never guessed. */
  skipped: { date_unreadable: number; balance_unreadable: number; day_unclear: number };
  /** The closing balance on the last day covered. */
  latest: { day: string; amount_minor: number; currency: string };
}

const norm = (h: string) => h.toLowerCase().replace(/[\s_\-.]/g, "");

/** Pure: which column holds each role, or -1. A header matches one role at most. */
export function mapBalanceHeader(header: readonly string[]): Record<BalanceRole, number> {
  const taken = new Set<number>();
  const out = { date: -1, balance: -1 } as Record<BalanceRole, number>;
  for (const role of Object.keys(BALANCE_COLUMNS) as BalanceRole[]) {
    const spellings: readonly string[] = BALANCE_COLUMNS[role];
    const i = header.findIndex((h, j) => !taken.has(j) && spellings.includes(norm(h)));
    if (i !== -1) {
      out[role] = i;
      taken.add(i);
    }
  }
  return out;
}

const DAY_MS = 86_400_000;
const addDay = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Pure: the file → one closing balance per day, plus what was left out. */
export function statementBalances(
  csv: string,
  options: BalanceImportOptions & { today: string },
): Omit<BalanceImportResult, "batch_id"> & { closing: Map<string, number> } {
  if (csv.length > BALANCE_IMPORT_LIMITS.max_bytes) {
    throw new BalanceImportError("that file is too large for one import — split it", 413);
  }
  const currency = options.currency?.trim().toUpperCase() ?? "";
  if (!isIsoCurrency(currency)) {
    throw new BalanceImportError("say which currency the account is in (three letters, e.g. EUR)");
  }
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const rows = parseDelimited(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length < 2) throw new BalanceImportError("the file needs a header row and one row");
  if (rows.length - 1 > BALANCE_IMPORT_LIMITS.max_rows) {
    throw new BalanceImportError(
      `one import takes up to ${BALANCE_IMPORT_LIMITS.max_rows} rows — split the file`,
      413,
    );
  }
  const header = rows[0]!;
  const col = mapBalanceHeader(header);
  if (col.date === -1) {
    throw new BalanceImportError(
      "no date column found — the header needs a date (date, booking date)",
    );
  }
  if (col.balance === -1) {
    throw new BalanceImportError(
      "no balance column found — the statement needs the running balance after each row (balance, running balance). A file of amounts alone can't say what was in the account.",
    );
  }
  const body = rows.slice(1);
  const cell = (r: string[], i: number) => (r[i] ?? "").trim();

  // The date order: proven by the file, or the owner's word; never guessed.
  const evidence = new Set(
    body.map((r) => slashEvidence(cell(r, col.date))).filter((e) => e === "dmy" || e === "mdy"),
  );
  if (evidence.size > 1) {
    throw new BalanceImportError(
      "the dates in this file are written both day-first and month-first",
    );
  }
  const order: DateOrder | null = [...evidence][0] ?? options.date_order ?? null;

  const settled = settleDecimalStyle(
    body.map((r) => cell(r, col.balance)),
    options.decimal_style ?? null,
  );
  if (!settled.ok) throw new BalanceImportError(DECIMAL_STYLE_MESSAGES[settled.reason]);

  const skipped = { date_unreadable: 0, balance_unreadable: 0, day_unclear: 0 };
  const read: { day: string; minor: number }[] = [];
  let ambiguousDates = 0;
  for (const r of body) {
    const rawDate = cell(r, col.date);
    const parsed = parseDateTime(rawDate, order);
    if (parsed === null) {
      if (order === null && slashEvidence(rawDate) === "ambiguous") ambiguousDates++;
      skipped.date_unreadable++;
      continue;
    }
    const amount = parseAmountMinor(cell(r, col.balance), currency, settled.style);
    if (!amount.ok) {
      skipped.balance_unreadable++;
      continue;
    }
    read.push({ day: parsed.day, minor: amount.minor });
  }
  if (ambiguousDates > 0 && read.length === 0) {
    throw new BalanceImportError(
      "dates like 03/04/2026 could be 3 April or 4 March — say whether the day or the month comes first",
    );
  }
  if (read.length === 0) {
    throw new BalanceImportError("no row in the file could be read — nothing was imported");
  }

  // Newest first or oldest first, by the file's own dates; both ways is refused.
  let up = false;
  let down = false;
  for (let i = 1; i < read.length; i++) {
    if (read[i]!.day > read[i - 1]!.day) up = true;
    if (read[i]!.day < read[i - 1]!.day) down = true;
  }
  if (up && down) {
    throw new BalanceImportError(
      "the rows aren't in date order, so I can't tell which balance closed each day — export the statement sorted by date",
    );
  }
  const latestFirst = down;
  const closing = new Map<string, number>();
  const disagree = new Set<string>();
  for (const r of read) {
    if (!closing.has(r.day)) {
      closing.set(r.day, r.minor);
    } else if (!latestFirst) {
      if (up)
        closing.set(r.day, r.minor); // oldest first: the day's last row closes it
      else if (closing.get(r.day) !== r.minor) disagree.add(r.day);
    }
  }
  // A one-day file with rows that disagree: the order can't be told, so that day isn't kept.
  for (const day of disagree) {
    skipped.day_unclear += read.filter((r) => r.day === day).length;
    closing.delete(day);
  }
  if (closing.size === 0) {
    throw new BalanceImportError(
      "the rows of that one day disagree and the file can't say which came last — nothing was imported",
    );
  }

  const days = [...closing.keys()].sort();
  const from = days[0]!;
  const lastRow = days[days.length - 1]!;
  const through = options.through?.trim() || lastRow;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through) || Number.isNaN(Date.parse(`${through}T00:00:00Z`))) {
    throw new BalanceImportError("the day the statement runs to must be a day, like 2026-10-31");
  }
  if (through < lastRow) {
    throw new BalanceImportError("the statement has rows after the day you said it runs to");
  }
  if (through > options.today || lastRow > options.today) {
    throw new BalanceImportError("a statement can't run past today");
  }
  const span =
    Math.round((Date.parse(`${through}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (span > BALANCE_IMPORT_LIMITS.max_days) {
    throw new BalanceImportError(
      `one import covers up to ${BALANCE_IMPORT_LIMITS.max_days} days — split the statement`,
      413,
    );
  }

  // Every day from the first to the statement's end: a quiet day keeps the balance before it.
  const filled = new Map<string, number>();
  let last = closing.get(from)!;
  for (let day = from; day <= through; day = addDay(day, 1)) {
    if (closing.has(day)) last = closing.get(day)!;
    filled.set(day, last);
  }

  const columns: Partial<Record<BalanceRole, string>> = {
    date: (header[col.date] ?? "").trim(),
    balance: (header[col.balance] ?? "").trim(),
  };
  return {
    from,
    through,
    days: filled.size,
    rows_read: read.length - skipped.day_unclear,
    columns,
    skipped,
    latest: { day: through, amount_minor: filled.get(through)!, currency },
    closing: filled,
  };
}

/** Pure: the closing balances as observations. */
export function balanceObservations(
  closing: ReadonlyMap<string, number>,
  currency: string,
  observedAt: string,
): Observation[] {
  return [...closing.entries()].map(([day, minor]) => ({
    metric_key: BALANCE_METRIC,
    dimensions: { currency },
    value_minor: minor,
    period_date: day,
    observed_at: observedAt,
  }));
}

/** The account's one balance-import connection, created on first use. No secret, no scopes. */
async function balanceConnection(accountId: string): Promise<string> {
  const where = and(
    eq(connections.account_id, accountId),
    eq(connections.provider, BALANCE_IMPORT_PROVIDER),
    eq(connections.purpose, "import"),
    ne(connections.status, "disconnected"),
  );
  const [existing] = await db.select({ id: connections.id }).from(connections).where(where);
  if (existing) return existing.id;
  const [row] = await db
    .insert(connections)
    .values({
      account_id: accountId,
      provider: BALANCE_IMPORT_PROVIDER,
      purpose: "import",
      status: "connected",
      encrypted_secret: null,
      granted_scopes: [],
    })
    .onConflictDoNothing()
    .returning({ id: connections.id });
  if (row) return row.id;
  const [raced] = await db.select({ id: connections.id }).from(connections).where(where);
  if (!raced) throw new BalanceImportError("the import could not be recorded", 500);
  return raced.id;
}

/**
 * Import a bank statement for an account: its closing balances under the
 * balance-import connection, and one decision-log entry for the batch
 * (counts and a hash of the file, never its contents).
 */
export async function importBankStatement(
  accountId: string,
  csv: string,
  options: BalanceImportOptions,
): Promise<BalanceImportResult> {
  const now = options.now ?? new Date();
  const { closing, ...result } = statementBalances(csv, {
    ...options,
    today: now.toISOString().slice(0, 10),
  });
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, accountId));
  if (!profile) throw new BalanceImportError("this account has no business profile yet", 409);

  const connectionId = await balanceConnection(accountId);
  const batchId = crypto.randomUUID();
  const observations = balanceObservations(closing, result.latest.currency, now.toISOString());
  await db.transaction(async (tx) => {
    await upsertObservations(connectionId, BALANCE_IMPORT_PROVIDER, observations, tx);
    await tx.insert(decisionLog).values({
      profile_id: profile.id,
      actor: "owner",
      kind: "import",
      ref_id: batchId,
      payload_hash: createHash("sha256")
        .update(
          JSON.stringify({
            kind: "balance_import",
            account_id: accountId,
            batch_id: batchId,
            connection_id: connectionId,
            from: result.from,
            through: result.through,
            days: result.days,
            rows_read: result.rows_read,
            columns: result.columns,
            skipped: result.skipped,
            sha256: createHash("sha256").update(csv).digest("hex"),
          }),
        )
        .digest("hex"),
    });
  });
  console.log(
    JSON.stringify({
      event: "balance_imported",
      account_id: accountId,
      batch_id: batchId,
      from: result.from,
      through: result.through,
      days: result.days,
      skipped: result.skipped,
    }),
  );
  return { batch_id: batchId, ...result };
}
