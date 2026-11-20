// Coverage by hour — P5-19 (Phase 5 Session E, step 93). Pure: no
// database, no clock, no model. Client-safe: it imports types and pure
// helpers only, so the /team screen can lay out what /api/team returns.
//
// Rule 28: staff planning is about ROLES, never people. What this reads,
// and all it reads:
//
//   demand   when appointments started and whether they held a slot (day,
//            start time, status: nothing about the client or who served
//            them), or hourly takings where there are no bookings, and the
//            busy season ahead from the business's own last year;
//   supply   the stated weekly capacity (1.4.2.3b), the stated opening
//            hours, and for each 9.2 row its role title and its hours a
//            week. A row's other answers are never inputs, and a name,
//            wherever one turns up, is never read: a test passes a roster
//            with names and proves the output is byte-identical without.
//
// Nothing here scores, ranks or compares anyone. The output is hours of
// the week, banded against the stated capacity, with roles as the only
// unit of supply, and notes for the owner that never name a person.
//
// The arithmetic (every threshold below is named and pinned by a test):
//
//   window     the last TEAM.window_days days to `asOf` (eight of each weekday)
//   held       completed + no-show + late-cancelled: the slots still held
//              when their time came. An appointment counts in its start hour.
//   open hours the owner's stated opening hours; where a weekday's hours
//              aren't stated, the hours appointments start in on at least
//              TEAM.footprint_share of that weekday's days (ASSUMED)
//   capacity   the stated appointments a week ÷ the open hours a week, the
//              same in every open hour (ASSUMED)
//   share      held in the hour ÷ capacity per open hour, per day; the cell
//              reports its typical day — the mean of the middle half of
//              the days, the lowest and highest quarter left out, so one
//              sick day or holiday doesn't move it — and the middle half
//              itself as the range (p25–p75)
//   short      even the low end of the middle half ≥ TEAM.short_share
//              (100%): on most days demand ran past what the stated
//              capacity covers. One busy day never makes an hour short.
//   quiet      even the high end of the middle half ≤ TEAM.quiet_share:
//              open, and little demand on most days
//   roles      role hours a week ÷ open hours a week = people of that role
//              on in an average open hour (ASSUMED: the rota isn't known)
//
// Rule 25: below TEAM.min_history_days of history it refuses, saying how
// much there is, what it can and can't say, and when it will be ready. It
// never borrows another business's pattern.
//
// L-4c (TASKS-LANGUAGES.md): every sentence here comes from the
// "teamWords" catalogue in the reader's language, figures and dates
// through Intl. English is the default, and says what the code always
// said. The owner's role titles and the numbers stay as they were given
// (rule 4): only the words around them are translated.

import type { BookingStatus } from "../bookings/types";
import type { Weekday } from "../hours/schedule";
import { dayMonth } from "../i18n/format";
import type { AppLocale } from "../i18n/locales";
import { rangeOf } from "../i18n/range";
import { intlTag } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";

/** The words coverage writes in, and the reader's locale: the "teamWords" catalogue. */
export interface TeamLang {
  tr: Tr;
  locale: AppLocale;
}

/** English, from messages/en.json: what every caller without a request gets. */
export const englishTeam = (): TeamLang => ({ tr: englishTr("teamWords"), locale: "en" });

export const TEAM_WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export const TEAM = {
  /** Days read, ending on `asOf`: eight of each weekday. */
  window_days: 56,
  /** Below this many days of history the reading refuses (rule 25). */
  min_history_days: 28,
  /** A weekday read on fewer days than this is too early to band. */
  min_days_per_weekday: 4,
  /** An hour whose middle half of days all reach this ran past what the stated capacity covers. */
  short_share: 1,
  /** An open hour whose middle half of days all sit at or below this is quiet. */
  quiet_share: 0.4,
  /** Without stated hours, an hour counts as open when appointments start in it on this share of days. */
  footprint_share: 0.25,
  /** Takings: an open hour at or under this share of the day's busiest hour is quiet. */
  quiet_takings_share: 0.25,
} as const;

/** The statuses that held a slot when its time came. */
const HELD: ReadonlySet<BookingStatus> = new Set(["completed", "no_show", "cancelled_late"]);

/** One appointment as this module reads it: when, and whether it held a slot. Nothing else. */
export interface SlotInput {
  /** "YYYY-MM-DD", the business's own date. */
  day: string;
  /** "HH:MM", or null when the source gave no time. */
  start_time: string | null;
  status: BookingStatus;
}

/** One 9.2 row as this module reads it: its role and its hours. Nothing else. */
export interface RoleInput {
  role_title: string | null;
  hours_per_week: number | null;
}

export interface TakingsInput {
  /** Where the takings were measured, in words (lib/hours/coverage). */
  source: string;
  currency: string;
  /** Trading day → trading hour → takings, minor units. */
  byDay: ReadonlyMap<string, ReadonlyMap<number, number>>;
  /** The measured trading days of each weekday. */
  measuredDays: ReadonlyMap<Weekday, readonly string[]>;
}

