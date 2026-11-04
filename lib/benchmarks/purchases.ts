// The purchases share, its own line beside the margin — I-44b (decided
// 2026-11-04, owner: "Yes, like for like only"). Pure: no database,
// network, model or clock.
//
// Eurostat's PUR_SHARE_PC is a cell's total purchases of goods and services
// over its turnover (PUR_MEUR ÷ NETTUR_MEUR, one year, in the snapshot since
// I-44.1). It is set beside the business's own cost of sales as a share of
// its sales, worked out only from the inputs the margin already reads:
//
//   · each offer's cost to deliver over its price, at the monthly volumes,
//     every one in the same currency (the revenue's, when there is one), or
//   · 100 % less the gross margin the owner gave (5.3a).
//
// No conversion is ever needed: both sides are shares. Each input keeps its
// basis (rule 2) and the formula is spelled out with the numbers (rule 6).
//
// LIKE FOR LIKE ONLY. The cell is the business's own country and its
// type's own NACE code, at the size class the headcount picked or the
// every-size cell the screen already falls back to, with that fallback's
// note. Never the parent code, and never the EU27_2020 aggregate: when the
// country's cell has no figure, the line says there is no comparison. With
// the cell but without the business's own input, the line shows the
// sector's figure and what it needs, like the other lines.
//
// The words are the "benchmarkPurchases" catalogue through a `Tr`, English
// by default. Nothing here reaches the report or a proposal: the I-44a
// large-gap rule (./gap) stays margin-only.

import { moneyText, num } from "../../components/sheet/num";
import type { AppLocale } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
import type { BenchHead, BenchInputs, BenchLine, Need, OwnInput } from "./compare";
import { BENCH_ASK, pickCell, readingOf } from "./compare";
import type { MappedType } from "./map";
import type { Snapshot } from "./snapshot";

export const PURCHASES_KEY = "purchases_share";
export type PurchasesKey = typeof PURCHASES_KEY;

/** The line's words and the reader's locale: the "benchmarkPurchases" catalogue. */
export interface PurchasesWords {
  tr: Tr;
  locale: AppLocale;
}
const ENGLISH = (): PurchasesWords => ({ tr: englishTr("benchmarkPurchases"), locale: "en" });

export interface OwnPurchases {
  pct: number;
  formula: string;
  derived_from: string[];
  inputs: OwnInput[];
  left_out: string[];
}

/** Pure: the business's cost of sales as a share of its sales, or what it needs. */
export function ownPurchasesShare(
  x: BenchInputs,
  w: PurchasesWords = ENGLISH(),
): OwnPurchases | { needs: Need[] } {
  const { tr, locale } = w;
  const pct = (n: number) => `${num(n, 1, locale)}%`;
  const cur = x.revenue?.currency ?? x.offers.find((o) => o.price)?.price?.currency ?? null;
  const selling = x.offers.filter((o) => o.volume_month && o.volume_month.value > 0);
  const leftOut = selling
    .filter((o) => o.price && o.price.currency !== cur)
    .map((o) => tr("leftOutCurrency", { offer: o.name, currency: o.price!.currency, main: cur! }));
  const sold = selling.filter((o) => o.price && o.price.currency === cur);
  if (cur !== null && sold.length > 0 && sold.every((o) => o.cost && o.cost.currency === cur)) {
    const sales = sold.reduce((n, o) => n + o.price!.amount_minor * o.volume_month!.value, 0);
    const deliver = sold.reduce((n, o) => n + o.cost!.amount_minor * o.volume_month!.value, 0);
    if (sales > 0) {
      const share = Math.round((deliver / sales) * 1000) / 10;
      const salesWords = moneyText(Math.round(sales), cur, locale);
      const deliverWords = moneyText(Math.round(deliver), cur, locale);
      return {
        pct: share,
        formula: tr("formulaOffers", {
          deliver: deliverWords,
          sales: salesWords,
          pct: pct(share),
        }),
        derived_from: sold.flatMap((o) => [
          `${o.key}.price`,
          `${o.key}.cost_to_deliver`,
          `${o.key}.volume_period`,
        ]),
        inputs: [
          {
            label: tr("inputSales"),
            value: salesWords,
            basis: "DERIVED",
            source: tr("sourceOffers", { count: sold.length }),
          },
          {
            label: tr("inputDeliver"),
            value: deliverWords,
            basis: "DERIVED",
            source: tr("sourceOffers", { count: sold.length }),
          },
        ],
        left_out: leftOut,
      };
    }
  }
  const gm = x.gross_margin;
  if (gm && gm.value >= 0 && gm.value <= 100) {
    const share = Math.round((100 - gm.value) * 10) / 10;
    return {
      pct: share,
      formula: tr("formulaGrossMargin", { whole: pct(100), gm: pct(gm.value), pct: pct(share) }),
      derived_from: ["costs.gross_margin"],
      inputs: [
        { label: tr("inputGrossMargin"), value: pct(gm.value), basis: gm.basis, source: gm.source },
      ],
      left_out: [],
    };
  }
  return {
    needs: [
      { what: tr("needOffers"), href: BENCH_ASK.offers },
      { what: tr("needGrossMargin"), href: BENCH_ASK.gross_margin },
    ],
  };
}

/**
 * Pure: the purchases line. The cell is the country's own at the type's own
 * code (no parent, never the EU aggregate); the size as the other lines.
 */
export function purchasesLine(
  x: BenchInputs,
  s: Snapshot,
  type: MappedType,
  head: BenchHead,
  sizes: readonly string[],
  w: PurchasesWords = ENGLISH(),
): BenchLine {
  const { tr, locale } = w;
  const pct = (n: number) => `${num(n, 1, locale)}%`;
  const common = { key: PURCHASES_KEY, title: tr("title"), gap_note: tr("gapNote") } as const;
  // Like for like: the type's own code only, in the business's own country.
  const pick = pickCell(s, head.geo, { ...type, parent: null }, sizes, "PUR_SHARE_PC");
  if (!pick || pick.cell.geo !== head.geo || pick.cell.nace !== head.nace) {
    return {
      ...common,
      status: "refused",
      why: tr("noCell", { group: head.group, country: head.country }),
    };
  }
  const bench = pick.value.value;
  const own = ownPurchasesShare(x, w);
  if ("needs" in own) {
    return {
      ...common,
      status: "missing",
      why:
        tr("missing", { bench: pct(bench), cell: pick.cell.words }) +
        (pick.cell.fallback ? ` ${pick.cell.fallback.trim()}` : ""),
      needs: own.needs,
    };
  }
  const reading = readingOf(own.pct, bench);
  const diff = Math.round((own.pct - bench) * 10) / 10;
  const side = diff >= 0 ? "Above" : "Below";
  const gapKey = reading === "about the same" ? `gapSame${side}` : `gap${side}`;
  return {
    ...common,
    status: "compared",
    unit: "percent",
    own: own.pct,
    bench,
    currency: null,
    own_words: pct(own.pct),
    bench_words: pct(bench),
    reading,
    gap_words: tr(gapKey, { points: Math.abs(diff) }),
    formula: own.formula,
    derived_from: own.derived_from,
    inputs: own.inputs,
    left_out: own.left_out,
    needs: [],
    cell: pick.cell,
    conversion: null,
  };
}
