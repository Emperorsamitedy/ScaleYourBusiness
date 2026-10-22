// Reading an export's cells — dates, times, delimiters. Pure and
// deterministic: a value that cannot be read is null, and the caller counts
// it. Nothing here guesses (specs/bookings.md §3, "Dates").

export type DateOrder = "dmy" | "mdy";

/** A spreadsheet's delimiter: whichever of , ; or tab splits the header into the most cells. */
export function detectDelimiter(text: string): "," | ";" | "\t" {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const count = (d: string) => firstLine.split(d).length;
  const candidates = [",", ";", "\t"] as const;
  let best: "," | ";" | "\t" = ",";
  for (const d of candidates) if (count(d) > count(best)) best = d;
  return best;
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF, any of three delimiters. */
export function parseDelimited(text: string, delimiter = detectDelimiter(text)): string[][] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a BOM from Excel
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
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
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
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

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

/** "Oct", "October", "Sept" → 10, 10, 9. A word that isn't a month (or its start) → null. */
function monthNumber(name: string): number | null {
  const n = name.toLowerCase();
  if (n.length < 3) return null;
  const i = MONTH_NAMES.findIndex((full) => full.startsWith(n));
  return i === -1 ? null : i + 1;
}

function ymd(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null; // 31 February
  return t.toISOString().slice(0, 10);
}

/** What a slash or dot date proves about the file's order: the side above 12 is the day. */
export function slashEvidence(raw: string): DateOrder | "ambiguous" | null {
  const m = /^\s*(\d{1,2})[./](\d{1,2})[./](\d{4})\b/.exec(raw);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a > 12 && b <= 12) return "dmy";
  if (b > 12 && a <= 12) return "mdy";
  return "ambiguous";
}

export interface ParsedDateTime {
  day: string;
  /** "HH:MM", or null when the cell carries only a date. */
  time: string | null;
}

/**
 * A date, optionally followed by a time: ISO, slash or dot dates in the
 * batch's order, and English month names. Null for anything else.
 */
export function parseDateTime(raw: string, order: DateOrder | null): ParsedDateTime | null {
  const v = raw.trim().replace(/\s+/g, " ");
  if (v === "") return null;
  let day: string | null = null;
  let rest = "";

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](.*))?$/.exec(v);
  const slash = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:,? (.*))?$/.exec(v);
  const named = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})(?:,? (.*))?$/.exec(v);
  const namedUs = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})(?:,? (.*))?$/.exec(v);
  if (iso) {
    day = ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    rest = iso[4] ?? "";
  } else if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const proven = slashEvidence(v);
    const use = proven === "dmy" || proven === "mdy" ? proven : order;
    if (use === null) return null; // ambiguous and the owner hasn't said: never guessed
    day = use === "dmy" ? ymd(Number(slash[3]), b, a) : ymd(Number(slash[3]), a, b);
    rest = slash[4] ?? "";
  } else if (named) {
    const m = monthNumber(named[2] ?? "");
    day = m === null ? null : ymd(Number(named[3]), m, Number(named[1]));
    rest = named[4] ?? "";
  } else if (namedUs) {
    const m = monthNumber(namedUs[1] ?? "");
    day = m === null ? null : ymd(Number(namedUs[3]), m, Number(namedUs[2]));
    rest = namedUs[4] ?? "";
  }
  if (day === null) return null;
  if (rest.trim() === "") return { day, time: null };
  const time = parseTime(rest);
  return time === null ? null : { day, time };
}

/**
 * "14:30", "14:30:00", "2:30 PM", "2pm", "14.30" → "HH:MM". A trailing zone
 * ("Z", "+02:00") is ignored: the wall clock in the file is what counts.
 */
export function parseTime(raw: string): string | null {
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/(?:z|[+-]\d{2}:?\d{2})$/, "")
    .replace(/\.\d+$/, "")
    .trim();
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.)?$/.exec(v);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[4]?.replace(/\./g, "");
  if (m[2] === undefined && meridiem === undefined) return null; // "14" alone is not a time
  if (meridiem !== undefined) {
    if (h < 1 || h > 12) return null;
    if (meridiem === "am") h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** "45", "45 min", "1:15" (h:mm), "1h 15m" → minutes. Null otherwise. */
export function parseDuration(raw: string): number | null {
  const v = raw.trim().toLowerCase();
  if (v === "") return null;
  let m = /^(\d{1,4})\s*(?:m|min|mins|minutes)?$/.exec(v);
  if (m) return Number(m[1]);
  m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(?:(\d{1,2})\s*h(?:ours?|rs?)?)?\s*(?:(\d{1,3})\s*m(?:in|ins|inutes)?)?$/.exec(v);
  if (m && (m[1] !== undefined || m[2] !== undefined)) {
    return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  }
  return null;
}

/** Minutes from a to b, both a day and an optional time (midnight when absent). */
export function minutesBetween(a: ParsedDateTime, b: ParsedDateTime): number {
  const at = (p: ParsedDateTime) => Date.parse(`${p.day}T${p.time ?? "00:00"}:00Z`);
  return (at(b) - at(a)) / 60_000;
}