export type SeasonInput =
  | { status: "unread"; reason: string }
  | { status: "none_ahead" }
  | {
      status: "busy_ahead";
      starts_on: string;
      ends_on: string;
      in_progress: boolean;
      index: number;
      low: number;
      high: number | null;
    };

export interface CoverageInput {
  /** The last day read ("YYYY-MM-DD"). */
  asOf: string;
  /** Bookings: the slots in the window, the source in words, and the first day ever booked. */
  bookings: { source: string; first_day: string | null; slots: readonly SlotInput[] } | null;
  /** Hourly takings, read when there are no bookings to hold against capacity. */
  takings: TakingsInput | null;
  /** The owner's stated appointments a week (service.capacity_per_week), or null. */
  capacityPerWeek: number | null;
  /** Stated opening hours: weekday → its open trading hours. A weekday absent is unstated. */
  openHours: Partial<Record<Weekday, readonly number[]>> | null;
  season: SeasonInput;
  roles: readonly RoleInput[];
}

export type Band = "short" | "ok" | "quiet";

export interface Spread {
  mean: number;
  /** The typical day (the middle half's mean): what bands an hour and what its words say. */
  typical: number;
  low: number;
  high: number;
}

export interface HourCell {
  hour: number;
  open: boolean;
  /** Held appointments (bookings) or takings in minor units (takings), per day. */
  demand: Spread | null;
  /** Share of the capacity per open hour (bookings) or of the day's busiest hour (takings). */
  share: Spread | null;
  band: Band | null;
}

export interface WeekdayCover {
  weekday: Weekday;
  days_read: number;
  verdict: "read" | "too_early" | "closed";
  /** How this weekday's open hours are known. */
  hours_from: "stated" | "bookings" | "takings" | null;
  cells: HourCell[];
}

export interface RoleCover {
  /** The role title as the owner wrote it ("Untitled role" when none). */
  role: string;
  /** How many 9.2 rows share this title. */
  rows: number;
  /** Their stated hours a week, summed; null when none of them stated hours. */
  hours_per_week: number | null;
  /** Rows of this role whose hours weren't stated. */
  unstated_rows: number;
  /** People of this role on in an average open hour (ASSUMED even spread); null without hours. */
  on_per_open_hour: number | null;
}

export interface CoverFinding {
  weekday: Weekday;
  from_hour: number;
  /** Exclusive: 10 to 14 is "10:00–14:00". */
  to_hour: number;
  band: "short" | "quiet";
  share: Spread;
  days: number;
  /** "Saturdays 10:00–14:00 ran 96% booked". */
  words: string;
  /** "(91–100% on the middle half of the 8 Saturdays read)". */
  range_words: string;
  /** "one stylist covers about 1 appointment an hour". */
  reason: string;
  /** The range and the reason as one sentence, joined the language's way: "(…); one stylist …". */
  line: string;
  /** A note for the owner about the hours and the role: never about a person. */
  note: string;
}

export interface Capacity {
  per_week: number;
  open_hours_per_week: number;
  per_open_hour: number;
  /** Total people on in an average open hour, from the role hours; null without any. */
  people_on: number | null;
  /** Capacity per person on (per_open_hour ÷ people_on); null without role hours. */
  per_person_on: number | null;
}

export type CoverageResult =
  | {
      status: "refused";
      headline: string;
      reason: string;
      /** Days of history there are, and the minimum. */
      history_days: number;
      needed_days: number;
      /** When it will be ready if the data keeps coming; null when nothing is coming. */
      ready_on: string | null;
      can: string[];
      cannot: string[];
      roles: RoleCover[];
      limits: string[];
    }
  | {
      status: "ok";
      source: "bookings" | "takings";
      headline: string;
      basis: {
        /** Where demand was read, in words. */
        demand: string;
        from: string;
        to: string;
        history_days: number;
        days_read: number;
        currency: string | null;
      };
      hours: number[];
      weekdays: WeekdayCover[];
      roles: RoleCover[];
      capacity: Capacity | null;
      findings: CoverFinding[];
      season: { words: string; extra: string[] };
      assumed: string[];
      notes: string[];
      limits: string[];
    };

const DAY_MS = 86_400_000;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

function weekdayOf(day: string): Weekday {
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return TEAM_WEEKDAYS[(wd + 6) % 7] as Weekday;
}

/** Linear-interpolated quantile (the spreadsheet's PERCENTILE). */
function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = s[lo] as number;
  const b = s[hi] as number;
  return a + (b - a) * (pos - lo);
}

/** The mean of the middle half: the lowest and highest quarter of the values left out. */
function middleMean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const cut = Math.floor(s.length / 4);
  const mid = s.slice(cut, s.length - cut);
  return mid.reduce((t, v) => t + v, 0) / mid.length;
}

