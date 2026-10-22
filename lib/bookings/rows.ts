// A bookings export → appointments, before anything is stored
// (specs/bookings.md §3). Pure: the client identity is hashed by the
// caller's keyOf() as each row is read, so the output never carries a name,
// an email or a phone. A row that can't be read is counted under its
// reason and left out; a cell that can't be read leaves just that value
// out, counted. Nothing is guessed.

import { createHash } from "node:crypto";
import { parseMoneyMinor } from "../core/money";
import type { BookingPlatform, ColumnMap, ColumnRole } from "./import-map";
import { mapColumns, statusTarget } from "./import-map";
import type { DateOrder, ParsedDateTime } from "./parse";
import {
  detectDelimiter,
  minutesBetween,
  parseDateTime,
  parseDelimited,
  parseDuration,
  slashEvidence,
} from "./parse";
import type { BookingInput, BookingStatus, ClientIdentity } from "./types";

/** A cancellation made less than this long before the start is late (specs/bookings.md §3). */
export const LATE_CANCEL_HOURS = 24;
export const MAX_IMPORT_BYTES = 5_000_000;
export const MAX_IMPORT_ROWS = 50_000;

export class BookingImportError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "BookingImportError";
    this.status = status;
  }
}

/** Why a whole row was left out. */
export const ROW_SKIP_REASONS = [
  "no_date",
  "unreadable_date",
  "no_status",
  "unknown_status",
  "not_closed_out",
] as const;
export type RowSkipReason = (typeof ROW_SKIP_REASONS)[number];

/** Which single values were left out of rows that were kept. */
export const CELL_GAPS = ["time", "price", "duration", "cancelled_at", "client"] as const;
export type CellGap = (typeof CELL_GAPS)[number];

export interface ExportOptions {
  platform: BookingPlatform;
  /** ISO 4217 for the price column; required when the file has one (rule 1). */
  currency: string | null;
  /** For slash dates the file itself can't settle (03/04/2026). */
  dateOrder: DateOrder | null;
  /** "YYYY-MM-DD" — the import's day: a booked appointment after it is booked_future. */
  today: string;
}

export interface ReadExport {
  /** Role → the header as the file wrote it. */
  columns: Partial<Record<ColumnRole, string>>;
  rows_read: number;
  appointments: BookingInput[];
  skipped: Partial<Record<RowSkipReason, number>>;
  /** Unknown status words, as written, with how often — so the owner can see what wasn't understood. */
  unknown_statuses: Record<string, number>;
  gaps: Partial<Record<CellGap, number>>;
  /** Rows sharing one booking reference, merged into one appointment (multi-service bookings). */
  merged_lines: number;
  /** The column the client key came from, or null when the file has no usable identity. */
  identity: "client_id" | "client_email" | "client_phone" | null;
  /** The date order used for slash dates, and whether the file proved it. */
  date_order: { order: DateOrder; proven: boolean } | null;
}

const bump = <K extends string>(m: Partial<Record<K, number>>, k: K) => {
  m[k] = (m[k] ?? 0) + 1;
};

const clip = (v: string): string | null => {
  const t = v.trim();
  return t === "" ? null : t.slice(0, 200);
};

/** Settle the order of slash dates from the file itself, or from what the owner said. */
function settleDateOrder(
  cells: readonly string[],
  stated: DateOrder | null,
): { order: DateOrder; proven: boolean } | null {
  const seen = new Set<DateOrder | "ambiguous">();
  for (const c of cells) {
    const e = slashEvidence(c);
    if (e !== null) seen.add(e);
  }
  if (seen.has("dmy") && seen.has("mdy")) {
    throw new BookingImportError(
      "the dates in this file are written both day-first and month-first (13/01 and 01/13), so I can't read them",
    );
  }
  const proven = seen.has("dmy") ? "dmy" : seen.has("mdy") ? "mdy" : null;
  if (proven !== null) {
    if (stated !== null && stated !== proven) {
      throw new BookingImportError(
        `you said the dates are ${stated === "dmy" ? "day first" : "month first"}, but the file has dates that only read ${proven === "dmy" ? "day first" : "month first"}`,
      );
    }
    return { order: proven, proven: true };
  }
  if (seen.has("ambiguous")) {
    if (stated === null) {
      throw new BookingImportError(
        "dates like 03/04/2026 could be 3 April or 4 March — say whether the day or the month comes first",
      );
    }
    return { order: stated, proven: false };
  }
  return null;
}

