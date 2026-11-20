// What-if pricing's customer-response bands — idea 43.
//
// PLANNING ASSUMPTIONS, NOT MEASUREMENTS. Nothing here was measured on
// this business or any other: each band is a deliberately wide range of
// how strongly customers of a kind of business tend to respond to a price
// change, written down so the projection can say out loud what it
// assumes. The screen prints every band with the word ASSUMED and this
// sentence's meaning; the break-even, which is the headline, rests on none
// of it — only on the owner's own price, cost and volume.
//
// A band reads: for each 1% the price moves, between `low`% and `high`%
// of sales (or bookings) move the other way. A rise loses that share, a
// cut wins it. The same band serves both directions — a planning
// simplification, said in the assumption line too.
//
// Keyed by the market chart's archetypes (lib/charts/profiles.ts), so a
// business type maps to a band by lookup, never a branch (rule 4).
// profiles.test.ts holds every bank business type to an archetype;
// pricing.test.ts holds every archetype to a band here.

import type { ArchetypeKey } from "../charts/profiles";

export interface ResponseBand {
  /** The gentle end: sales moved per 1% of price. */
  low: number;
  /** The strong end. */
  high: number;
  /** Why the band sits where it does, in the owner's words. */
  why: string;
}

export const RESPONSE_BANDS: Readonly<Record<ArchetypeKey, ResponseBand>> = {
  shop: {
    low: 0.8,
    high: 2.0,
    why: "goods a customer can compare and often buy elsewhere tend to answer a price change strongly",
  },
  hospitality: {
    low: 0.5,
    high: 1.5,
    why: "a meal or a night is partly the place and the habit, so customers answer price less than in a shop",
  },
  appointments: {
    low: 0.3,
    high: 1.0,
    why: "clients who book a person they trust tend to stay through a price change; some go",
  },
  services: {
    low: 0.4,
    high: 1.2,
    why: "a service bought on trust answers price less than goods do, but a quote can be compared",
  },
  default: {
    low: 0.5,
    high: 2.0,
    why: "the kind of business isn't on your profile, so the band is the widest I use",
  },
};

/** Where the bands come from, as the assumption line prints it. */
export const BAND_SOURCE =
  "a planning assumption for this kind of business, not a measurement: nobody has measured how your customers answer a price change yet";