function spreadOf(values: readonly number[]): Spread {
  const mean = values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
  return {
    mean,
    typical: middleMean(values),
    low: quantile(values, 0.25),
    high: quantile(values, 0.75),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 Dec", in UTC so server and browser agree; in another language, its own ("1. Dez."). */
export function dayText(day: string, locale: AppLocale = "en"): string {
  if (locale !== "en") return dayMonth(day, locale);
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const pct = (x: number) => Math.round(x * 100);
const one = (x: number) => Math.round(x * 10) / 10;

const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(locale: AppLocale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(intlTag(locale), options);
    numberFormats.set(key, f);
  }
  return f;
}

/** A figure as the code computed it: English's own String(), Intl's elsewhere ("6,3"). */
function figText(n: number, locale: AppLocale, decimals = 2): string {
  return locale === "en"
    ? String(n)
    : numberFormat(locale, { maximumFractionDigits: decimals }).format(n);
}

/** One decimal: "6.3", "1"; "6,3" in German. */
const oneText = (x: number, locale: AppLocale) => figText(one(x), locale, 1);

/** A share as a whole percentage: "96%"; "96 %" in German. */
function pctText(x: number, locale: AppLocale): string {
  return locale === "en"
    ? `${pct(x)}%`
    : numberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(pct(x) / 100);
}

/** "91 to 100%"; "91 bis 100 %" in German. */
function pctRangeText(low: number, high: number, locale: AppLocale): string {
  return locale === "en"
    ? `${pct(low)} to ${pct(high)}%`
    : rangeOf(figText(pct(low), locale, 0), pctText(high, locale), locale);
}

/** The first letter lowered, for a phrase that moves into the middle of a sentence. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** "(…% on every day …)" or "(…–…% on …)": the middle half's range, over `count` ("the 8 Saturdays"). */
function rangeIn(share: { low: number; high: number }, count: string, L: TeamLang): string {
  return pct(share.low) === pct(share.high)
    ? L.tr("range.same", { pct: pctText(share.low, L.locale), count })
    : L.tr("range.spread", { range: pctRangeText(share.low, share.high, L.locale), count });
}

/**
 * "(91–100% on the middle half of the 8 Saturdays read)", or, when the
 * middle half all ran the same, "(113% on every day of the middle half of
 * the 8 Thursdays read)" rather than "113–113%". English, with the
 * weekday's plural as given; coverage itself words it per weekday.
 */
export function rangeWords(
  share: { low: number; high: number },
  days: number,
  plural: string,
): string {
  return rangeIn(share, `${days} ${plural}`, englishTeam());
}

/** The range over one weekday's days read, in the reader's language. */
function weekdayRange(
  share: { low: number; high: number },
  days: number,
  weekday: Weekday,
  L: TeamLang,
): string {
  return rangeIn(share, L.tr(`rangeCount.${weekday}`, { days }), L);
}

/** "Saturdays", "Fridays and Saturdays", "Tuesdays to Saturdays" (three or more in a row). */
export function daysText(days: readonly Weekday[], L: TeamLang = englishTeam()): string {
  const idx = days.map((d) => TEAM_WEEKDAYS.indexOf(d)).sort((a, b) => a - b);
  const names = idx.map((i) => L.tr(`days.${TEAM_WEEKDAYS[i] as Weekday}`));
  const consecutive = idx.every((v, i) => i === 0 || v === (idx[i - 1] ?? -2) + 1);
  if (names.length >= 3 && consecutive) {
    return L.tr("daysSpan", { from: names[0] ?? "", to: names.at(-1) ?? "" });
  }
  if (names.length <= 1) return names.join("");
  if (L.locale !== "en") {
    return new Intl.ListFormat(intlTag(L.locale), { type: "conjunction" }).format(names);
  }
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "10:00", on the 24-hour clock (25 is 01:00 after midnight). */
export function clock(hour: number): string {
  return `${String(hour % 24).padStart(2, "0")}:00`;
}

/** "Saturdays 10:00–14:00". */
export function runText(
  weekday: Weekday,
  from: number,
  to: number,
  L: TeamLang = englishTeam(),
): string {
  return L.tr(`run.${weekday}`, { from: clock(from), to: clock(to) });
}

/** "1 appointment", "2.7 appointments". */
function appts(x: number, L: TeamLang): string {
  const v = one(x);
  return L.tr("appts", { n: v, v: figText(v, L.locale, 1) });
}

/** "about 1.5 people are on in an average open hour, by the role hours you gave". */
function onAverage(on: number, L: TeamLang): string {
  const v = one(on);
  return L.tr("reason.onAverage", { n: v, v: figText(v, L.locale, 1) });
}

/**
 * The title in running text: "Stylist" → "stylist"; "HR lead" stays.
 * English only: the other languages quote the owner's title as given
 * («Stylist», “Stylist”), and German keeps its capital nouns.
 */
function inText(title: string, locale: AppLocale): string {
  if (locale !== "en") return title;
  const second = title.charAt(1);
  return second !== "" && second === second.toLowerCase() && second !== second.toUpperCase()
    ? title.charAt(0).toLowerCase() + title.slice(1)
    : title;
}

/**
 * The roles from 9.2, grouped by title (case and spacing ignored), the
 * biggest first. Only the title and the hours are read from a row.
 */
export function rolesOf(
  roles: readonly RoleInput[],
  openHoursPerWeek: number | null,
  L: TeamLang = englishTeam(),
): RoleCover[] {
  const groups = new Map<string, { role: string; rows: number; hours: number; stated: number }>();
  for (const r of roles) {
    const title =
      typeof r.role_title === "string" && r.role_title.trim() !== ""
        ? r.role_title.trim().replace(/\s+/g, " ")
        : L.tr("untitledRole");
    const key = title.toLowerCase();
    const g = groups.get(key) ?? { role: title, rows: 0, hours: 0, stated: 0 };
    g.rows += 1;
    const h = r.hours_per_week;
    if (typeof h === "number" && Number.isFinite(h) && h > 0) {
      g.hours += h;
      g.stated += 1;
    }
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      role: g.role,
      rows: g.rows,
      hours_per_week: g.stated > 0 ? g.hours : null,
      unstated_rows: g.rows - g.stated,
      on_per_open_hour:
        g.stated > 0 && openHoursPerWeek !== null && openHoursPerWeek > 0
          ? g.hours / openHoursPerWeek
          : null,
    }))
    .sort(
      (a, b) =>
        (b.hours_per_week ?? -1) - (a.hours_per_week ?? -1) ||
        (a.role < b.role ? -1 : a.role > b.role ? 1 : 0),
    );
}

const limitsIn = (L: TeamLang) => [L.tr("limits.rolesOnly"), L.tr("limits.yoursToWeigh")];

/** Contiguous runs of the same band on one weekday, in hour order. */
function runsOf(w: WeekdayCover, band: "short" | "quiet"): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const c of w.cells) {
    if (c.open && c.band === band) {
      const last = out.at(-1);
      if (last && last.to === c.hour) last.to = c.hour + 1;
      else out.push({ from: c.hour, to: c.hour + 1 });
    }
  }
  return out;
}

