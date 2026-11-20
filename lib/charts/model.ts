// The market chart's model — pure. The loader (./load) reads the database
// into MarketInputs; this turns them into what the screen draws: the days
// (price, volume and what slipped each day), the event markers, every
// opportunity component in the profile's order, the headline, and the
// text alternative. JSON-serialisable, so the API hands it to the client
// as is, and the client buckets it (./candles) for the 1D/1W/1M switch.

import { listSep } from "../i18n/punctuation";
import type { AppLocale } from "../i18n/locales";
import { dayMonth, intlMoney, monthYear } from "../i18n/format";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
import { minorUnitExponent } from "../core/money";
import { moneyText, num } from "../../components/sheet/num";
import type { Basis } from "../../components/report/basis";
import type { Bucket, Candle, DayPoint, SlipPart } from "./candles";
import type {
  AbsentComponent,
  BookingsInput,
  CampaignInput,
  CapacityInput,
  ComponentKey,
  Headline,
  OpportunityComponent,
  PricedComponent,
  SlowItemInput,
  WaitingProposal,
  Window,
} from "./opportunity";
import {
  COMPONENT_KIND,
  OPPORTUNITY,
  absent,
  daysInclusive,
  emptyCapacity,
  headline,
  lateCancellations,
  losingAds,
  noShows,
  onTheTable,
  rangeWhole,
  revenueDips,
  slowStock,
  windowEnding,
} from "./opportunity";
import type { ArchetypeKey, PriceCandidate, VolumeCandidate } from "./profiles";
import { CHART_ARCHETYPES } from "./profiles";
import type { Words } from "./words";
import { englishChartWords, priceCode } from "./words";

/** Fewer measured days than this and a series isn't drawn: two weeks, the detector's own floor. */
export const MIN_DRAWN_DAYS = 14;
/** How far back the chart reads. */
export const HISTORY_DAYS = 365;

export type EventKind = "anomaly" | "approved" | "connected";

export interface MarketEvent {
  date: string;
  kind: EventKind;
  /** Short, for the key: "Visits rose 41% above the usual level". */
  label: string;
  /** The arithmetic or the decision, in full. */
  detail: string;
}

/** The words for each kind of marker, printed in the key — the shape carries it too. */
export const EVENT_WORD: Readonly<Record<EventKind, string>> = {
  anomaly: "Detected",
  approved: "You approved",
  connected: "Connected",
};

export interface PriceSeriesInput {
  candidate: PriceCandidate;
  /** "Shopify", "your bookings export". */
  source: string;
  /** "connector:shopify:revenue.daily". */
  series_id: string;
  currency: string;
  values: ReadonlyMap<string, number>;
}

export interface VolumeSeriesInput {
  candidate: VolumeCandidate;
  source: string;
  values: ReadonlyMap<string, number>;
}

export interface MarketInputs {
  /** The run day; the chart reads up to yesterday. */
  today: string;
  /** "your salon". */
  noun: string;
  archetype: ArchetypeKey;
  price: PriceSeriesInput | null;
  volume: VolumeSeriesInput | null;
  bookings: BookingsInput | null;
  capacity: CapacityInput | null;
  /** Null when Meta Ads isn't connected. */
  campaigns: CampaignInput[] | null;
  /** Null when no stock source exists. */
  stock: { items: SlowItemInput[]; as_of: string | null } | null;
  waiting: WaitingProposal[];
  events: MarketEvent[];
  /** Price series measured in another currency, not drawn (one currency per chart). */
  other_currencies: string[];
  /** Components the profile lists that don't apply here (a business that holds no stock). */
  skip?: readonly ComponentKey[];
}

export interface DrawnModel {
  status: "drawn";
  noun: string;
  /** "Your salon, read like a stock". */
  title: string;
  archetype: ArchetypeKey;
  /** The candle period the chart opens on (the profile row's). */
  bucket: Bucket;
  currency: string;
  price: {
    metric: string;
    label: string;
    noun: string;
    source: string;
    basis: Basis;
    from: string;
    to: string;
    days_measured: number;
  };
  volume: { metric: string; word: string; source: string } | null;
  days: DayPoint[];
  events: MarketEvent[];
  components: OpportunityComponent[];
  headline: Headline;
  window: { from: string; to: string; days: number };
  notes: string[];
}

export interface EmptyModel {
  status: "empty";
  noun: string;
  title: string;
  /** "Connect Shopify or WooCommerce … and I'll draw this." */
  message: string;
  href: string;
  /** What each component would need, so the owner sees what the data would buy. */
  components: AbsentComponent[];
}

