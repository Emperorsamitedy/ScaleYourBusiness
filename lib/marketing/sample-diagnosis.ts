// The illustrative businesses the landing page's walkthrough shows — two
// FICTIONAL ones, each labelled as such wherever it renders ("Demo with an
// illustrative store", "Demo with an illustrative salon"):
//
// - the webshop, the owner's landing design (2026-10-17), the default;
// - a hair and beauty salon (2026-10-22), added after customer interviews
//   so a booking business sees itself on the page as clearly as a webshop.
//
// sample-diagnosis.test.ts holds every sample's flags to their value,
// range and act-now line, so neither shows a flag the product's own
// grammar would not print.
//
// Money is integer minor units + currency (CLAUDE.md rule 1).
//
// Honesty note: the salon's till figures name Square, whose connector
// reads payments and locations only. Its no-show and rebooking figures
// are the owner's answers in the interview (no booking-system connector
// exists yet) — which is why its record question asks about no-shows.

/** The short worded flag the walkthrough's report prints. */
export type SampleFlag = "ACT" | "HIGH" | "LOW" | "OK";

export interface SampleMarker {
  measure: string;
  /** What value, scale, range and act_at are counted in. */
  unit: "percent" | "money_minor";
  /** The visible scale of the bar, low to high. */
  scale: readonly [number, number];
  /** Reference range. */
  range: readonly [number, number];
  /** Past here the flag becomes ACT. Not drawn in the walkthrough. */
  act_at: number;
  value: number;
  flag: SampleFlag;
  /** The estimated monthly leak this marker prices, low end; null when in range. */
  leak_minor: number | null;
}

/** One line of the record beside step 2's question. */
export interface SampleRecordRow {
  what: string;
  figure: { count: number } | { money_minor: number } | { words: string };
  /** Where the fact came from: a connector's name, or "you". */
  source: string;
}

export interface DemoSample {
  id: "shop" | "salon";
  /** The demo switch's word for it. */
  label: string;
  /** The fiction label: "Demo with an illustrative {noun}." */
  noun: string;
  currency: string;
  /** Step 1: the read-only source the demo connects, and what it reads. */
  connect: { source: string; reads: string };
  /** Step 2: the record beside the question. */
  record: {
    question: string;
    options: readonly string[];
    /** The option the cursor picks. */
    picked: number;
    fact: string;
    rows: readonly SampleRecordRow[];
  };
  /** Step 4: "Every leak, priced." */
  markers: readonly SampleMarker[];
  /** "Leak / month" in step 4 — a range, never a point. */
  leak: { low_minor: number; high_minor: number };
  /** Step 5: the proposal and its expected effect, per month. */
  proposal: {
    /** The proposal card's area tag: "Proposal · checkout". */
    area: string;
    title: string;
    expected_low_minor: number;
    expected_high_minor: number;
  };
  /** Step 6: what the approved fix measured, on the marker it moved. */
  outcome: {
    recovered_minor: number;
    /** The marker the fix moved; `before` is that marker's value. */
    measure: string;
    /** The legend's word for it: "conversion", "no-show rate". */
    metric: string;
    better: "higher" | "lower";
    before: number;
    after: number;
  };
}

