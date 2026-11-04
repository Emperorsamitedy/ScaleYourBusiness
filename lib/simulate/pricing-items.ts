// What-if pricing's items — idea 43. Pure: the products and services the
// owner can reprice, read from a profile snapshot and a booking
// business's own appointments, each figure with its basis and source. No
// database here; lib/simulate/pricing-inputs.ts reads the rows.

import type { Basis } from "../../components/report/basis";
import { basisOf } from "../../components/report/basis";
import { displaySourceKind } from "../connectors/measured";
import { enumCode } from "../core/enum-value";
import type { Field } from "../core/field";
import type { SnapshotView } from "../profile/snapshot";
import type { Asks, CountFact, MoneyFact, PriceItemRaw, PricingInputs } from "./pricing";
import { PRICING } from "./pricing";
import type { SimText } from "./words";
import { englishSimText, int, isoDay, section } from "./words";

/** Where each missing input is asked (ux: a gap links to its question, never a guess). */
export const ASK = {
  /** Bank 3.1: the offers list — price, cost to deliver, units a month. */
  offers: "/intake?ask=3.1",
  /** Bank 1.4.2.3b: appointments a week. */
  capacity: "/intake?ask=1.4.2.3b",
  /** The bookings import and Square live on Connections. */
  bookings: "/connections",
} as const;

const OFFER_ASKS: Asks = {
  price: ASK.offers,
  unit_cost: ASK.offers,
  volume: ASK.offers,
  capacity: null,
};

const VALUE_BEARING = new Set(["answered", "inferred"]);

function basisOfField(f: Field<unknown>): Basis | null {
  return basisOf({
    status: f.status,
    source_kind: displaySourceKind(f.source),
    note: f.note,
    confidence: Number(f.confidence),
  });
}

/** Where a fact came from, in words, by its basis. The fact's own note is kept as written. */
function sourceWords(f: Field<unknown>, basis: Basis, w: SimText): string {
  const t = section(w, "items");
  if (basis === "OBSERVED") return f.note ?? t("observed");
  if (basis === "ESTIMATED") return t("estimated");
  if (basis === "DERIVED") return f.note ?? t("derived");
  return t("told");
}

function moneyFact(f: Field<unknown> | undefined, w: SimText): MoneyFact | null {
  if (!f || !VALUE_BEARING.has(f.status) || f.value === null) return null;
  const m = f.value as { amount_minor?: unknown; currency?: unknown };
  if (!Number.isSafeInteger(m.amount_minor) || typeof m.currency !== "string") return null;
  const basis = basisOfField(f);
  if (!basis) return null;
  return {
    amount_minor: m.amount_minor as number,
    currency: m.currency.toUpperCase(),
    basis,
    source: sourceWords(f, basis, w),
  };
}

function countFact(f: Field<unknown> | undefined, w: SimText): CountFact | null {
  if (!f || !VALUE_BEARING.has(f.status) || f.value === null) return null;
  const v = typeof f.value === "number" ? f.value : Number(f.value);
  if (!Number.isFinite(v) || v < 0) return null;
  const basis = basisOfField(f);
  if (!basis) return null;
  return { value: v, basis, source: sourceWords(f, basis, w) };
}

/** Pure: the priced items from a profile snapshot — one per offer that isn't discontinued. */
export function offerItems(view: SnapshotView, w: SimText = englishSimText()): PriceItemRaw[] {
  const out: PriceItemRaw[] = [];
  for (const e of view.entities.filter((x) => x.spine === "offers")) {
    const fact = (k: string) => view.facts.get(`offers.${e.id}.${k}`);
    if (enumCode(fact("lifecycle")?.value) === "discontinued") continue;
    const nameValue = fact("name")?.value;
    const name =
      typeof nameValue === "string" && nameValue.trim() !== ""
        ? nameValue
        : section(w, "items")("unnamed");
    const price = moneyFact(fact("price"), w);
    const cost = moneyFact(fact("cost_to_deliver"), w);
    out.push({
      key: `offer:${e.id}`,
      kind: "offer",
      name,
      currency: price?.currency ?? cost?.currency ?? "",
      price,
      unit_cost: cost,
      volume: countFact(fact("volume_period"), w),
      capacity: null,
      asks: OFFER_ASKS,
    });
  }
  return out;
}

