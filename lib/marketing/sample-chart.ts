// "Your store, read like a stock." — the illustrative store's 90 days of
// revenue, drawn as candles on the landing page. FICTIONAL, and labelled
// "Illustrative store · 90 days" where it renders.
//
// Generated once, deterministically (a seeded Park–Miller generator, the
// owner's design 2026-10-17), so the server and the browser draw the same
// chart and hydration never disagrees. Money is integer minor units in
// EUR (CLAUDE.md rule 1); the arithmetic that shapes the series runs in
// floats and is rounded to cents once, at the end.

export interface Candle {
  /** Day number from CHART_START (the first day of the bucket, for weeks). */
  day: number;
  open_minor: number;
  high_minor: number;
  low_minor: number;
  close_minor: number;
  orders: number;
  /** Revenue without leaks — the dotted line. */
  ideal_minor: number;
}

export const CHART_CURRENCY = "EUR";
export const CHART_DAY_COUNT = 90;

/** Day 0 of the illustrative series: 20 Jul 2026. */
const START_UTC = Date.UTC(2026, 6, 20);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20 Jul" — fixed English, no locale guessing, same on server and browser. */
export function chartDate(day: number): string {
  const dt = new Date(START_UTC + day * 86_400_000);
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`;
}

/** Where each leak began, by day number. */
export const CHART_EVENTS = [
  { day: 23, key: "T", label: "Theme update", note: "Theme update — mobile checkout slows" },
  { day: 51, key: "S", label: "Stock-out", note: "Stock-out — best-sellers hit zero" },
  { day: 70, key: "F", label: "Free-shipping line", note: "Free-shipping line left too low" },
] as const;

const cents = (euros: number) => Math.round(euros * 100);

function generate(): Candle[] {
  let seed = 19;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const out: Candle[] = [];
  let prev = 1380;
  for (let d = 0; d < CHART_DAY_COUNT; d++) {
    const ideal = 1380 + d * 2.6 + Math.sin((d / 7) * Math.PI * 2) * 70;
    let hit = 0;
    if (d >= 23) hit += 0.1;
    if (d >= 51 && d <= 57) hit += 0.22;
    if (d >= 70) hit += 0.05;
    const target = ideal * (1 - hit) + (rand() - 0.5) * 110;
    const o = prev;
    const c = target;
    const h = Math.max(o, c) + rand() * 70;
    const l = Math.min(o, c) - rand() * 70;
    out.push({
      day: d,
      open_minor: cents(o),
      close_minor: cents(c),
      high_minor: cents(h),
      low_minor: cents(l),
      orders: Math.round(18 + c / 70 + rand() * 6),
      ideal_minor: cents(ideal),
    });
    prev = c;
  }
  return out;
}

export const CHART_DAYS: readonly Candle[] = generate();

/** The same series in 13 weekly candles: first open, last close, extremes, summed orders. */
export function weekly(days: readonly Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let w = 0; w * 7 < days.length; w++) {
    const chunk = days.slice(w * 7, w * 7 + 7);
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    if (!first || !last) break;
    out.push({
      day: w * 7,
      open_minor: first.open_minor,
      close_minor: last.close_minor,
      high_minor: Math.max(...chunk.map((x) => x.high_minor)),
      low_minor: Math.min(...chunk.map((x) => x.low_minor)),
      orders: chunk.reduce((a, x) => a + x.orders, 0),
      ideal_minor: last.ideal_minor,
    });
  }
  return out;
}

export const CHART_WEEKS: readonly Candle[] = weekly(CHART_DAYS);