export const SHOP_SAMPLE: DemoSample = {
  id: "shop",
  label: "A webshop",
  noun: "store",
  currency: "EUR",
  connect: { source: "Shopify", reads: "Orders · Products · Customers · Inventory" },
  record: {
    question: "Roughly what does shipping cost you per order?",
    options: ["< €6", "€6–9", "€9–12", "€12+"],
    picked: 2,
    fact: "Shipping €9–€12",
    rows: [
      { what: "Orders, 28 d", figure: { count: 612 }, source: "Shopify" },
      { what: "Avg order", figure: { money_minor: 6_740 }, source: "Shopify" },
      { what: "Fulfilment", figure: { words: "in-house" }, source: "you" },
    ],
  },
  markers: [
    {
      measure: "Checkout conversion",
      unit: "percent",
      scale: [0, 5],
      range: [2.1, 3.4],
      act_at: 1.6,
      value: 1.4,
      flag: "ACT",
      leak_minor: 112_000,
    },
    {
      measure: "Margin after shipping",
      unit: "percent",
      scale: [20, 70],
      range: [45, 60],
      act_at: 40,
      value: 38,
      flag: "ACT",
      leak_minor: 64_000,
    },
    {
      measure: "Return rate",
      unit: "percent",
      scale: [0, 16],
      range: [4, 8],
      act_at: 12,
      value: 9.8,
      flag: "HIGH",
      leak_minor: 21_000,
    },
    {
      measure: "Email & SMS share",
      unit: "percent",
      scale: [0, 40],
      range: [18, 30],
      act_at: 5,
      value: 6,
      flag: "LOW",
      leak_minor: 17_000,
    },
    {
      measure: "Repeat customers",
      unit: "percent",
      scale: [0, 50],
      range: [22, 35],
      act_at: 12,
      value: 31,
      flag: "OK",
      leak_minor: null,
    },
  ],
  leak: { low_minor: 214_000, high_minor: 338_000 },
  proposal: {
    area: "checkout",
    title: "Fix the mobile checkout step that loses buyers",
    expected_low_minor: 78_000,
    expected_high_minor: 142_000,
  },
  outcome: {
    recovered_minor: 112_000,
    measure: "Checkout conversion",
    metric: "conversion",
    better: "higher",
    before: 1.4,
    after: 2.2,
  },
};

export const SALON_SAMPLE: DemoSample = {
  id: "salon",
  label: "A salon",
  noun: "salon",
  currency: "EUR",
  connect: { source: "Square", reads: "Payments · Refunds · Locations" },
  record: {
    question: "Roughly how many booked clients don’t turn up in a week?",
    options: ["0–5", "6–12", "13–20", "20+"],
    picked: 2,
    fact: "No-shows 13–20 a week",
    rows: [
      { what: "Paid visits, 28 d", figure: { count: 532 }, source: "Square" },
      { what: "Avg ticket", figure: { money_minor: 5_770 }, source: "Square" },
      { what: "Deposits", figure: { words: "none" }, source: "you" },
    ],
  },
  markers: [
    {
      measure: "No-show rate",
      unit: "percent",
      scale: [0, 20],
      range: [2, 5],
      act_at: 8,
      value: 11,
      flag: "ACT",
      leak_minor: 118_000,
    },
    {
      measure: "Rebooking rate",
      unit: "percent",
      scale: [0, 100],
      range: [55, 75],
      act_at: 30,
      value: 38,
      flag: "LOW",
      leak_minor: 64_000,
    },
    {
      measure: "Chair utilisation",
      unit: "percent",
      scale: [30, 100],
      range: [70, 85],
      act_at: 50,
      value: 61,
      flag: "LOW",
      leak_minor: 52_000,
    },
    {
      measure: "Retail attach rate",
      unit: "percent",
      scale: [0, 40],
      range: [15, 25],
      act_at: 8,
      value: 6,
      flag: "ACT",
      leak_minor: 26_000,
    },
    {
      measure: "Average ticket",
      unit: "money_minor",
      scale: [3_000, 9_000],
      range: [5_000, 7_000],
      act_at: 4_000,
      value: 5_770,
      flag: "OK",
      leak_minor: null,
    },
  ],
  leak: { low_minor: 260_000, high_minor: 395_000 },
  proposal: {
    area: "bookings",
    title: "Take a deposit on first-time bookings to cut no-shows",
    expected_low_minor: 62_000,
    expected_high_minor: 118_000,
  },
  outcome: {
    recovered_minor: 84_000,
    measure: "No-show rate",
    metric: "no-show rate",
    better: "lower",
    before: 11,
    after: 4.6,
  },
};

/** Both demos, the default first. */
export const DEMO_SAMPLES: readonly DemoSample[] = [SHOP_SAMPLE, SALON_SAMPLE];