function refuse(args: {
  headline: string;
  reason: string;
  history: number;
  readyOn: string | null;
  can: string[];
  cannot: string[];
  roles: readonly RoleInput[];
  L: TeamLang;
}): CoverageResult {
  return {
    status: "refused",
    headline: args.headline,
    reason: args.reason,
    history_days: args.history,
    needed_days: TEAM.min_history_days,
    ready_on: args.readyOn,
    can: args.can,
    cannot: args.cannot,
    roles: rolesOf(args.roles, null, args.L),
    limits: limitsIn(args.L),
  };
}

const cannotIn = (L: TeamLang) => [
  L.tr("cannot.overCapacity"),
  L.tr("cannot.quiet"),
  L.tr("cannot.borrow"),
];

function hourOf(start: string | null): number | null {
  if (start === null) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(start);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}

/** The busy stretch ahead, in words, and the hours it would push past capacity. */
function seasonPart(
  season: SeasonInput,
  weekdays: readonly WeekdayCover[],
  canProject: boolean,
  L: TeamLang,
): { words: string; extra: string[] } {
  const { tr, locale } = L;
  if (season.status === "unread") {
    return { words: tr("season.unread", { reason: season.reason }), extra: [] };
  }
  if (season.status === "none_ahead") {
    return { words: tr("season.noneAhead"), extra: [] };
  }
  const range =
    season.high === null
      ? tr("season.atLeast", { low: oneText(season.low, locale) })
      : tr("season.between", {
          low: oneText(season.low, locale),
          high: oneText(season.high, locale),
        });
  const index = oneText(season.index, locale);
  const head = season.in_progress
    ? tr("season.headUnderWay", { index, range })
    : tr("season.headStarts", { day: dayText(season.starts_on, locale), index, range });
  if (!canProject) return { words: head, extra: [] };
  // Only what even the low ends imply: hours not already short whose
  // lower-quarter share × the season's low multiple reaches the short line.
  const extra: string[] = [];
  for (const w of weekdays) {
    if (w.verdict !== "read") continue;
    let run: { from: number; to: number } | null = null;
    const flush = () => {
      if (run) extra.push(runText(w.weekday, run.from, run.to, L));
      run = null;
    };
    for (const c of w.cells) {
      const lifts =
        c.open &&
        c.band !== "short" &&
        c.share !== null &&
        c.share.low * season.low >= TEAM.short_share;
      if (lifts) {
        if (run && run.to === c.hour) run.to = c.hour + 1;
        else {
          flush();
          run = { from: c.hour, to: c.hour + 1 };
        }
      } else flush();
    }
    flush();
  }
  // English keeps each run's capital after the colon, as it always has; the
  // other languages carry the runs on mid-sentence ("samstags 13:00–14:00").
  const hours = extra.map((e) => (locale === "en" ? e : lowerFirst(e))).join(tr("listSep"));
  return {
    words:
      extra.length === 0 ? tr("season.noFurther", { head }) : tr("season.further", { head, hours }),
    extra,
  };
}

