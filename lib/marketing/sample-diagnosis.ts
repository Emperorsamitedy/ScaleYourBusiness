// The sample diagnosis on the landing page — a FICTIONAL store, labelled
// as one wherever it renders. The numbers are invented but they are
// arithmetic-consistent: every derived figure below follows from the
// inputs beside it, and sample-diagnosis.test.ts checks that, so the
// sample never shows maths the product itself would refuse to print.
//
// Money is integer minor units + currency (CLAUDE.md rule 1).

/** What produced a fact — never an AI percentage. */
export type Basis = "OBSERVED" | "DERIVED" | "ESTIMATED" | "ASSUMED";

/** The worded flag; colour only tints it. */
export type Flag = "IN RANGE" | "BELOW RANGE" | "ABOVE RANGE" | "ACT NOW" | "NOT PROVIDED";

export interface SampleRow {
  measure: string;
  unit: "%" | "EUR" | "×";
  decimals: number;
  value: number | null;
  /** The same measure over the prior 28 days. */
  prior: number | null;
  /** Reference or goal range, and where it comes from. */
  range: readonly [number, number] | null;
  range_from: "your target" | "category norm" | "what you charge";
  /** Where slight drift becomes ACT NOW. */
  act_at: number | null;
  scale: readonly [number, number];
  flag: Flag;
  basis: Basis;
  source: string;
  observed: string;
}

export interface SampleFinding {
  ref: string;
  flag: Flag;
  title: string;
  detail: string;
  evidence: readonly { fact: string; basis: Basis; source: string }[];
}

export interface RecoveryPart {
  label: string;
  low_minor: number;
  high_minor: number;
  basis: Basis;
  how: string;
}

