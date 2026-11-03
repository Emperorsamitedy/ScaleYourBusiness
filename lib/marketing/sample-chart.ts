// "Your business, read like a stock." — each illustrative business's 90
// days of revenue, drawn as candles on the landing page. FICTIONAL, and
// labelled "Illustrative store · 90 days" / "Illustrative salon · 90 days"
// where it renders. The webshop's series is the owner's design
// (2026-10-17); the salon's (2026-10-22) is built the same way.
//
// Generated once, deterministically (a seeded Park–Miller generator), so
// the server and the browser draw the same chart and hydration never
// disagrees. Each series is a recipe — seed, trend, weekly swing, and the
// leaks that cut into it, as data — fed to one generator. Money is integer
// minor units in EUR (CLAUDE.md rule 1); the arithmetic that shapes a
// series runs in floats and is rounded to cents once, at the end.

export interface Candle {
  /** Day number from day 0 (the first day of the bucket, for weeks). */
  day: number;
  open_minor: number;
  high_minor: number;
  low_minor: number;
  close_minor: number;
  /** Orders for the webshop, paid visits for the salon — the volume pane. */
  volume: number;
  /** Revenue without leaks — the dotted line. */
  ideal_minor: number;
}

/** Where a leak began, by day number, and what it cut from the day's revenue. */
export interface ChartEvent {
  day: number;
  /** Last day the cut applies; absent, it runs to the end. */
  until?: number;
  /** Share of the no-leak revenue lost while it runs. */
  cut: number;
  key: string;
  label: string;
  note: string;
}

export interface ChartSeries {
  id: "shop" | "salon";
  /** The chart's toolbar title. */
  title: string;
  /** "Illustrative {noun} · 90 days". */
  noun: string;
  /** The legend's word for the volume pane. */
  volume_label: string;
  /** The price axis, in minor units. */
  axis: { lo_minor: number; hi_minor: number };
  events: readonly ChartEvent[];
  /** The chart's text alternative. */
  description: string;
  days: readonly Candle[];
  weeks: readonly Candle[];
}

export const CHART_CURRENCY = "EUR";
export const CHART_DAY_COUNT = 90;

/** Day 0 of both illustrative series: 20 Jul 2026. */
const START_UTC = Date.UTC(2026, 6, 20);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20 Jul" — fixed English, no locale guessing, same on server and browser. */
export function chartDate(day: number): string {
  const dt = new Date(START_UTC + day * 86_400_000);
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`;
}

/** The same day as an ISO date, for the locale formatters (L-3d): 0 → "2026-07-20". */
export function chartIsoDay(day: number): string {
  return new Date(START_UTC + day * 86_400_000).toISOString().slice(0, 10);
}

const cents = (euros: number) => Math.round(euros * 100);

/** One series' shape, in euros a day. */
interface Recipe {
  seed: number;
  base: number;
  slope: number;
  weekly: number;
  noise: number;
  wick: number;
  /** volume = base + close / per + jitter × rand */
  volume: { base: number; per: number; jitter: number };
}

function generate(recipe: Recipe, events: readonly ChartEvent[]): Candle[] {
  let seed = recipe.seed;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const out: Candle[] = [];
  let prev = recipe.base;
  for (let d = 0; d < CHART_DAY_COUNT; d++) {
    const ideal = recipe.base + d * recipe.slope + Math.sin((d / 7) * Math.PI * 2) * recipe.weekly;
    let hit = 0;
    for (const e of events) if (d >= e.day && d <= (e.until ?? Infinity)) hit += e.cut;
    const target = ideal * (1 - hit) + (rand() - 0.5) * recipe.noise;
    const o = prev;
    const c = target;
    const h = Math.max(o, c) + rand() * recipe.wick;
    const l = Math.min(o, c) - rand() * recipe.wick;
    out.push({
      day: d,
      open_minor: cents(o),
      close_minor: cents(c),
      high_minor: cents(h),
      low_minor: cents(l),
      volume: Math.round(
        recipe.volume.base + c / recipe.volume.per + rand() * recipe.volume.jitter,
      ),
      ideal_minor: cents(ideal),
    });
    prev = c;
  }
  return out;
}

/** The same series in 13 weekly candles: first open, last close, extremes, summed volume. */
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
      volume: chunk.reduce((a, x) => a + x.volume, 0),
      ideal_minor: last.ideal_minor,
    });
  }
  return out;
}

function series(head: Omit<ChartSeries, "days" | "weeks">, recipe: Recipe): ChartSeries {
  const days = generate(recipe, head.events);
  return { ...head, days, weeks: weekly(days) };
}

/** The webshop: the owner's design, unchanged. */
export const SHOP_CHART: ChartSeries = series(
  {
    id: "shop",
    title: "STORE · REVENUE",
    noun: "store",
    volume_label: "Orders",
    axis: { lo_minor: 90_000, hi_minor: 190_000 },
    events: [
      {
        day: 23,
        cut: 0.1,
        key: "T",
        label: "Theme update",
        note: "Theme update — mobile checkout slows",
      },
      {
        day: 51,
        until: 57,
        cut: 0.22,
        key: "S",
        label: "Stock-out",
        note: "Stock-out — best-sellers hit zero",
      },
      {
        day: 70,
        cut: 0.05,
        key: "F",
        label: "Free-shipping line",
        note: "Free-shipping line left too low",
      },
    ],
    description:
      "Candlestick chart of an illustrative store's daily revenue over 90 days. A dotted line shows revenue without leaks; the shaded gap between them is money lost. Three markers show where leaks began: a theme update, a stock-out and a shipping change.",
  },
  {
    seed: 19,
    base: 1380,
    slope: 2.6,
    weekly: 70,
    noise: 110,
    wick: 70,
    volume: { base: 18, per: 70, jitter: 6 },
  },
);

/** The salon: a strong Saturday, and three leaks a booking business knows. */
export const SALON_CHART: ChartSeries = series(
  {
    id: "salon",
    title: "SALON · REVENUE",
    noun: "salon",
    volume_label: "Visits",
    axis: { lo_minor: 80_000, hi_minor: 160_000 },
    events: [
      {
        day: 20,
        cut: 0.06,
        key: "L",
        label: "Stylist leaves",
        note: "A stylist leaves — her regulars stop rebooking",
      },
      {
        day: 44,
        cut: 0.1,
        key: "B",
        label: "Online booking",
        note: "Online booking opens with no deposit — no-shows climb",
      },
      {
        day: 68,
        cut: 0.04,
        key: "R",
        label: "Retail shelf moved",
        note: "Retail shelf moved off the desk — product sales fall",
      },
    ],
    description:
      "Candlestick chart of an illustrative salon's daily revenue over 90 days. A dotted line shows revenue without leaks; the shaded gap between them is money lost. Three markers show where leaks began: a stylist leaving, online booking without a deposit, and the retail shelf moving.",
  },
  {
    seed: 7,
    base: 1250,
    slope: 1.2,
    weekly: 170,
    noise: 120,
    wick: 80,
    volume: { base: -1, per: 58, jitter: 2 },
  },
);

/** Both series, in the demos' order. */
export const CHART_SERIES: readonly ChartSeries[] = [SHOP_CHART, SALON_CHART];
