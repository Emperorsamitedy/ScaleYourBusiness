// The illustrative store the landing page's walkthrough shows — a
// FICTIONAL store, labelled as one wherever it renders ("Demo with an
// illustrative store"). The figures are the owner's landing design
// (2026-10-17). sample-diagnosis.test.ts holds every flag to its value,
// range and act-now line, so the sample never shows a flag the product's
// own grammar would not print.
//
// Money is integer minor units + currency (CLAUDE.md rule 1).

/** The short worded flag the walkthrough's report prints. */
export type SampleFlag = "ACT" | "HIGH" | "LOW" | "OK";

export interface SampleMarker {
  measure: string;
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

export const SAMPLE_CURRENCY = "EUR";

/** Step 4 of the walkthrough: "Every leak, priced." */
export const SAMPLE_MARKERS: readonly SampleMarker[] = [
  {
    measure: "Checkout conversion",
    scale: [0, 5],
    range: [2.1, 3.4],
    act_at: 1.6,
    value: 1.4,
    flag: "ACT",
    leak_minor: 112_000,
  },
  {
    measure: "Margin after shipping",
    scale: [20, 70],
    range: [45, 60],
    act_at: 40,
    value: 38,
    flag: "ACT",
    leak_minor: 64_000,
  },
  {
    measure: "Return rate",
    scale: [0, 16],
    range: [4, 8],
    act_at: 12,
    value: 9.8,
    flag: "HIGH",
    leak_minor: 21_000,
  },
  {
    measure: "Email & SMS share",
    scale: [0, 40],
    range: [18, 30],
    act_at: 5,
    value: 6,
    flag: "LOW",
    leak_minor: 17_000,
  },
  {
    measure: "Repeat customers",
    scale: [0, 50],
    range: [22, 35],
    act_at: 12,
    value: 31,
    flag: "OK",
    leak_minor: null,
  },
];

/** "Leak / month" in step 4 — a range, never a point. */
export const SAMPLE_LEAK = { low_minor: 214_000, high_minor: 338_000 } as const;

/** Step 5: the proposal's expected effect, per month. */
export const SAMPLE_PROPOSAL = {
  title: "Fix the mobile checkout step that loses buyers",
  expected_low_minor: 78_000,
  expected_high_minor: 142_000,
} as const;

/** Step 6: what the approved fix measured. */
export const SAMPLE_OUTCOME = {
  recovered_minor: 112_000,
  conversion_before: 1.4,
  conversion_after: 2.2,
} as const;

/** Step 2: the record beside the question. */
export const SAMPLE_RECORD = {
  question: "Roughly what does shipping cost you per order?",
  options: ["< €6", "€6–9", "€9–12", "€12+"],
  /** The option the cursor picks. */
  picked: 2,
  fact: "Shipping €9–€12",
  orders_28d: 612,
  avg_order_minor: 6_740,
} as const;