/** Read one export. Throws BookingImportError for a file it can't honestly read at all. */
export function readExport(
  text: string,
  options: ExportOptions,
  keyOf: (identity: ClientIdentity) => string | null,
): ReadExport {
  if (text.length > MAX_IMPORT_BYTES) {
    throw new BookingImportError("that file is too large for one import — split it by date", 413);
  }
  const table = parseDelimited(text, detectDelimiter(text));
  if (table.length < 2) {
    throw new BookingImportError("the file needs a header row and at least one appointment");
  }
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    throw new BookingImportError(
      `one import takes up to ${MAX_IMPORT_ROWS} appointments — split the file by date`,
      413,
    );
  }
  const header = table[0] as string[];
  const map: ColumnMap = mapColumns(header, options.platform);
  const columns: Partial<Record<ColumnRole, string>> = {};
  for (const [role, i] of Object.entries(map) as [ColumnRole, number][]) {
    columns[role] = (header[i] ?? "").trim();
  }

  const dateRole: ColumnRole | null =
    map.date !== undefined
      ? "date"
      : map.start !== undefined
        ? "start"
        : map.time !== undefined
          ? "time"
          : null;
  if (dateRole === null) {
    throw new BookingImportError(
      "I couldn't find a date column — the header needs one, such as Date or Start",
    );
  }
  if (map.status === undefined) {
    throw new BookingImportError(
      "I couldn't find a status column. Without it a kept appointment and a no-show look the same, so I won't guess",
    );
  }
  const currency = options.currency?.trim().toUpperCase() ?? "";
  if (map.price !== undefined && !/^[A-Z]{3}$/.test(currency)) {
    throw new BookingImportError(
      "the file has a price column — say which currency it is in (three letters, e.g. EUR)",
    );
  }

  const body = table.slice(1);
  const cell = (row: readonly string[], role: ColumnRole): string => {
    const i = map[role];
    return i === undefined ? "" : (row[i] ?? "").trim();
  };
  const dateOrder = settleDateOrder(
    body.map((r) => cell(r, dateRole)).concat(body.map((r) => cell(r, "cancelled_at"))),
    options.dateOrder,
  );
  const order = dateOrder?.order ?? null;

  const identity: ReadExport["identity"] =
    map.client_id !== undefined
      ? "client_id"
      : map.client_email !== undefined
        ? "client_email"
        : map.client_phone !== undefined
          ? "client_phone"
          : null;

  const skipped: ReadExport["skipped"] = {};
  const gaps: ReadExport["gaps"] = {};
  const unknown: Record<string, number> = {};
  const byRef = new Map<string, BookingInput>();
  const ordinals = new Map<string, number>();
  const out: BookingInput[] = [];
  let merged = 0;

  for (const row of body) {
    // The day.
    const dateRaw = cell(row, dateRole);
    if (dateRaw === "") {
      bump(skipped, "no_date");
      continue;
    }
    let when: ParsedDateTime | null = parseDateTime(dateRaw, order);
    if (when === null) {
      bump(skipped, "unreadable_date");
      continue;
    }
    if (dateRole === "date" && map.time !== undefined) {
      const timeRaw = cell(row, "time");
      if (timeRaw !== "") {
        const t = parseDateTime(`${when.day} ${timeRaw}`, order);
        if (t === null) bump(gaps, "time");
        else when = t;
      }
    }

    // What happened.
    const statusRaw = cell(row, "status");
    if (statusRaw === "") {
      bump(skipped, "no_status");
      continue;
    }
    const target = statusTarget(statusRaw, options.platform);
    if (target === null) {
      bump(skipped, "unknown_status");
      const word = statusRaw.slice(0, 40);
      unknown[word] = (unknown[word] ?? 0) + 1;
      continue;
    }
    let status: BookingStatus;
    if (target === "booked" || target === "accepted") {
      if (when.day <= options.today) {
        bump(skipped, "not_closed_out");
        continue;
      }
      status = "booked_future";
    } else if (target === "cancelled" && map.cancelled_at !== undefined) {
      status = "cancelled";
      const raw = cell(row, "cancelled_at");
      if (raw !== "") {
        const at = parseDateTime(raw, order);
        // Lateness needs both clocks; a date alone would be a guess.
        if (at === null || at.time === null || when.time === null) bump(gaps, "cancelled_at");
        else if (minutesBetween(at, when) < LATE_CANCEL_HOURS * 60) status = "cancelled_late";
      }
    } else {
      status = target;
    }

    // The values that ride along.
    let price_minor: number | null = null;
    const priceRaw = cell(row, "price");
    if (priceRaw !== "") {
      const p = parseMoneyMinor(priceRaw, currency);
      if (p === null || p < 0) bump(gaps, "price");
      else price_minor = p;
    }
    let duration: number | null = null;
    const durationRaw = cell(row, "duration");
    if (durationRaw !== "") {
      const d = parseDuration(durationRaw);
      if (d === null || d > 1440) bump(gaps, "duration");
      else duration = d;
    }
    let client_key: string | null = null;
    if (identity !== null) {
      const raw = cell(row, identity);
      const kind =
        identity === "client_id" ? "id" : identity === "client_email" ? "email" : "phone";
      client_key = raw === "" ? null : keyOf({ kind, value: raw });
      if (client_key === null) bump(gaps, "client");
    }
    const service = clip(cell(row, "service"));
    const staff = clip(cell(row, "staff"));

    // Which appointment this is.
    const ref = clip(cell(row, "ref"));
    if (ref !== null) {
      const source_ref = `${options.platform}:ref:${ref}`;
      const seen = byRef.get(source_ref);
      if (seen) {
        // One booking, several lines (a cut and a colour): one appointment.
        merged++;
        if (seen.price_minor !== null && price_minor !== null) seen.price_minor += price_minor;
        else if (seen.price_minor === null && price_minor !== null) {
          seen.price_minor = price_minor;
          seen.currency = currency;
        }
        if (seen.duration_minutes !== null && duration !== null) seen.duration_minutes += duration;
        continue;
      }
      const input: BookingInput = {
        source_ref,
        day: when.day,
        start_time: when.time,
        status,
        service,
        staff_ref: staff,
        client: null,
        duration_minutes: duration,
        price_minor,
        currency: price_minor === null ? null : currency,
      };
      withKey(input, client_key);
      byRef.set(source_ref, input);
      out.push(input);
      continue;
    }
    // No reference: a content key, numbered within the file so a class of
    // twelve stays twelve, and the same file re-imported gives the same keys.
    const content = createHash("sha256")
      .update(
        [when.day, when.time ?? "", client_key ?? "", service ?? "", staff ?? ""].join("\u0000"),
      )
      .digest("hex")
      .slice(0, 32);
    const n = (ordinals.get(content) ?? 0) + 1;
    ordinals.set(content, n);
    const input: BookingInput = {
      source_ref: `${options.platform}:k:${content}:${n}`,
      day: when.day,
      start_time: when.time,
      status,
      service,
      staff_ref: staff,
      client: null,
      duration_minutes: duration,
      price_minor,
      currency: price_minor === null ? null : currency,
    };
    withKey(input, client_key);
    out.push(input);
  }

  return {
    columns,
    rows_read: body.length,
    appointments: out,
    skipped,
    unknown_statuses: unknown,
    gaps,
    merged_lines: merged,
    identity,
    date_order: dateOrder,
  };
}

function withKey(input: BookingInput, key: string | null): void {
  input.client = key === null ? null : { kind: "keyed", key };
}
