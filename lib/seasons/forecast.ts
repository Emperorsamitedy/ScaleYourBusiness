// The busy-season forecast — idea 46. Pure: no database, no model, no clock.
//
// From one measured daily series of the business's own (revenue a day from
// its shop or payments, or booking revenue, or a count where no money is
// measured), it says which weeks and months of the year ran above and below
// the business's normal week, and what the next eight weeks looked like the
// same time last year. Arithmetic only (CLAUDE.md: never an LLM for this):
//
//   week        Monday to Sunday, on the series' own dates. A week counts
//               only when all seven days were measured (connectors write a
//               zero day as a zero, so a missing day is a gap, not a zero).
//   normal      the median of the complete weeks of the last 52 — robust to
//               the very peaks it is measuring — with the middle half of
//               those weeks (25th to 75th percentile) as its range.
//   index       a week's value ÷ the normal week. Its range divides by the
//               two ends of the middle half: value ÷ p75 to value ÷ p25. A
//               second or third year widens the range with that year's own
//               week against that year's own normal.
//   season      two weeks or more in a row at ≥ 1.25× (busy) or ≤ 0.8×
//               (quiet). One high week can be a one-off; it isn't a season.
//   ahead       this week and the seven after it, each set beside the week
//               52 weeks (364 days, so weekdays line up) before it.
//
// It refuses honestly. Year over year needs about a year: at least 50 of
// the last 52 weeks complete. With less it says how much there is, what it
// can say (the weeks it has, against each other) and cannot (which weeks of
// the year are busy), and from when it will. Nothing here is filled from
// industry averages: a season is only ever the owner's own history.

import { shortDate } from "../charts/model";

export const SEASONS = {
  /** Weeks in the year the normal is read over. */
  year_weeks: 52,
  /** Complete weeks of the last 52 needed before any season is named. */
  min_weeks: 50,
  /** How far ahead the forecast looks. */
  horizon_weeks: 8,
  /** A week at or above this multiple of the normal week is busy… */
  busy_index: 1.25,
  /** …and at or below this one, quiet. */
  quiet_index: 0.8,
  /** A season is this many flagged weeks in a row, or more. */
  min_run_weeks: 2,
  /** A calendar month is indexed only with this many measured days. */
  min_month_days: 21,
  /** At most this many years back widen a range. */
  max_years: 3,
  /** Weeks shown when there is too little history to name a season. */
  recent_weeks: 26,
} as const;

const DAY_MS = 86_400_000;

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** The Monday on or before `day`. */
export function mondayOf(day: string): string {
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((wd + 6) % 7));
}

/** Linear-interpolated quantile (the spreadsheet's PERCENTILE). */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = s[lo] as number;
  const b = s[hi] as number;
  return a + (b - a) * (pos - lo);
}

export interface SeriesInfo {
  /** Owner-facing noun: "revenue", "booking revenue", "orders". */
  noun: string;
  /** Where it was measured: "Shopify", "your bookings export". */
  source: string;
  /** ISO 4217 when the series is money (integer minor units), else null (a count). */
  currency: string | null;
}

export interface Normal {
  /** The median complete week. */
  median: number;
  p25: number;
  p75: number;
  /** Complete weeks it was read over. */
  weeks: number;
  /** First and last day of the weeks read. */
  from: string;
  to: string;
}

export interface Ratio {
  index: number;
  low: number;
  /** Null when a quarter of the normal weeks were zero: no upper bound can be stated. */
  high: number | null;
}

export interface SeasonWeek extends Ratio {
  start: string;
  value: number;
  flag: "busy" | "quiet" | null;
}

export interface SeasonRun extends Ratio {
  kind: "busy" | "quiet";
  /** Monday of the first week, Sunday of the last. */
  start: string;
  end: string;
  weeks: number;
  total: number;
}

export interface SeasonMonth extends Ratio {
  /** "2025-11". */
  month: string;
  label: string;
  days: number;
  /** The month's measured value scaled to one week (÷ days × 7). */
  per_week: number;
}

export interface AheadWeek {
  /** This year's Monday, and the Monday 52 weeks before it. */
  start: string;
  last_year_start: string;
  /** Null when last year's week wasn't completely measured. */
  last_year: (Ratio & { value: number }) | null;
  flag: "busy" | "quiet" | null;
}

export interface Upcoming {
  run: SeasonRun;
  /** 0 when the same weeks are already under way this year. */
  starts_in_weeks: number;
  /** This year's dates for the same weeks (last year's + 364 days). */
  starts_on: string;
  ends_on: string;
  in_progress: boolean;
  sentence: string;
}

