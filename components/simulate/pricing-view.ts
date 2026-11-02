// Pure helpers for the what-if pricing screen (idea 43): the words and
// picks the screen shows, testable without a browser. The arithmetic is
// lib/simulate/pricing.ts; this only words it.

import { minorUnitExponent } from "../../lib/core/money";
import type {
  BreakEven,
  PriceChange,
  PriceItemRaw,
  PricingInputs,
} from "../../lib/simulate/pricing";
import { PRICING, changeKey } from "../../lib/simulate/pricing";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { moneyText, num } from "../sheet/num";
import type { SimWords } from "./view";
import { ENGLISH_SIM, sharePct } from "./view";

// L-3b (TASKS-LANGUAGES.md): the words are "simulate.pricing" through an
// optional translator, English by default; figures in the reader's locale.
// A product's unit is "sales", a service's "bookings" — the catalogue
// chooses by the item's kind, so each language can inflect its own noun.

const P =
  (tr: Tr): Tr =>
  (key, values) =>
    tr(`pricing.${key}`, values);

/** "12.3%" from a fraction; in another language, its own ("12,3 %"). */
export function pctOne(share: number, locale: AppLocale = "en"): string {
  if (locale === "en") return `${num(share * 100, 1)}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(share);
}

/** "every 28 days" / "a month": the period a volume covers, in the reader's words. */
export function periodText(item: Pick<PriceItemRaw, "kind">, tr: Tr = ENGLISH_SIM().tr): string {
  return P(tr)("period", { kind: item.kind, days: PRICING.horizon_days });
}

/** Pure: the item the screen opens on — the most complete one, the first listed among equals. */
export function defaultItem(x: PricingInputs): PriceItemRaw | null {
  const score = (i: PriceItemRaw) =>
    (i.price ? 4 : 0) + (i.volume ? 2 : 0) + (i.unit_cost?.currency === i.currency ? 1 : 0);
  let best: PriceItemRaw | null = null;
  for (const i of x.items) if (best === null || score(i) > score(best)) best = i;
  return best;
}

/** The changes the screen opens on. */
export function defaultChanges(): PriceChange[] {
  return PRICING.default_steps.map((share) => ({ kind: "share", share }));
}

/** Pure: add or remove a step, holding the side by side to its maximum. */
export function toggleChange(picks: readonly PriceChange[], c: PriceChange): PriceChange[] {
  const key = changeKey(c);
  if (picks.some((p) => changeKey(p) === key)) return picks.filter((p) => changeKey(p) !== key);
  if (picks.length >= PRICING.max_changes) return [...picks];
  return [...picks, c];
}

/** "+10%" / "−5%" for a step button. */
export function stepLabel(share: number, locale: AppLocale = "en"): string {
  return sharePct(share, locale, true);
}

/** Pure: "36.50" in the item's major units → integer minor units, or null. */
export function exactToMinor(text: string, currency: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const minor = Math.round(Number(t) * 10 ** minorUnitExponent(currency));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

export interface BreakEvenView {
  /** The cell's figure: "Lose fewer than 44". */
  figure: string;
  /** The line under it: "12.3% of ~350", "at least — no cost counted". */
  sub: string;
  flag: "MISSING" | "NEVER" | null;
}

/** Pure: the break-even as a side-by-side cell. A gap is a flag, never a number. */
export function breakEvenView(
  be: BreakEven,
  item: PriceItemRaw,
  w: SimWords = ENGLISH_SIM(),
): BreakEvenView {
  const t = P(w.tr);
  const { locale } = w;
  const kind = item.kind;
  const pct = (s: number) => pctOne(s, locale);
  const of = (share: string, plus: boolean) =>
    item.volume
      ? t(plus ? "be.plusOfVolume" : "be.ofVolume", {
          share,
          volume: num(item.volume.value, 0, locale),
        })
      : t(plus ? "be.plusOfSales" : "be.ofSales", { share });
  const withNote = (sub: string, note: string | null) => (note ? `${sub} · ${note}` : sub);
  switch (be.status) {
    case "lose": {
      const n = be.units === null ? null : Math.max(1, Math.ceil(be.units - 1e-9));
      return {
        figure:
          n === null
            ? t("be.loseShare", { share: pct(be.share) })
            : t("be.loseCount", { count: num(n, 0, locale) }),
        sub: withNote(
          n === null ? t("be.noun", { kind }) : of(pct(be.share), false),
          be.floor ? t("be.atLeast") : null,
        ),
        flag: null,
      };
    }
    case "win": {
      const n = be.units === null ? null : Math.floor(be.units + 1e-9);
      const full = be.room !== null && be.units !== null && be.units >= be.room;
      return {
        figure:
          n === null
            ? t("be.winShare", { share: pct(be.share) })
            : t("be.winCount", { count: num(n, 0, locale) }),
        sub: withNote(
          n === null ? t("be.moreNoun", { kind }) : of(pct(be.share), true),
          full ? t("be.room", { count: num(be.room!, 0, locale) }) : null,
        ),
        flag: null,
      };
    }
    case "never":
      return { figure: t("be.never"), sub: t("be.neverSub"), flag: "NEVER" };
    case "missing":
      return { figure: "—", sub: be.needs.map((n) => n.what).join("; "), flag: "MISSING" };
  }
}

/** Pure: the item's line in the picker — what it costs, sells and is priced at. */
export function itemLine(i: PriceItemRaw, w: SimWords = ENGLISH_SIM()): string {
  const t = P(w.tr);
  const { locale } = w;
  const parts: string[] = [];
  parts.push(i.price ? moneyText(i.price.amount_minor, i.currency, locale) : t("item.noPrice"));
  parts.push(
    i.volume
      ? t("item.volume", {
          volume: num(i.volume.value, 0, locale),
          kind: i.kind,
          days: PRICING.horizon_days,
        })
      : t("item.volumeUnknown", { kind: i.kind }),
  );
  parts.push(
    i.unit_cost && i.unit_cost.currency === i.currency
      ? t("item.cost", { cost: moneyText(i.unit_cost.amount_minor, i.currency, locale) })
      : t("item.costUnknown"),
  );
  return parts.join(" · ");
}

/** Pure: the per-order costs in one sentence, or null — shown, never counted. */
export function perOrderLine(
  x: PricingInputs,
  item: PriceItemRaw | null,
  w: SimWords = ENGLISH_SIM(),
): string | null {
  if (!item || item.kind !== "offer") return null;
  const same = x.per_order_costs.filter((c) => c.currency === item.currency);
  if (same.length === 0) return null;
  const list = same
    .map((c) => `${c.label} (${moneyText(c.amount_minor, c.currency, w.locale)})`)
    .join(", ");
  return P(w.tr)("perOrder", { list, count: same.length });
}