export const SAMPLE = {
  ref: "D-0417",
  store: "Brackenfold Tea Co.",
  platform: "Shopify",
  currency: "EUR",
  window: { from: "14 Sep 2026", to: "11 Oct 2026", days: 28 },
  issued: "13 Oct 2026",
  orders: 1204,
  revenue_minor: 4_647_440, // 1 204 orders × 38.60 average order value
  summary:
    "Your best seller earns you very little once shipping is paid. One Meta campaign returns less than it costs. Returns are rising, and most cite damaged packaging.",

  rows: [
    {
      measure: "Blended gross margin",
      unit: "%",
      decimals: 1,
      value: 38.4,
      prior: 40.5,
      range: [45, 60],
      range_from: "your target",
      act_at: 35,
      scale: [20, 70],
      flag: "BELOW RANGE",
      basis: "DERIVED",
      source: "14 product prices (Shopify) and costs (you)",
      observed: "11 Oct 2026",
    },
    {
      measure: "Margin · Morning Ritual Breakfast Blend, Loose Leaf, 250 g Resealable Pouch",
      unit: "%",
      decimals: 1,
      value: 12.0,
      prior: 14.5,
      range: [40, 60],
      range_from: "category norm",
      act_at: 25,
      scale: [0, 70],
      flag: "ACT NOW",
      basis: "DERIVED",
      source: "price 14.90 (Shopify) − cost 13.11 (you, estimated)",
      observed: "11 Oct 2026",
    },
    {
      measure: "Return on ad spend · Meta “Autumn Blends — Prospecting”",
      unit: "×",
      decimals: 2,
      value: 0.82,
      prior: 1.1,
      range: [2, 4],
      range_from: "category norm",
      act_at: 1,
      scale: [0, 5],
      flag: "ACT NOW",
      basis: "OBSERVED",
      source: "Meta Ads: 1 517.00 attributed on 1 850.00 spent",
      observed: "11 Oct 2026",
    },
    {
      measure: "Shipping you pay, per order",
      unit: "EUR",
      decimals: 2,
      value: 5.6,
      prior: 5.2,
      range: [0, 4.9],
      range_from: "what you charge",
      act_at: 6.5,
      scale: [0, 9],
      flag: "ABOVE RANGE",
      basis: "OBSERVED",
      source: "Shopify shipping labels, 1 204 orders",
      observed: "11 Oct 2026",
    },
    {
      measure: "Return rate",
      unit: "%",
      decimals: 1,
      value: 6.8,
      prior: 5.9,
      range: [2, 5],
      range_from: "category norm",
      act_at: 9,
      scale: [0, 12],
      flag: "ABOVE RANGE",
      basis: "OBSERVED",
      source: "Shopify refunds, 82 of 1 204 orders",
      observed: "11 Oct 2026",
    },
    {
      measure: "Repeat purchase rate, 90 days",
      unit: "%",
      decimals: 1,
      value: 27.0,
      prior: 25.5,
      range: [20, 35],
      range_from: "category norm",
      act_at: 12,
      scale: [0, 50],
      flag: "IN RANGE",
      basis: "OBSERVED",
      source: "Shopify customers",
      observed: "11 Oct 2026",
    },
    {
      measure: "Average order value",
      unit: "EUR",
      decimals: 2,
      value: 38.6,
      prior: 39.1,
      range: [35, 45],
      range_from: "your target",
      act_at: 30,
      scale: [20, 60],
      flag: "IN RANGE",
      basis: "OBSERVED",
      source: "Shopify orders",
      observed: "11 Oct 2026",
    },
    {
      measure: "Weeks of stock, best seller",
      unit: "%",
      decimals: 0,
      value: null,
      prior: null,
      range: null,
      range_from: "your target",
      act_at: null,
      scale: [0, 1],
      flag: "NOT PROVIDED",
      basis: "ASSUMED",
      source: "not answered yet — question 6.3",
      observed: "—",
    },
  ] satisfies SampleRow[],

  findings: [
    {
      ref: "F1",
      flag: "ACT NOW",
      title: "Your best seller earns €1.09 an order once shipping is paid.",
      detail:
        "Morning Ritual is 41% of your orders at a 12.0% margin: €1.79 on a €14.90 pouch. You pay €5.60 to ship an order and charge €4.90, which takes another €0.70.",
      evidence: [
        { fact: "price 14.90 EUR", basis: "OBSERVED", source: "Shopify · 11 Oct 2026" },
        { fact: "cost 13.11 EUR", basis: "ESTIMATED", source: "you · question 3.4 · 2 Oct 2026" },
        { fact: "494 of 1 204 orders", basis: "OBSERVED", source: "Shopify · 28 d" },
      ],
    },
    {
      ref: "F2",
      flag: "ACT NOW",
      title: "One Meta campaign returns €0.82 for every €1 it spends.",
      detail:
        "“Autumn Blends — Prospecting” spent €1 850.00 in 28 days and Meta attributes €1 517.00 of sales to it. Meta counts some sales that would have happened anyway, so the true return is likely lower.",
      evidence: [
        { fact: "spend 1 850.00 EUR", basis: "OBSERVED", source: "Meta Ads · 28 d" },
        { fact: "attributed 1 517.00 EUR", basis: "OBSERVED", source: "Meta Ads · 28 d" },
      ],
    },
    {
      ref: "F3",
      flag: "ABOVE RANGE",
      title: "Returns rose to 6.8%, and most say the tin arrived dented.",
      detail:
        "82 of 1 204 orders came back, up from 5.9% the 28 days before. 51 of the 82 return notes mention a crushed or dented tin.",
      evidence: [
        { fact: "82 refunds", basis: "OBSERVED", source: "Shopify · 28 d" },
        {
          fact: "51 notes: dented / crushed",
          basis: "DERIVED",
          source: "return reasons, read by keyword",
        },
      ],
    },
  ] satisfies SampleFinding[],

  recovery: [
    {
      label: "F1 · price Morning Ritual at €16.90",
      low_minor: 24_000,
      high_minor: 99_000,
      basis: "ASSUMED",
      how: "+€2.00 on 494 orders a month, keeping 60–100% of them",
    },
    {
      label: "F2 · pause the losing campaign",
      low_minor: 33_000,
      high_minor: 36_000,
      basis: "DERIVED",
      how: "the €333 it lost in 28 days, scaled to a month",
    },
    {
      label: "F3 · sturdier packaging",
      low_minor: 18_000,
      high_minor: 42_000,
      basis: "ASSUMED",
      how: "returns back to 5.0–6.0%, less the extra packaging cost",
    },
  ] satisfies RecoveryPart[],
} as const;

export const RECOVERY_RANGE = {
  low_minor: SAMPLE.recovery.reduce((s, r) => s + r.low_minor, 0),
  high_minor: SAMPLE.recovery.reduce((s, r) => s + r.high_minor, 0),
};
