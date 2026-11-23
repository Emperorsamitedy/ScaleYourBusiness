// Home's money picture (2026-11-23, the owner: "the very first thing on the
// home page has to have something bold at the very top"; he picked the cash
// chart, then asked for less height and less text). Pure: which headline the
// band says, the weeks it draws, and the bills pinned on them. Every figure is
// the cash forecast's own (/api/cash, lib/cash/model): nothing is worked out
// here but where to put it.

export interface MoneyWeek {
  start: string;
  balance: { low: number; high: number };
  due?: readonly { amount_minor: number; on: string }[];
}

export interface MoneyForecast {
  today: string;
  currency: string;
  start: { amount_minor: number };
  line: { amount_minor: number; kind: "buffer" | "zero" };
  weeks: readonly MoneyWeek[];
}

/** The headline's key in home.money, and the week it names. */
export type MoneyHeadline =
  | { key: "clear" | "clearZero"; week: null }
  | { key: "tightStays" | "tightStaysZero"; week: null }
  | { key: "tightNow" | "tightNowZero"; week: string }
  | { key: "tightLater" | "tightLaterZero"; week: string };

/**
 * Pure: what the band's headline says, read off the cautious end of each
 * week against the line the owner keeps (the buffer, or zero when none is
 * stated). Under it this week and over it again later: when it is over again.
 * Under it this week and never over in the weeks drawn: that it stays under.
 * Over it now but under later: the first week it dips. Never under: clear.
 */
export function moneyHeadline(f: MoneyForecast): MoneyHeadline {
  const line = f.line.amount_minor;
  const zero = f.line.kind === "zero";
  const under = (w: MoneyWeek) => w.balance.low < line;
  const first = f.weeks.findIndex(under);
  if (first === -1) return { key: zero ? "clearZero" : "clear", week: null };
  if (first === 0) {
    const back = f.weeks.findIndex((w, i) => i > 0 && !under(w));
    if (back === -1) return { key: zero ? "tightStaysZero" : "tightStays", week: null };
    return { key: zero ? "tightNowZero" : "tightNow", week: f.weeks[back]!.start };
  }
  return { key: zero ? "tightLaterZero" : "tightLater", week: f.weeks[first]!.start };
}

/** Pure: the first week whose cautious end dips under the line, or null. */
export function firstTight(f: MoneyForecast, weeks: number): number | null {
  const i = f.weeks.slice(0, weeks).findIndex((w) => w.balance.low < f.line.amount_minor);
  return i === -1 ? null : i;
}

/** One pin on the chart: the bills that fall due on a day, at their place on the axis. */
export interface MoneyPin {
  /** Position in the chart's points (today is 0, the end of week n is n + 1), with the day's fraction. */
  at: number;
  on: string;
  amount_minor: number;
}

const DAY_MS = 86_400_000;
const dayOf = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/**
 * Pure: the bills of the weeks drawn, one pin per day they fall due, summed.
 * A week runs from its start to the end point drawn for it, so a bill due on
 * its nth day stands n sevenths of the way along.
 */
export function moneyPins(f: MoneyForecast, weeks: number): MoneyPin[] {
  const pins = new Map<string, MoneyPin>();
  f.weeks.slice(0, weeks).forEach((w, i) => {
    for (const d of w.due ?? []) {
      const day = d.on.slice(0, 10);
      const into = Math.min(7, Math.max(0, (dayOf(day) - dayOf(w.start)) / DAY_MS + 1));
      const kept = pins.get(day);
      if (kept) kept.amount_minor += d.amount_minor;
      else pins.set(day, { at: i + into / 7, on: day, amount_minor: d.amount_minor });
    }
  });
  return [...pins.values()].sort((a, b) => a.at - b.at);
}
