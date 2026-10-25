// The smaller charts beside the market chart — pure. Each exists only
// where there is a data story; with nothing to tell, the builder returns
// null and the screen draws nothing (no empty frame).
//
//   bookings   completed appointments against no-shows and late
//              cancellations, week by week, with the revenue those missed
//              slots were worth (the same no-show and late-cancellation
//              components the market chart adds up)
//   ads        each campaign's spend against the purchase value Meta
//              attributes to it, over the window; those returning less
//              than they cost are marked LOSING

import { moneyText, num } from "../../components/sheet/num";
import { weekStart } from "../care/chart-view";
import type { MarketChartModel } from "./model";
import { shortDate } from "./model";
import type { BookingsInput, CampaignWindow, PricedComponent, Window } from "./opportunity";
import { OPPORTUNITY, daysInclusive, lateCancellations, noShows, rangeWhole } from "./opportunity";

export interface BookingsWeek {
  /** The Monday. */
  start: string;
  days: number;
  completed: number;
  no_show: number;
  late: number | null;
  /** What that week's no-shows and late cancellations were worth; null without prices. */
  lost_low_minor: number | null;
  lost_high_minor: number | null;
}

export interface BookingsChartModel {
  source: string;
  currency: string | null;
  window: { from: string; to: string; days: number };
  late_separated: boolean;
  weeks: BookingsWeek[];
  /** The price arithmetic and what the band means; or why there is no band. */
  lost_note: string;
  totals: { completed: number; no_show: number; late: number | null };
  summary: string;
}

export function buildBookingsChart(
  b: BookingsInput | null,
  _market: MarketChartModel,
  w: Window,
): BookingsChartModel | null {
  if (b === null) return null;
  const days = b.days.filter((d) => d.date >= w.from && d.date <= w.to);
  if (days.length === 0) return null;
  const ns = noShows(b, w);
  const lc = lateCancellations(b, w);
  const priced = [ns, lc].filter((c): c is PricedComponent => c.status === "priced");
  const lostBy = new Map<string, { lo: number; hi: number }>();
  for (const c of priced) {
    for (const d of c.daily) {
      const k = weekStart(d.date);
      const acc = lostBy.get(k) ?? { lo: 0, hi: 0 };
      acc.lo += d.low_minor;
      acc.hi += d.high_minor;
      lostBy.set(k, acc);
    }
  }
  const weeks = new Map<string, BookingsWeek>();
  for (const d of days) {
    const k = weekStart(d.date);
    const wk = weeks.get(k) ?? {
      start: k,
      days: 0,
      completed: 0,
      no_show: 0,
      late: b.late_separated ? 0 : null,
      lost_low_minor: priced.length > 0 ? 0 : null,
      lost_high_minor: priced.length > 0 ? 0 : null,
    };
    wk.days += 1;
    wk.completed += d.completed;
    wk.no_show += d.no_show;
    if (wk.late !== null) wk.late += d.late ?? 0;
    weeks.set(k, wk);
  }
  for (const wk of weeks.values()) {
    const lost = lostBy.get(wk.start);
    if (lost && wk.lost_low_minor !== null) {
      wk.lost_low_minor = lost.lo;
      wk.lost_high_minor = lost.hi;
    }
  }
  const list = [...weeks.values()].sort((a, b2) => a.start.localeCompare(b2.start));
  const totals = {
    completed: list.reduce((n, x) => n + x.completed, 0),
    no_show: list.reduce((n, x) => n + x.no_show, 0),
    late: b.late_separated ? list.reduce((n, x) => n + (x.late ?? 0), 0) : null,
  };
  const lostTotal = priced.reduce(
    (acc, c) => ({ lo: acc.lo + c.total.low_minor, hi: acc.hi + c.total.high_minor }),
    { lo: 0, hi: 0 },
  );
  const lostNote =
    priced.length === 0
      ? ns.status === "absent"
        ? `No money band: ${ns.reason}.`
        : "No money band."
      : `${priced.map((c) => c.formula).join(". ")}.`;
  const summary =
    `Appointments a week from ${b.source}, ${shortDate(list[0]!.start)} to ${shortDate(w.to)}: ` +
    `${num(totals.completed)} completed, ${num(totals.no_show)} no-shows` +
    (totals.late !== null ? `, ${num(totals.late)} late cancellations` : "") +
    (priced.length > 0 && b.currency
      ? `; the missed slots were worth ${rangeWhole({ low_minor: lostTotal.lo, high_minor: lostTotal.hi, currency: b.currency })}.`
      : ".");
  return {
    source: b.source,
    currency: priced.length > 0 ? b.currency : null,
    window: { from: w.from, to: w.to, days: daysInclusive(w.from, w.to) },
    late_separated: b.late_separated,
    weeks: list,
    lost_note: lostNote,
    totals,
    summary,
  };
}

export interface AdsChartModel {
  window: { from: string; to: string; days: number };
  campaigns: CampaignWindow[];
  losing: number;
  summary: string;
}

export function buildAdsChart(
  campaigns: readonly CampaignWindow[],
  w: Window,
): AdsChartModel | null {
  const spent = campaigns.filter((c) => c.spend_minor > 0);
  if (spent.length === 0) return null;
  const losing = spent.filter((c) => c.losing);
  const roas = (c: CampaignWindow) => (c.roas === null ? "no return" : `return ${num(c.roas, 2)}`);
  const summary =
    `Spend against the purchase value Meta attributes, per campaign, ${shortDate(w.from)} to ${shortDate(w.to)}: ` +
    spent
      .map(
        (c) =>
          `${c.campaign_name} spent ${moneyText(c.spend_minor, c.currency)}, Meta attributes ${moneyText(c.value_minor, c.currency)} (${roas(c)})${c.losing ? ", losing" : ""}`,
      )
      .join("; ") +
    `. Losing means a return below ${num(OPPORTUNITY.losing_roas_below, 1)}.`;
  return {
    window: { from: w.from, to: w.to, days: daysInclusive(w.from, w.to) },
    campaigns: spent,
    losing: losing.length,
    summary,
  };
}