export type MarketChartModel = DrawnModel | EmptyModel;

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Capitalised the way the reader's language does it (Chinese has no case). */
const capitaliseIn = (s: string, locale: AppLocale) =>
  locale === "en" ? capitalise(s) : s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);

export function chartTitle(noun: string): string {
  return `${capitalise(noun)}, read like a stock`;
}

/** Components drawn on the revenue line: the flows that are lost revenue (ads are spend, not revenue). */
export const ON_THE_LINE: ReadonlySet<ComponentKey> = new Set([
  "revenue_dips",
  "no_shows",
  "late_cancellations",
  "empty_capacity",
]);

/**
 * Pure: the model the screen draws, or the empty state. L-4b: its
 * sentences (the headline, notes, reasons, formulas, the empty state's
 * invitation) in `words`, English by default.
 */
export function buildMarketModel(
  input: MarketInputs,
  words: Words = englishChartWords(),
): MarketChartModel {
  const { tr } = words;
  const base = CHART_ARCHETYPES[input.archetype];
  const row = { ...base, components: base.components.filter((k) => !input.skip?.includes(k)) };
  const title = chartTitle(input.noun);
  const measured = input.price ? [...input.price.values.keys()].sort() : [];
  if (input.price === null || measured.length < MIN_DRAWN_DAYS) {
    // Nothing to draw. Each component still says what it would need.
    const components = row.components.map((key) => absentFor(key, input, words));
    return {
      status: "empty",
      noun: input.noun,
      title,
      message: tr(`connect.${input.archetype}`),
      href: "/connections",
      components,
    };
  }
  const price = input.price;
  const to = measured.at(-1)!;
  const w: Window = windowEnding(to);

  // The bookings lines first: the dips then take off what they already explain.
  const byKey = new Map<ComponentKey, OpportunityComponent>();
  const want = new Set(row.components);
  if (want.has("no_shows")) byKey.set("no_shows", noShows(input.bookings, w, words));
  if (want.has("late_cancellations")) {
    byKey.set("late_cancellations", lateCancellations(input.bookings, w, words));
  }
  if (want.has("empty_capacity")) {
    byKey.set("empty_capacity", emptyCapacity(input.bookings, input.capacity, w, words));
  }
  const explained = new Map<string, { low_minor: number; high_minor: number }>();
  for (const c of byKey.values()) {
    if (c.status !== "priced" || c.total.currency !== price.currency) continue;
    for (const d of c.daily) {
      const acc = explained.get(d.date) ?? { low_minor: 0, high_minor: 0 };
      acc.low_minor += d.low_minor;
      acc.high_minor += d.high_minor;
      explained.set(d.date, acc);
    }
  }
  if (want.has("revenue_dips")) {
    byKey.set(
      "revenue_dips",
      revenueDips(
        {
          series: price.values,
          currency: price.currency,
          series_id: price.series_id,
          noun: price.candidate.noun,
          metric: price.candidate.metric,
        },
        w,
        explained,
        words,
      ),
    );
  }
  if (want.has("losing_ads")) {
    byKey.set(
      "losing_ads",
      losingAds(
        input.campaigns,
        windowEnding(to, OPPORTUNITY.ads_window_days),
        price.currency,
        words,
      ),
    );
  }
  if (want.has("slow_stock")) {
    byKey.set(
      "slow_stock",
      slowStock(input.stock?.items ?? null, price.currency, input.stock?.as_of ?? null, words),
    );
  }
  if (want.has("on_the_table")) {
    byKey.set("on_the_table", onTheTable(input.waiting, price.currency, input.today, words));
  }
  const components = row.components.map((k) => byKey.get(k)!);

  // A component in another currency is priced, but never drawn or added.
  const onLine = components.filter(
    (c): c is PricedComponent =>
      c.status === "priced" && ON_THE_LINE.has(c.key) && c.total.currency === price.currency,
  );
  const slipByDay = new Map<string, SlipPart[]>();
  for (const c of onLine) {
    for (const d of c.daily) {
      slipByDay.set(d.date, [
        ...(slipByDay.get(d.date) ?? []),
        { key: c.key, low_minor: d.low_minor, high_minor: d.high_minor },
      ]);
    }
  }

  const from = measured.find((d) => daysInclusive(d, to) <= HISTORY_DAYS) ?? measured[0]!;
  const days: DayPoint[] = measured
    .filter((d) => d >= from)
    .map((date) => {
      const v = input.volume?.values.get(date);
      const slip = slipByDay.get(date);
      return {
        date,
        value_minor: price.values.get(date)!,
        volume: v === undefined ? null : v,
        ...(slip ? { slip } : {}),
      };
    });

  const notes: string[] = [];
  if (input.other_currencies.length > 0) {
    notes.push(
      tr("note.otherCurrencies", {
        price: priceCode(price.candidate.metric),
        noun: capitalise(price.candidate.noun),
        currencies: input.other_currencies.join(", "),
      }),
    );
  }
  const offLine = components.filter(
    (c) => c.status === "priced" && c.kind === "flow" && !ON_THE_LINE.has(c.key),
  );
  if (offLine.length > 0) {
    notes.push(tr("note.adsOffLine"));
  }

  return {
    status: "drawn",
    noun: input.noun,
    title,
    archetype: input.archetype,
    bucket: base.bucket,
    currency: price.currency,
    price: {
      metric: price.candidate.metric,
      label: price.candidate.label,
      noun: price.candidate.noun,
      source: price.source,
      basis: "OBSERVED",
      from,
      to,
      days_measured: days.length,
    },
    volume: input.volume
      ? {
          metric: input.volume.candidate.metric,
          word: input.volume.candidate.word,
          source: input.volume.source,
        }
      : null,
    days,
    events: groupEvents(
      input.events.filter((e) => e.date >= from && e.date <= input.today),
      words,
    ),
    components,
    headline: headline(components, price.currency, words),
    window: { from: w.from, to: w.to, days: daysInclusive(w.from, w.to) },
    notes,
  };
}