export type SeasonResult =
  | { status: "no_data" }
  | {
      status: "too_little";
      series: SeriesInfo;
      first_day: string;
      last_day: string;
      covered_days: number;
      complete_weeks: number;
      needed_weeks: number;
      /** When the last 52 weeks would hold enough, if syncs keep running. */
      ready_on: string;
      /** The weeks there are, against their own median — not a season. */
      recent: { start: string; value: number }[];
      recent_median: number | null;
      headline: string;
      can: string[];
      cannot: string[];
    }
  | {
      status: "ready";
      series: SeriesInfo;
      today: string;
      first_day: string;
      last_day: string;
      covered_days: number;
      /** Years of complete history that went into the ranges (1–3). */
      years: number;
      normal: Normal;
      weeks: SeasonWeek[];
      months: SeasonMonth[];
      runs: SeasonRun[];
      ahead: AheadWeek[];
      upcoming: Upcoming[];
      headline: string;
      notes: string[];
    };

/** Complete Monday weeks: start → the week's total. */
export function completeWeeks(values: ReadonlyMap<string, number>, lastDay: string) {
  const weeks = new Map<string, number>();
  const starts = new Set<string>();
  for (const day of values.keys()) if (day <= lastDay) starts.add(mondayOf(day));
  for (const start of starts) {
    let total = 0;
    let whole = true;
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      const v = d <= lastDay ? values.get(d) : undefined;
      if (v === undefined) {
        whole = false;
        break;
      }
      total += v;
    }
    if (whole) weeks.set(start, total);
  }
  return weeks;
}

/** The normal week over the complete weeks starting in [from, to]. */
export function normalOver(
  weeks: ReadonlyMap<string, number>,
  from: string,
  to: string,
): Normal | null {
  const vals: number[] = [];
  const starts: string[] = [];
  for (const [start, v] of weeks) {
    if (start < from || start > to) continue;
    vals.push(v);
    starts.push(start);
  }
  if (vals.length === 0) return null;
  starts.sort();
  return {
    median: quantile(vals, 0.5),
    p25: quantile(vals, 0.25),
    p75: quantile(vals, 0.75),
    weeks: vals.length,
    from: starts[0]!,
    to: addDays(starts.at(-1)!, 6),
  };
}

/** value (over `weeks` weeks) against a normal week, with its range. */
export function ratioOf(value: number, weeks: number, normal: Normal): Ratio {
  const per = value / weeks;
  return {
    index: per / normal.median,
    low: normal.p75 > 0 ? per / normal.p75 : per / normal.median,
    high: normal.p25 > 0 ? per / normal.p25 : null,
  };
}

function widen(base: Ratio, other: Ratio | null): Ratio {
  if (other === null) return base;
  return {
    index: base.index,
    low: Math.min(base.low, other.low),
    high: base.high === null || other.high === null ? null : Math.max(base.high, other.high),
  };
}

function flagOf(index: number): "busy" | "quiet" | null {
  if (index >= SEASONS.busy_index) return "busy";
  if (index <= SEASONS.quiet_index) return "quiet";
  return null;
}

/** "2.1×", one decimal. */
export function times(x: number): string {
  return `${(Math.round(x * 10) / 10).toFixed(1)}×`;
}