/** Pure: per-order cost items — shown beside the arithmetic, never counted in a unit's cost. */
export function perOrderCosts(
  view: SnapshotView,
  w: SimText = englishSimText(),
): PricingInputs["per_order_costs"] {
  const out: PricingInputs["per_order_costs"] = [];
  for (const e of view.entities.filter((x) => x.spine === "cost_items")) {
    const fact = (k: string) => view.facts.get(`costs.${e.id}.${k}`);
    if (enumCode(fact("cadence")?.value) !== "per_job") continue;
    const amount = moneyFact(fact("amount"), w);
    if (!amount) continue;
    const label = fact("label")?.value;
    out.push({
      label:
        typeof label === "string" && label.trim() !== ""
          ? label
          : section(w, "items")("perOrderCost"),
      amount_minor: amount.amount_minor,
      currency: amount.currency,
    });
  }
  return out;
}

export interface ServiceRow {
  service: string | null;
  status: string;
  price_minor: number | null;
  currency: string | null;
}

/**
 * Pure: a booking business's services from its own last 28 days — one
 * item per service and currency, the price the average listed price of
 * its completed appointments, the volume its completed count. Offers whose
 * name matches a service lend it their cost to deliver; nothing else.
 */
export function serviceItems(
  args: {
    rows: readonly ServiceRow[];
    from: string;
    to: string;
    source: string;
    capacityPerWeek: number | null;
    offers: readonly PriceItemRaw[];
  },
  w: SimText = englishSimText(),
): PriceItemRaw[] {
  const t = section(w, "items");
  const L = w.locale;
  const from = isoDay(args.from, L);
  const to = isoDay(args.to, L);
  const completed = args.rows.filter((r) => r.status === "completed");
  const taken = completed.length;
  const weeks = PRICING.horizon_days / 7;
  const capacity =
    args.capacityPerWeek !== null && args.capacityPerWeek > 0
      ? {
          slots: args.capacityPerWeek * weeks,
          taken,
          basis: "DERIVED" as const,
          source: t("capacitySource", {
            perWeek: int(args.capacityPerWeek, L),
            weeks: int(weeks, L),
            taken: int(taken, L),
            from,
            to,
          }),
        }
      : null;
  const groups = new Map<string, { name: string; currency: string; prices: number[] }>();
  for (const r of completed) {
    if (r.service === null || r.service.trim() === "" || r.price_minor === null || !r.currency) {
      continue;
    }
    const name = r.service.trim();
    const k = `${name.toLowerCase()}|${r.currency.toUpperCase()}`;
    const g = groups.get(k) ?? { name, currency: r.currency.toUpperCase(), prices: [] };
    g.prices.push(r.price_minor);
    groups.set(k, g);
  }
  const byName = new Map(args.offers.map((o) => [o.name.trim().toLowerCase(), o]));
  return [...groups.values()]
    .sort((a, b) => b.prices.length - a.prices.length || a.name.localeCompare(b.name))
    .map((g) => {
      const n = g.prices.length;
      const avg = Math.round(g.prices.reduce((s, p) => s + p, 0) / n);
      const offer = byName.get(g.name.toLowerCase()) ?? null;
      return {
        key: `service:${g.name.toLowerCase()}:${g.currency}`,
        kind: "service" as const,
        name: g.name,
        currency: g.currency,
        price: {
          amount_minor: avg,
          currency: g.currency,
          basis: "OBSERVED" as const,
          source: t("priceSource", { count: n, n: int(n, L), from, to, source: args.source }),
        },
        unit_cost: offer?.unit_cost ?? null,
        volume: {
          value: n,
          basis: "OBSERVED" as const,
          source: t("volumeSource", { from, to, source: args.source }),
        },
        capacity,
        asks: {
          price: ASK.bookings,
          unit_cost: ASK.offers,
          volume: ASK.bookings,
          capacity: ASK.capacity,
        },
      };
    });
}