/**
 * Oldest first, with same-day events of one kind folded into one marker
 * ("4 changes: …"), so a busy day doesn't bury the chart in numbers.
 */
export function groupEvents(
  events: readonly MarketEvent[],
  words: Words = englishChartWords(),
): MarketEvent[] {
  const groups = new Map<string, MarketEvent[]>();
  for (const e of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    const k = `${e.date}|${e.kind}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return [...groups.values()].map((list) =>
    list.length === 1
      ? list[0]!
      : {
          date: list[0]!.date,
          kind: list[0]!.kind,
          label: words.tr(`group.${list[0]!.kind}`, {
            count: list.length,
            labels: list.map((e) => e.label).join(listSep(words.locale)),
          }),
          detail: list.map((e) => e.detail).join(" "),
        },
  );
}

/** A component with no price series to read against: its own reason, or the series'. */
function absentFor(key: ComponentKey, input: MarketInputs, words: Words): AbsentComponent {
  const { tr } = words;
  const w = windowEnding(input.today);
  const currency = input.bookings?.currency ?? "EUR";
  const c =
    key === "no_shows"
      ? noShows(input.bookings, w, words)
      : key === "late_cancellations"
        ? lateCancellations(input.bookings, w, words)
        : key === "empty_capacity"
          ? emptyCapacity(input.bookings, input.capacity, w, words)
          : key === "losing_ads"
            ? losingAds(
                input.campaigns,
                windowEnding(input.today, OPPORTUNITY.ads_window_days),
                currency,
                words,
              )
            : key === "revenue_dips"
              ? revenueDips(null, w, undefined, words)
              : null;
  if (c && c.status === "absent") return c;
  return absent(
    key,
    COMPONENT_KIND[key] === "flow"
      ? tr("reason.noRevenueSeries")
      : key === "slow_stock"
        ? tr("reason.noStock")
        : tr("reason.nothingWaiting"),
  );
}

/* ── the text alternative ── */

/** "3 Oct" — the axis and the readout's date; in another language, its own (L-1). */
export function shortDate(day: string, locale: AppLocale = "en"): string {
  if (locale !== "en") return dayMonth(day, locale);
  const d = new Date(`${day}T00:00:00Z`);
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${m[d.getUTCMonth()]}`;
}

/**
 * A candle's period: "3 Oct", "Week of 3 Oct", "October 2026". L-3b: in
 * the reader's language, its words from the "charts.market" catalogue
 * (English by default).
 */
export function periodLabel(
  c: Candle,
  bucket: Bucket,
  locale: AppLocale = "en",
  tr: Tr = englishTr("charts.market"),
): string {
  if (bucket === "day") return shortDate(c.start, locale);
  if (bucket === "week") return tr("weekOf", { day: shortDate(c.start, locale) });
  if (locale !== "en") return monthYear(c.start, locale);
  const d = new Date(`${c.start}T00:00:00Z`);
  return d.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * The chart's figures: whole major units (a candle's day is never a cents
 * question) — the decimals dropped, as English always has. In another
 * language, the same whole units written its own way (L-3b).
 */
export function dayMoney(minor: number, currency: string, locale: AppLocale = "en"): string {
  if (locale !== "en") {
    const major = Math.trunc(Math.round(minor) / 10 ** minorUnitExponent(currency));
    return intlMoney(major === 0 ? 0 : major, currency.toUpperCase(), 0, locale);
  }
  return moneyText(Math.round(minor), currency).replace(/\.\d+$/, "");
}

/** The volume pane's word ("orders"), in the reader's language when SYB knows it. */
export function volumeWord(word: string, tr: Tr = englishTr("charts.market")): string {
  return VOLUME_WORDS.has(word) ? tr(`volumeWord.${word}`) : word;
}

/** The volume words the chart profiles use (lib/charts/profiles), each a catalogue key. */
export const VOLUME_WORDS: ReadonlySet<string> = new Set(["orders", "appointments", "visits"]);

/** The chart's title in a sentence: the model's own in English (its noun table is English's), the catalogue's elsewhere. */
function titleIn(model: DrawnModel, locale: AppLocale, market: Tr): string {
  return locale === "en" ? model.title : market("title");
}

/**
 * One sentence: what the chart shows and its main fact. L-4b: in `words`
 * (built on the client from the candles it buckets); `market` is the
 * "charts.market" catalogue, for the title outside English.
 */
export function chartSummary(
  model: DrawnModel,
  candles: readonly Candle[],
  bucket: Bucket,
  words: Words = englishChartWords(),
  market: Tr = englishTr("charts.market"),
): string {
  const { tr, locale } = words;
  const title = titleIn(model, locale, market);
  const last = candles.at(-1);
  if (!last) return tr("summary.nothing", { title });
  const main = tr(`summary.${bucket}`, {
    title,
    count: candles.length,
    price: priceCode(model.price.metric),
    noun: model.price.noun,
    source: model.price.source,
    from: shortDate(candles[0]!.first, locale),
    to: shortDate(last.last, locale),
    move: last.close_minor >= last.open_minor ? "up" : "down",
    close: dayMoney(last.close_minor, model.currency, locale),
    headline: model.headline.text,
  });
  return model.events.length > 0
    ? `${main} ${tr("summary.events", { count: model.events.length })}`
    : main;
}

export interface ChartTable {
  caption: string;
  head: string[];
  rows: string[][];
}

/** The visually-hidden table of every plotted value, one row per candle. */
export function chartTable(
  model: DrawnModel,
  candles: readonly Candle[],
  bucket: Bucket,
  locale: AppLocale = "en",
  tr: Tr = englishTr("charts.market"),
  words: Words = englishChartWords(),
): ChartTable {
  // L-3b: the head and the cells' words in the reader's language; L-4b: the caption, a sentence built from data, in `words`.
  const cur = model.currency;
  const range = (low_minor: number, high_minor: number) =>
    rangeWhole({ low_minor, high_minor, currency: cur }, locale);
  const head = [
    tr(`table.${bucket}`),
    tr("table.open", { currency: cur }),
    tr("table.high", { currency: cur }),
    tr("table.low", { currency: cur }),
    tr("table.close", { currency: cur }),
    ...(model.volume ? [capitaliseIn(volumeWord(model.volume.word, tr), locale)] : []),
    tr("table.slipped", { currency: cur }),
    tr("table.kept", { currency: cur }),
  ];
  const rows = candles.map((c) => [
    periodLabel(c, bucket, locale, tr),
    dayMoney(c.open_minor, cur, locale),
    dayMoney(c.high_minor, cur, locale),
    dayMoney(c.low_minor, cur, locale),
    dayMoney(c.close_minor, cur, locale),
    ...(model.volume
      ? [c.volume === null ? tr("table.notMeasured") : num(c.volume, 0, locale)]
      : []),
    c.slip_high_minor > 0 ? range(c.slip_low_minor, c.slip_high_minor) : tr("table.none"),
    c.slip_high_minor > 0 ? range(c.kept_low_minor, c.kept_high_minor) : "-",
  ]);
  return {
    caption: words.tr(`caption.${bucket}`, {
      title: titleIn(model, locale, tr),
      price: priceCode(model.price.metric),
      noun: model.price.noun,
    }),
    head,
    rows,
  };
}