/** "2.1× (1.9–2.3×)" — the central figure and its range. */
export function ratioText(r: Ratio): string {
  const lo = (Math.round(r.low * 10) / 10).toFixed(1);
  const hi = r.high === null ? "?" : (Math.round(r.high * 10) / 10).toFixed(1);
  return lo === hi ? times(r.index) : `${times(r.index)} (${lo}–${hi}×)`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Find the runs of flagged weeks, in order. An unmeasured week breaks a run. */
export function findRuns(weeks: readonly SeasonWeek[], normal: Normal): SeasonRun[] {
  const runs: SeasonRun[] = [];
  let cur: SeasonWeek[] = [];
  const close = () => {
    const first = cur[0];
    if (first && first.flag && cur.length >= SEASONS.min_run_weeks) {
      const total = cur.reduce((s, w) => s + w.value, 0);
      runs.push({
        kind: first.flag,
        start: first.start,
        end: addDays(cur.at(-1)!.start, 6),
        weeks: cur.length,
        total,
        ...ratioOf(total, cur.length, normal),
      });
    }
    cur = [];
  };
  for (const w of weeks) {
    const prev = cur.at(-1);
    const continues =
      prev !== undefined &&
      w.flag !== null &&
      w.flag === prev.flag &&
      addDays(prev.start, 7) === w.start;
    if (!continues) close();
    if (w.flag !== null) cur.push(w);
  }
  close();
  return runs;
}

function runPhrase(run: SeasonRun): string {
  const span = `${shortDate(run.start)} to ${shortDate(run.end)}`;
  return `The ${plural(run.weeks, "week")} from ${span}`;
}

/**
 * The forecast. `values` is ONE series of ONE source (money in minor units
 * of ONE currency, or a count); `today` is the owner's date — the series
 * is read up to the day before it.
 */
export function seasonForecast(
  values: ReadonlyMap<string, number>,
  series: SeriesInfo,
  today: string,
): SeasonResult {
  const yesterday = addDays(today, -1);
  const days = [...values.keys()].filter((d) => d <= yesterday).sort();
  if (days.length === 0) return { status: "no_data" };
  const first = days[0]!;
  const last = days.at(-1)!;
  const weeks = completeWeeks(values, yesterday);
  const thisMonday = mondayOf(today);
  const yearFrom = addDays(thisMonday, -7 * SEASONS.year_weeks);
  const yearTo = addDays(thisMonday, -7);
  const normal = normalOver(weeks, yearFrom, yearTo);

  if (normal === null || normal.weeks < SEASONS.min_weeks || normal.median <= 0) {
    const complete = normal?.weeks ?? 0;
    const sorted = [...weeks.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const recent = sorted.slice(-SEASONS.recent_weeks).map(([start, value]) => ({ start, value }));
    const missing = SEASONS.min_weeks - complete;
    const readyOn = addDays(thisMonday, 7 * Math.max(1, missing));
    const months = Math.max(0, Math.floor(days.length / 30.4));
    const span = months >= 2 ? `about ${months} months` : plural(days.length, "day");
    // Plenty of history, but not in the last year: a source that stopped.
    const stale = days.length >= 7 * SEASONS.year_weeks;
    const flat = normal !== null && normal.weeks >= SEASONS.min_weeks && normal.median <= 0;
    return {
      status: "too_little",
      series,
      first_day: first,
      last_day: last,
      covered_days: days.length,
      complete_weeks: complete,
      needed_weeks: SEASONS.min_weeks,
      ready_on: readyOn,
      recent,
      recent_median:
        recent.length > 0
          ? quantile(
              recent.map((r) => r.value),
              0.5,
            )
          : null,
      headline: flat
        ? `Most of your weeks measured no ${series.noun}, so there is no normal week to compare a season with.`
        : stale
          ? `Only ${plural(complete, "week")} of the last ${SEASONS.year_weeks} were measured in full (the last measured day is ${shortDate(last)}) — too few to name your seasons.`
          : `I have ${span} of your ${series.noun} — not enough to say which weeks of the year are your busy ones.`,
      can: [
        recent.length >= 2
          ? `Show your ${plural(recent.length, "complete week")} against each other, and spot a week that ran well above or below the rest.`
          : "Count each day as it is measured.",
        "Catch a sudden drop or spike against the last four weeks (that runs nightly already).",
      ],
      cannot: [
        "Say which weeks or months of the year run above or below your normal: one year of your own history is the least that shows a season.",
        "Forecast the coming weeks from the same weeks last year — I don't have last year.",
        "Borrow a season from other businesses like yours. An industry average isn't your history, so I don't present one as yours.",
      ],
    };
  }

  // Earlier years, each against its own normal (the range widens with them).
  const priorNormals: { shift: number; normal: Normal }[] = [];
  for (let y = 1; y < SEASONS.max_years; y++) {
    const shift = 364 * y;
    const n = normalOver(weeks, addDays(yearFrom, -shift), addDays(yearTo, -shift));
    if (n !== null && n.weeks >= SEASONS.min_weeks && n.median > 0)
      priorNormals.push({ shift, normal: n });
    else break;
  }
  const otherYears = (start: string, span: number): Ratio | null => {
    let out: Ratio | null = null;
    for (const { shift, normal: n } of priorNormals) {
      let total = 0;
      let whole = true;
      for (let k = 0; k < span; k++) {
        const v = weeks.get(addDays(start, -shift + 7 * k));
        if (v === undefined) {
          whole = false;
          break;
        }
        total += v;
      }
      if (!whole) continue;
      const r = ratioOf(total, span, n);
      out = out === null ? r : widen(out, r);
    }
    return out;
  };

  const yearWeeks: SeasonWeek[] = [];
  for (let start = yearFrom; start <= yearTo; start = addDays(start, 7)) {
    const value = weeks.get(start);
    if (value === undefined) continue;
    const r = widen(ratioOf(value, 1, normal), otherYears(start, 1));
    yearWeeks.push({ start, value, ...r, flag: flagOf(r.index) });
  }

  const runs = findRuns(yearWeeks, normal).map((run) =>
    Object.assign(run, widen(run, otherYears(run.start, run.weeks))),
  );

  // Calendar months of the last year, scaled to a week.
  const monthDays = new Map<string, { total: number; days: number }>();
  for (const d of days) {
    if (d < yearFrom || d > yesterday) continue;
    const m = d.slice(0, 7);
    const cur = monthDays.get(m) ?? { total: 0, days: 0 };
    cur.total += values.get(d) ?? 0;
    cur.days += 1;
    monthDays.set(m, cur);
  }
  const months: SeasonMonth[] = [...monthDays.entries()]
    .filter(([, v]) => v.days >= SEASONS.min_month_days)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, v]) => {
      const perWeek = (v.total / v.days) * 7;
      return {
        month,
        label: `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`,
        days: v.days,
        per_week: perWeek,
        ...ratioOf(perWeek, 1, normal),
      };
    });

  // The next eight weeks, against the same weeks last year.
  const ahead: AheadWeek[] = [];
  for (let k = 0; k < SEASONS.horizon_weeks; k++) {
    const start = addDays(thisMonday, 7 * k);
    const ly = addDays(start, -364);
    const w = yearWeeks.find((x) => x.start === ly) ?? null;
    ahead.push({
      start,
      last_year_start: ly,
      last_year: w ? { index: w.index, low: w.low, high: w.high, value: w.value } : null,
      flag: w?.flag ?? null,
    });
  }

  const horizonFrom = addDays(thisMonday, -364);
  const horizonTo = addDays(horizonFrom, 7 * SEASONS.horizon_weeks - 1);
  const before = weeks.get(addDays(horizonFrom, -7));
  const weekBefore = before === undefined ? null : flagOf(ratioOf(before, 1, normal).index);
  const upcoming: Upcoming[] = runs
    .filter((r) => r.start <= horizonTo && r.end >= horizonFrom)
    .map((run) => {
      // The year's first week is the horizon's: the stretch was under way
      // already when the week before it, just outside the year, ran the same way.
      const inProgress = run.start === horizonFrom && weekBefore === run.kind;
      const startsIn = inProgress ? 0 : Math.round(daysBetween(horizonFrom, run.start) / 7);
      const startsOn = addDays(run.start, 364);
      const endsOn = addDays(run.end, 364);
      const word = run.kind === "busy" ? "above" : "below";
      const when = inProgress
        ? `The same weeks this year are under way now, to ${shortDate(endsOn)}.`
        : startsIn === 0
          ? `The same weeks this year start this week, on ${shortDate(startsOn)}.`
          : `The same weeks this year start in ${plural(startsIn, "week")}, on ${shortDate(startsOn)}.`;
      return {
        run,
        starts_in_weeks: startsIn,
        starts_on: startsOn,
        ends_on: endsOn,
        in_progress: inProgress,
        sentence: `${runPhrase(run)} last year ran ${ratioText(run)} your normal week — ${word} it. ${when}`,
      };
    });

  const years = 1 + priorNormals.length;
  const busiest = [...runs].filter((r) => r.kind === "busy").sort((a, b) => b.index - a.index)[0];
  const nextBusy = upcoming.find((u) => u.run.kind === "busy");
  const headline = nextBusy
    ? nextBusy.in_progress
      ? `Your busy weeks are under way: last year the same stretch ran ${times(nextBusy.run.index)} your normal week.`
      : `Your busy stretch starts in ${plural(nextBusy.starts_in_weeks, "week")}: last year it ran ${times(nextBusy.run.index)} your normal week.`
    : busiest
      ? `Nothing busy in the next ${SEASONS.horizon_weeks} weeks last year; your busiest stretch ran ${times(busiest.index)} your normal week from ${shortDate(busiest.start)}.`
      : `No stretch of the last year ran far from your normal week: your ${series.noun} is steady through the year.`;

  const gaps = SEASONS.year_weeks - normal.weeks;
  const notes = [
    years === 1
      ? "One year is one example of your seasons: it says what happened last year, not what will. The range is how far your middle half of weeks spreads."
      : `${plural(years, "year")} of your own history went into the ranges: each year's week against that year's own normal.`,
    `Normal is your median week of the last ${SEASONS.year_weeks}: ${plural(normal.weeks, "complete week")} from ${shortDate(normal.from)} to ${shortDate(normal.to)}.`,
    `Busy is ${times(SEASONS.busy_index)} your normal or more, quiet ${times(SEASONS.quiet_index)} or less, ${SEASONS.min_run_weeks} weeks or more in a row: a single week can be a one-off.`,
  ];
  if (gaps > 0) {
    notes.push(
      `${plural(gaps, "week")} of the last ${SEASONS.year_weeks} weren't measured in full, so they are left out, not guessed.`,
    );
  }
  if (daysBetween(last, yesterday) > 7) {
    notes.push(`The last measured day is ${shortDate(last)}: the forecast reads up to then.`);
  }

  return {
    status: "ready",
    series,
    today,
    first_day: first,
    last_day: last,
    covered_days: days.length,
    years,
    normal,
    weeks: yearWeeks,
    months,
    runs,
    ahead,
    upcoming,
    headline,
    notes,
  };
}
