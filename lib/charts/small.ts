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

import { listSep } from "../i18n/punctuation";
import { moneyText, num } from "../../components/sheet/num";
import { weekStart } from "../care/chart-view";
import type { MarketChartModel } from "./model";
import { shortDate } from "./model";
import type { BookingsInput, CampaignWindow, PricedComponent, Window } from "./opportunity";
import { OPPORTUNITY, daysInclusive, lateCancellations, noShows, rangeWhole } from "./opportunity";
import type { Words } from "./words";
import { englishChartWords } from "./words";

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
  words: Words = englishChartWords(),
): BookingsChartModel | null {
  const { tr, locale } = words;
  if (b === null) return null;
  const days = b.days.filter((d) => d.date >= w.from && d.date <= w.to);
  if (days.length === 0) return null;
  const ns = noShows(b, w, words);
  const lc = lateCancellations(b, w, words);
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
        ? tr("small.noBandBecause", { reason: ns.reason })
        : tr("small.noBand")
      : priced.map((c) => tr("small.sentence", { text: c.formula })).join(" ");
  const worth = priced.length > 0 && b.currency !== null;
  const summaryKey =
    totals.late !== null
      ? worth
        ? "small.bookingsLateWorth"
        : "small.bookingsLate"
      : worth
        ? "small.bookingsWorth"
        : "small.bookings";
  const summary = tr(summaryKey, {
    source: b.source,
    from: shortDate(list[0]!.start, locale),
    to: shortDate(w.to, locale),
    completed: totals.completed,
    noShows: totals.no_show,
    late: totals.late ?? 0,
    range:
      worth && b.currency !== null
        ? rangeWhole(
            { low_minor: lostTotal.lo, high_minor: lostTotal.hi, currency: b.currency },
            locale,
          )
        : "",
  });
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
  words: Words = englishChartWords(),
): AdsChartModel | null {
  const { tr, locale } = words;
  const spent = campaigns.filter((c) => c.spend_minor > 0);
  if (spent.length === 0) return null;
  const losing = spent.filter((c) => c.losing);
  const roas = (c: CampaignWindow) =>
    c.roas === null ? tr("small.noReturn") : tr("small.return", { roas: num(c.roas, 2, locale) });
  const google = spent.some((c) => c.platform === "google");
  const summary = tr(google ? "small.adsPlatforms" : "small.ads", {
    from: shortDate(w.from, locale),
    to: shortDate(w.to, locale),
    campaigns: spent
      .map((c) =>
        tr(
          c.platform === "google"
            ? c.losing
              ? "small.adsCampaignGoogleLosing"
              : "small.adsCampaignGoogle"
            : c.losing
              ? "small.adsCampaignLosing"
              : "small.adsCampaign",
          {
            campaign: c.campaign_name,
            spent: moneyText(c.spend_minor, c.currency, locale),
            value: moneyText(c.value_minor, c.currency, locale),
            roas: roas(c),
          },
        ),
      )
      .join(listSep(locale)),
    even: num(OPPORTUNITY.losing_roas_below, 1, locale),
  });
  return {
    window: { from: w.from, to: w.to, days: daysInclusive(w.from, w.to) },
    campaigns: spent,
    losing: losing.length,
    summary,
  };
}