/** P5-19: coverage by hour. Pure; the same input always gives the same bytes. */
export function teamCoverage(input: CoverageInput, L: TeamLang = englishTeam()): CoverageResult {
  const { asOf, roles } = input;
  const from = addDays(asOf, -(TEAM.window_days - 1));
  const bookings =
    input.bookings !== null && input.bookings.slots.length > 0 ? input.bookings : null;
  const capacity =
    input.capacityPerWeek !== null &&
    Number.isFinite(input.capacityPerWeek) &&
    input.capacityPerWeek > 0
      ? input.capacityPerWeek
      : null;

  if (bookings !== null && (capacity !== null || input.takings === null)) {
    return fromBookings(input, bookings, capacity, from, L);
  }
  if (input.takings !== null) return fromTakings(input, input.takings, from, L);
  return refuse({
    headline: L.tr("refused.noDemand.headline"),
    reason: L.tr("refused.noDemand.reason"),
    history: 0,
    readyOn: null,
    can: [L.tr("refused.noDemand.can")],
    cannot: cannotIn(L),
    roles,
    L,
  });
}

/** The interview question the stated weekly capacity answers. */
const CAPACITY_QUESTION = "1.4.2.3b";

function fromBookings(
  input: CoverageInput,
  bookings: NonNullable<CoverageInput["bookings"]>,
  capacity: number | null,
  windowFrom: string,
  L: TeamLang,
): CoverageResult {
  const { tr, locale } = L;
  const { asOf, roles } = input;
  const firstDay =
    bookings.first_day ??
    bookings.slots.reduce((m, s) => (s.day < m ? s.day : m), bookings.slots[0]?.day ?? asOf);
  const history = Math.max(0, daysBetween(firstDay, asOf) + 1);
  if (history < TEAM.min_history_days) {
    return refuse({
      headline: tr("refused.fewBookings.headline", {
        history,
        needed: TEAM.min_history_days,
      }),
      reason: tr("refused.fewBookings.reason", {
        from: dayText(firstDay, locale),
        to: dayText(asOf, locale),
      }),
      history,
      readyOn: addDays(firstDay, TEAM.min_history_days - 1),
      can: [tr("refused.fewBookings.can", { history })],
      cannot: cannotIn(L),
      roles,
      L,
    });
  }
  if (capacity === null) {
    return refuse({
      headline: tr("refused.noCapacity.headline"),
      reason: tr("refused.noCapacity.reason", { question: CAPACITY_QUESTION }),
      history,
      readyOn: null,
      can: [tr("refused.noCapacity.can")],
      cannot: cannotIn(L).slice(0, 2),
      roles,
      L,
    });
  }

  const start = firstDay > windowFrom ? firstDay : windowFrom;
  const inWindow = bookings.slots.filter((s) => s.day >= start && s.day <= asOf);
  const placed = inWindow.filter((s) => hourOf(s.start_time) !== null);
  const unplaced = inWindow.length - placed.length;
  if (placed.length === 0) {
    return refuse({
      headline: tr("refused.noTimes.headline"),
      reason: tr("refused.noTimes.reason", {
        n: inWindow.length,
        count: figText(inWindow.length, locale),
        from: dayText(start, locale),
        to: dayText(asOf, locale),
      }),
      history,
      readyOn: null,
      can: [tr("refused.byDay")],
      cannot: cannotIn(L),
      roles,
      L,
    });
  }

  // Per day: any appointment at all (the day was trading), and held per hour.
  const anyOn = new Set<string>();
  const held = new Map<string, Map<number, number>>();
  const startsIn = new Map<string, Set<number>>();
  for (const s of placed) {
    const h = hourOf(s.start_time) as number;
    anyOn.add(s.day);
    const st = startsIn.get(s.day) ?? new Set<number>();
    st.add(h);
    startsIn.set(s.day, st);
    if (!HELD.has(s.status)) continue;
    const m = held.get(s.day) ?? new Map<number, number>();
    m.set(h, (m.get(h) ?? 0) + 1);
    held.set(s.day, m);
  }

  const datesOf = (w: Weekday): string[] => {
    const out: string[] = [];
    for (let d = start; d <= asOf; d = addDays(d, 1)) if (weekdayOf(d) === w) out.push(d);
    return out;
  };

  // Each weekday's days and open hours.
  const plan = TEAM_WEEKDAYS.map((weekday) => {
    const dates = datesOf(weekday);
    const stated = input.openHours?.[weekday];
    if (stated !== undefined) {
      return {
        weekday,
        days: stated.length === 0 ? [] : dates,
        open: new Set(stated),
        from: "stated" as const,
      };
    }
    const days = dates.filter((d) => anyOn.has(d));
    if (days.length === 0 || days.length < dates.length * TEAM.footprint_share) {
      return { weekday, days: [], open: new Set<number>(), from: null };
    }
    const open = new Set<number>();
    for (let h = 0; h < 24; h++) {
      const n = days.filter((d) => startsIn.get(d)?.has(h)).length;
      if (n >= days.length * TEAM.footprint_share) open.add(h);
    }
    return { weekday, days, open, from: "bookings" as const };
  });

  const openHoursPerWeek = plan.reduce((s, p) => s + (p.days.length > 0 ? p.open.size : 0), 0);
  if (openHoursPerWeek === 0) {
    return refuse({
      headline: tr("refused.noHours.headline"),
      reason: tr("refused.noHours.reason"),
      history,
      readyOn: null,
      can: [tr("refused.byDay")],
      cannot: cannotIn(L),
      roles,
      L,
    });
  }
  const perOpenHour = capacity / openHoursPerWeek;
  const roleCover = rolesOf(roles, openHoursPerWeek, L);
  const roleHours = roleCover.reduce((s, r) => s + (r.hours_per_week ?? 0), 0);
  const peopleOn = roleHours > 0 ? roleHours / openHoursPerWeek : null;
  const perPersonOn = peopleOn !== null ? perOpenHour / peopleOn : null;

  const hourSet = new Set<number>();
  for (const p of plan) if (p.days.length > 0) for (const h of p.open) hourSet.add(h);
  const lo = Math.min(...hourSet);
  const hi = Math.max(...hourSet);
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

  const weekdays: WeekdayCover[] = plan.map((p) => {
    if (p.days.length === 0) {
      return {
        weekday: p.weekday,
        days_read: 0,
        verdict: "closed",
        hours_from: p.from,
        cells: hours.map((hour) => ({ hour, open: false, demand: null, share: null, band: null })),
      };
    }
    const early = p.days.length < TEAM.min_days_per_weekday;
    return {
      weekday: p.weekday,
      days_read: p.days.length,
      verdict: early ? "too_early" : "read",
      hours_from: p.from,
      cells: hours.map((hour): HourCell => {
        if (!p.open.has(hour)) return { hour, open: false, demand: null, share: null, band: null };
        const counts = p.days.map((d) => held.get(d)?.get(hour) ?? 0);
        const demand = spreadOf(counts);
        const share = spreadOf(counts.map((c) => c / perOpenHour));
        const band: Band | null = early
          ? null
          : share.low >= TEAM.short_share
            ? "short"
            : share.high <= TEAM.quiet_share
              ? "quiet"
              : "ok";
        return { hour, open: true, demand, share, band };
      }),
    };
  });

  const lead = roleCover.find((r) => r.hours_per_week !== null) ?? null;
  const stated = figText(capacity, locale);
  const findings: CoverFinding[] = [];
  for (const w of weekdays) {
    if (w.verdict !== "read") continue;
    const days = plan.find((p) => p.weekday === w.weekday)?.days ?? [];
    for (const band of ["short", "quiet"] as const) {
      for (const run of runsOf(w, band)) {
        const len = run.to - run.from;
        const perDay = days.map((d) => {
          let n = 0;
          for (let h = run.from; h < run.to; h++) n += held.get(d)?.get(h) ?? 0;
          return n / (perOpenHour * len);
        });
        const share = spreadOf(perDay);
        const where = runText(w.weekday, run.from, run.to, L);
        const range_words = weekdayRange(share, days.length, w.weekday, L);
        const perHour = tr("reason.perHour", {
          capacity: stated,
          appts: appts(perOpenHour, L),
        });
        const reason =
          band === "short"
            ? lead !== null && perPersonOn !== null
              ? tr("reason.perRole", {
                  role: inText(lead.role, locale),
                  appts: appts(perPersonOn, L),
                  capacity: stated,
                })
              : perHour
            : peopleOn !== null
              ? onAverage(peopleOn, L)
              : perHour;
        const note =
          band === "short"
            ? lead !== null
              ? tr("note.shortRole", { run: where, role: inText(lead.role, locale) })
              : tr("note.shortHands", { run: where })
            : tr("note.quiet", { run: where });
        findings.push({
          weekday: w.weekday,
          from_hour: run.from,
          to_hour: run.to,
          band,
          share,
          days: days.length,
          words: tr("finding.booked", { run: where, pct: pctText(share.typical, locale) }),
          range_words,
          reason,
          line: tr("finding.line", { range: range_words, reason }),
          note,
        });
      }
    }
  }
  // Busiest short first, then the quietest; ties in week order.
  const order = (f: CoverFinding) => TEAM_WEEKDAYS.indexOf(f.weekday) * 100 + f.from_hour;
  findings.sort((a, b) =>
    a.band !== b.band
      ? a.band === "short"
        ? -1
        : 1
      : a.band === "short"
        ? b.share.typical - a.share.typical || order(a) - order(b)
        : a.share.typical - b.share.typical || order(a) - order(b),
  );

  const footprint = plan.filter((p) => p.from === "bookings" && p.days.length > 0);
  const assumed = [
    tr("assumed.capacity", {
      n: capacity,
      capacity: stated,
      hours: openHoursPerWeek,
      appts: appts(perOpenHour, L),
    }),
    tr("assumed.startHour"),
    ...(footprint.length > 0
      ? [
          tr("assumed.footprintBookings", {
            days: daysText(
              footprint.map((p) => p.weekday),
              L,
            ),
            pct: pctText(TEAM.footprint_share, locale),
          }),
        ]
      : []),
    ...(peopleOn !== null ? [tr("assumed.evenSpread"), tr("assumed.allServe")] : []),
  ];

  const notes = findings.map((f) => f.note);
  if (roleCover.length === 0) notes.push(tr("notes.noRolesBookings"));
  if (unplaced > 0) {
    notes.push(tr("notes.unplaced", { n: unplaced, count: figText(unplaced, locale) }));
  }

  const top = findings[0];
  const headline =
    top === undefined
      ? tr("headline.none")
      : top.band === "short"
        ? tr("headline.top", { words: top.words, reason: top.reason })
        : tr("headline.quietTop", { words: lowerFirst(top.words) });
  const daysRead = plan.reduce((s, p) => s + p.days.length, 0);

  return {
    status: "ok",
    source: "bookings",
    headline,
    basis: {
      demand: bookings.source,
      from: start,
      to: asOf,
      history_days: history,
      days_read: daysRead,
      currency: null,
    },
    hours,
    weekdays,
    roles: roleCover,
    capacity: {
      per_week: capacity,
      open_hours_per_week: openHoursPerWeek,
      per_open_hour: perOpenHour,
      people_on: peopleOn,
      per_person_on: perPersonOn,
    },
    findings,
    season: seasonPart(input.season, weekdays, true, L),
    assumed,
    notes,
    limits: limitsIn(L),
  };
}

