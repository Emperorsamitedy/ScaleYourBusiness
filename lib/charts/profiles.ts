// What the market chart reads for each kind of business — as DATA
// (CLAUDE.md rule 4: no if-chain on a business type anywhere).
//
// Two tables:
//
//   CHART_ARCHETYPES  a handful of ways a business makes its money: which
//                     daily series is the "price" (candidates in order —
//                     the loader takes the first with enough measured
//                     days), which is the "volume" and the word for it,
//                     which opportunity components apply and in what
//                     order, and what to connect when nothing is measured.
//   CHART_PROFILE_OF  every code of the bank's business_type vocabulary →
//                     its archetype. "other" and any code the table doesn't
//                     name read the DEFAULT row, which tries everything.
//
// sells_type refines only the default row (SELLS_ARCHETYPE): a business
// that named no type but sells physical products reads like a shop. It is
// a lookup too, never a branch.
//
// The noun ("your salon", "your shop") is lib/core/business-noun's table;
// this file doesn't repeat it. profiles.test.ts holds every bank code to a
// row and every row to the metric keys and components that exist.

import type { MetricKey } from "../connectors/provider";
import { enumCode } from "../core/enum-value";
import type { ComponentKey } from "./opportunity";

export const ARCHETYPE_KEYS = [
  "shop",
  "hospitality",
  "appointments",
  "services",
  "default",
] as const;
export type ArchetypeKey = (typeof ARCHETYPE_KEYS)[number];

export interface PriceCandidate {
  metric: MetricKey;
  /** The axis title: "Revenue a day", "Booking revenue a day". */
  label: string;
  /** Lower-case, for sentences: "revenue", "booking revenue". */
  noun: string;
}

export interface VolumeCandidate {
  metric: MetricKey;
  /** The pane's word: "orders", "appointments", "visits". */
  word: string;
}

export interface ChartArchetype {
  /** Candidates in order; the first with enough measured days is drawn. */
  price: readonly PriceCandidate[];
  /** Candidates in order; the first measured beside the price is drawn. */
  volume: readonly VolumeCandidate[];
  /** The opportunity components this kind of business is priced on, in order. */
  components: readonly ComponentKey[];
  /** The empty state's invitation: what to connect, in the owner's words. */
  connect: string;
  /** Why this row reads what it reads — for the spec and the reviewer. */
  why: string;
}

const REVENUE: PriceCandidate = {
  metric: "revenue.daily",
  label: "Revenue a day",
  noun: "revenue",
};
const BOOKING_REVENUE: PriceCandidate = {
  metric: "booking_revenue.daily",
  label: "Booking revenue a day",
  noun: "booking revenue",
};
const ORDERS: VolumeCandidate = { metric: "orders.daily", word: "orders" };
const APPOINTMENTS: VolumeCandidate = {
  metric: "appointments_completed.daily",
  word: "appointments",
};
const VISITS: VolumeCandidate = { metric: "sessions.daily", word: "visits" };

export const CHART_ARCHETYPES: Readonly<Record<ArchetypeKey, ChartArchetype>> = {
  shop: {
    price: [REVENUE],
    volume: [ORDERS, VISITS],
    components: ["revenue_dips", "losing_ads", "slow_stock", "on_the_table"],
    connect: "Connect Shopify or WooCommerce, or your till through Square, and I'll draw this",
    why: "A shop's takings are its price; orders are the volume, visits when no orders are measured. Stock ties up cash, so slow stock shows beside the month.",
  },
  hospitality: {
    price: [REVENUE, BOOKING_REVENUE],
    // Till orders, not covers: no source SYB reads measures guests per table.
    volume: [ORDERS, VISITS],
    components: ["revenue_dips", "losing_ads", "on_the_table"],
    connect: "Connect your till through Square, or Stripe, and I'll draw this",
    why: "Takings a day are the price and till orders the volume. Orders are bills, not covers — nothing measured counts guests, so the chart doesn't call them covers.",
  },
  appointments: {
    price: [BOOKING_REVENUE, REVENUE],
    volume: [APPOINTMENTS, ORDERS],
    components: [
      "no_shows",
      "late_cancellations",
      "empty_capacity",
      "revenue_dips",
      "losing_ads",
      "on_the_table",
    ],
    connect: "Import your bookings export or connect Square, and I'll draw this",
    why: "An appointment book is the business: booked revenue is the price, completed appointments the volume, and missed or empty slots are where money slips first.",
  },
  services: {
    price: [REVENUE],
    volume: [ORDERS, VISITS],
    components: ["revenue_dips", "losing_ads", "on_the_table"],
    connect: "Connect Stripe, or the shop or till you take payments through, and I'll draw this",
    why: "Payments taken are the price; each payment is one order.",
  },
  default: {
    price: [REVENUE, BOOKING_REVENUE],
    volume: [ORDERS, APPOINTMENTS, VISITS],
    components: [
      "revenue_dips",
      "no_shows",
      "late_cancellations",
      "empty_capacity",
      "losing_ads",
      "slow_stock",
      "on_the_table",
    ],
    connect: "Connect your shop or till, or Stripe, or import your bookings, and I'll draw this",
    why: "Nothing says what kind of business this is, so the chart tries every series in turn and prices whatever the data supports.",
  },
};

/** Every bank business_type code → its archetype. "other" reads the default row. */
export const CHART_PROFILE_OF: Readonly<Record<string, ArchetypeKey>> = {
  retail_shop: "shop",
  ecommerce_store: "shop",
  food_production: "shop",
  manufacturing: "shop",
  wholesale: "shop",
  agriculture: "shop",
  restaurant: "hospitality",
  cafe: "hospitality",
  bar: "hospitality",
  events: "hospitality",
  tourism_accommodation: "hospitality",
  salon_beauty: "appointments",
  barber: "appointments",
  gym_fitness: "appointments",
  wellness_spa: "appointments",
  clinic_health: "appointments",
  photography_creative: "appointments",
  education_training: "appointments",
  childcare: "appointments",
  construction: "services",
  trades_services: "services",
  cleaning_services: "services",
  automotive: "services",
  professional_services: "services",
  consulting: "services",
  agency_marketing: "services",
  it_services: "services",
  software_saas: "services",
  real_estate: "services",
  logistics: "services",
  transport: "services",
  nonprofit: "services",
  other: "default",
};

/** sells_type code → archetype, read only when the business type gives the default row. */
export const SELLS_ARCHETYPE: Readonly<Record<string, ArchetypeKey>> = {
  physical_products: "shop",
};

/**
 * The archetype for a stored business_type answer (EnumValue, bare code or
 * nothing) and the sells answer (a list of codes or EnumValues).
 */
export function archetypeFor(businessType: unknown, sells: unknown = null): ArchetypeKey {
  const code = enumCode(businessType);
  const byType =
    code !== null && Object.hasOwn(CHART_PROFILE_OF, code) ? CHART_PROFILE_OF[code] : undefined;
  if (byType !== undefined && byType !== "default") return byType;
  const sold = Array.isArray(sells) ? sells.map((s) => enumCode(s)) : [];
  for (const s of sold) {
    if (s !== null && Object.hasOwn(SELLS_ARCHETYPE, s)) return SELLS_ARCHETYPE[s]!;
  }
  return "default";
}

export function chartProfile(businessType: unknown, sells: unknown = null): ChartArchetype {
  return CHART_ARCHETYPES[archetypeFor(businessType, sells)];
}