function fromTakings(
  input: CoverageInput,
  takings: TakingsInput,
  windowFrom: string,
  L: TeamLang,
): CoverageResult {
  const { tr, locale } = L;
  const { asOf, roles } = input;
  const all = [...takings.measuredDays.values()].flat().filter((d) => d <= asOf);
  const first = all.reduce<string | null>((m, d) => (m === null || d < m ? d : m), null);
  const history = first === null ? 0 : daysBetween(first, asOf) + 1;
  if (first === null || history < TEAM.min_history_days) {
    return refuse({
      headline: tr("refused.fewSales.headline", { history, needed: TEAM.min_history_days }),
      reason:
        first === null
          ? tr("refused.fewSales.reasonNone")
          : tr("refused.fewSales.reason", {
              from: dayText(first, locale),
              to: dayText(asOf, locale),
            }),
      history,
      readyOn: first === null ? null : addDays(first, TEAM.min_history_days - 1),
      can: [tr("refused.salesOnHours")],
      cannot: cannotIn(L),
      roles,
      L,
    });
  }

  const plan = TEAM_WEEKDAYS.map((weekday) => {
    const days = (takings.measuredDays.get(weekday) ?? []).filter(
      (d) => d >= windowFrom && d <= asOf,
    );
    const stated = input.openHours?.[weekday];
    if (stated !== undefined) {
      return {
        weekday,
        days: stated.length === 0 ? [] : days,
        open: new Set(stated),
        from: "stated" as const,
      };
    }
    const sold = days.filter((d) => [...(takings.byDay.get(d)?.values() ?? [])].some((v) => v > 0));
    if (sold.length === 0 || sold.length < days.length * TEAM.footprint_share) {
      return { weekday, days: [], open: new Set<number>(), from: null };
    }
    const open = new Set<number>();
    for (let h = 0; h < 30; h++) {
      const n = sold.filter((d) => (takings.byDay.get(d)?.get(h) ?? 0) > 0).length;
      if (n >= sold.length * TEAM.footprint_share) open.add(h);
    }
    return { weekday, days: sold, open, from: "takings" as const };
  });

  const openHoursPerWeek = plan.reduce((s, p) => s + (p.days.length > 0 ? p.open.size : 0), 0);
  const hourSet = new Set<number>();
  for (const p of plan) if (p.days.length > 0) for (const h of p.open) hourSet.add(h);
  if (hourSet.size === 0) {
    return refuse({
      headline: tr("refused.noSalesHours.headline"),
      reason: tr("refused.noSalesHours.reason"),
      history,
      readyOn: null,
      can: [tr("refused.salesOnHours")],
      cannot: cannotIn(L),
      roles,
      L,
    });
  }
  const lo = Math.min(...hourSet);
  const hi = Math.max(...hourSet);
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const roleCover = rolesOf(roles, openHoursPerWeek, L);
  const roleHours = roleCover.reduce((s, r) => s + (r.hours_per_week ?? 0), 0);
  const peopleOn = roleHours > 0 ? roleHours / openHoursPerWeek : null;

  const weekdays: WeekdayCover[] = plan.map((p) => {
    if (p.days.length === 0) {
      return {
        weekday: p.weekday,
        days_read: 0,
        verdict: "closed",
        hours_from: p.from,
        cells: hours.map((hour) => ({ hour, open: false, demand: null, share: null, band: null })),
      };
    }
    const early = p.days.length < TEAM.min_days_per_weekday;
    const typical = new Map<number, number>();
    for (const h of p.open) {
      typical.set(
        h,
        quantile(
          p.days.map((d) => takings.byDay.get(d)?.get(h) ?? 0),
          0.5,
        ),
      );
    }
    const peak = Math.max(0, ...typical.values());
    return {
      weekday: p.weekday,
      days_read: p.days.length,
      verdict: early ? "too_early" : "read",
      hours_from: p.from,
      cells: hours.map((hour): HourCell => {
        if (!p.open.has(hour)) return { hour, open: false, demand: null, share: null, band: null };
        const values = p.days.map((d) => takings.byDay.get(d)?.get(hour) ?? 0);
        const demand = spreadOf(values);
        const share = peak > 0 ? spreadOf(values.map((v) => v / peak)) : null;
        const band: Band | null =
          early || share === null ? null : share.high <= TEAM.quiet_takings_share ? "quiet" : "ok";
        return { hour, open: true, demand, share, band };
      }),
    };
  });

  const findings: CoverFinding[] = [];
  for (const w of weekdays) {
    if (w.verdict !== "read") continue;
    const days = plan.find((p) => p.weekday === w.weekday)?.days ?? [];
    const peak = Math.max(0, ...w.cells.map((c) => c.demand?.typical ?? 0));
    if (peak <= 0) continue;
    for (const run of runsOf(w, "quiet")) {
      const len = run.to - run.from;
      const perDay = days.map((d) => {
        let n = 0;
        for (let h = run.from; h < run.to; h++) n += takings.byDay.get(d)?.get(h) ?? 0;
        return n / (peak * len);
      });
      const share = spreadOf(perDay);
      const where = runText(w.weekday, run.from, run.to, L);
      const range_words = weekdayRange(share, days.length, w.weekday, L);
      const reason = peopleOn !== null ? onAverage(peopleOn, L) : tr("reason.open");
      findings.push({
        weekday: w.weekday,
        from_hour: run.from,
        to_hour: run.to,
        band: "quiet",
        share,
        days: days.length,
        words: tr("finding.took", { run: where, pct: pctText(share.typical, locale) }),
        range_words,
        reason,
        line: tr("finding.line", { range: range_words, reason }),
        note: tr("note.quietTakings", { run: where }),
      });
    }
  }
  const order = (f: CoverFinding) => TEAM_WEEKDAYS.indexOf(f.weekday) * 100 + f.from_hour;
  findings.sort((a, b) => a.share.typical - b.share.typical || order(a) - order(b));

  const footprint = plan.filter((p) => p.from === "takings" && p.days.length > 0);
  const assumed = [
    tr("assumed.takings"),
    ...(footprint.length > 0
      ? [
          tr("assumed.footprintTakings", {
            days: daysText(
              footprint.map((p) => p.weekday),
              L,
            ),
          }),
        ]
      : []),
    ...(peopleOn !== null ? [tr("assumed.evenSpread")] : []),
  ];
  const notes = findings.map((f) => f.note);
  notes.push(tr("notes.takingsNoCapacity"));
  if (roleCover.length === 0) notes.push(tr("notes.noRolesTakings"));
  const top = findings[0];
  return {
    status: "ok",
    source: "takings",
    headline:
      top === undefined
        ? tr("headline.noneTakings")
        : tr("headline.top", { words: top.words, reason: top.reason }),
    basis: {
      demand: takings.source,
      from: windowFrom > first ? windowFrom : first,
      to: asOf,
      history_days: history,
      days_read: plan.reduce((s, p) => s + p.days.length, 0),
      currency: takings.currency,
    },
    hours,
    weekdays,
    roles: roleCover,
    capacity: null,
    findings,
    season: seasonPart(input.season, weekdays, false, L),
    assumed,
    notes,
    limits: limitsIn(L),
  };
}
