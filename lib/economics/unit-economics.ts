// Unit economics — P1-07..13 / build-sequence steps 40-41.
//
// Arithmetic, never inference. CLAUDE.md's cost rule and the report's
// auditability requirement point the same way: a margin the owner can't
// trace to its inputs is worth less than no margin at all.
//
// Three rules run through everything here:
//
//   1. Every computed figure carries `derived_from` (the field keys it
//      used) and the formula, per data-model rule 6. Confidence is
//      min(inputs) × 0.9 (§8.1) — a derivation is never more certain
//      than its weakest input.
//   2. Missing inputs produce a REFUSAL, not a guess. "I don't know"
//      is a finding; a plausible invented number is a lie.
//   3. Money never blends across currencies. A HUF profile with EUR ad
//      spend refuses to total rather than quietly producing nonsense.
//
// Everything reads a snapshot, so a report's numbers stay reproducible
// long after the profile has moved on.

import { isMeasuredSource } from "../connectors/measured";
import type { StatedVsMeasured } from "../connectors/measured";
import type { Money } from "../core/money";
import { money, multiply, perUnit, scaleMinor, scaleMinorBy, subtract } from "../core/money";
import type { Grade } from "../core/grade";
import { lowestGrade, provenanceGrade, sourceGrade } from "../core/grade";
import type { SnapshotEntity, SnapshotView } from "../profile/snapshot";

/** A number nobody has to take on faith. */
export interface Computed<T> {
  value: T;
  /** The field keys this rests on. */
  derived_from: string[];
  /** Human-readable arithmetic, shown on the report. */
  formula: string;
  /** min(input confidences) × 0.9, per §8.1. */
  confidence: number;
  /** Hard rule 3 (architecture-v2 D4): the lowest grade among the inputs, read from the inputs. */
  grade: Grade;
}

/** Something deliberately not computed, and exactly what is missing. */
export interface Refusal {
  what: string;
  missing: string[];
  why: string;
}

export interface OfferEconomics {
  offer_id: string;
  name: string;
  kind: string | null;
  price: Money;
  cost_to_deliver: Money | null;
  /** Percentage points. Null when the cost side is unknown. */
  margin_pct: Computed<number> | null;
  /** Price − cost: what one sale actually contributes. */
  contribution: Computed<Money> | null;
  /** Units per month, when the owner gave one. */
  volume: number | null;
}

export interface BreakEven {
  units_per_month: number;
  revenue_per_month: Money;
  fixed_costs_per_month: Money;
  contribution_per_unit: Money;
}

export interface StatedVsComputed {
  stated_pct: number;
  computed_pct: number;
  delta_pts: number;
  /** §8.3 — the computed value drives analysis; both are shown. */
  used_for_analysis: "computed";
}

export interface EconomicsResult {
  currency: string;
  offers: OfferEconomics[];
  blended_margin_pct: Computed<number> | null;
  break_even: Computed<BreakEven> | null;
  average_order_value: Computed<Money> | null;
  cost_per_acquisition: Computed<Money> | null;
  /** P2-21. Absent on reports generated before Phase 2 Session D. */
  return_on_ad_spend?: Computed<number> | null;
  fixed_costs_monthly: Computed<Money> | null;
  stated_vs_computed_margin: StatedVsComputed | null;
  refusals: Refusal[];
  /**
   * Rule 11 (P2-11): measured facts that superseded something the owner
   * said, both sides shown. Added by the report service, because finding
   * the owner's figure needs history a snapshot view doesn't carry.
   * Absent on reports generated before Phase 2.
   */
  stated_vs_measured?: StatedVsMeasured[];
}

/* ── reading a snapshot ── */

interface FactLike {
  value: unknown;
  status: string;
  confidence: number;
  /** The fact's SourceRef — its §6.1 grade comes from here. */
  source: unknown;
}

function fact(view: SnapshotView, key: string): FactLike | null {
  const f = view.facts.get(key);
  if (!f || f.value === null) return null;
  // Owner answers, plus connector measurements (P2-10). Other inferred
  // values stay out: this engine won't build arithmetic on its own
  // derivations, but a sum of Stripe payments is an input, not a guess.
  const usable = f.status === "answered" || (f.status === "inferred" && isMeasuredSource(f.source));
  if (!usable) return null;
  return { value: f.value, status: f.status, confidence: Number(f.confidence), source: f.source };
}

function asMoney(v: unknown): Money | null {
  if (v === null || typeof v !== "object") return null;
  const m = v as { amount_minor?: unknown; currency?: unknown };
  return typeof m.amount_minor === "number" && typeof m.currency === "string"
    ? { amount_minor: m.amount_minor, currency: m.currency }
    : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asCode(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v !== null && typeof v === "object" && typeof (v as { code?: unknown }).code === "string") {
    return (v as { code: string }).code;
  }
  return null;
}

/** §8.1: an inference is never more certain than its weakest input. */
function derivedConfidence(inputs: readonly (FactLike | null)[]): number {
  const known = inputs.filter((i): i is FactLike => i !== null);
  if (known.length === 0) return 0;
  return Math.round(Math.min(...known.map((i) => i.confidence)) * 0.9 * 1000) / 1000;
}

/**
 * Hard rule 3 over §6.1: the inputs' lowest provenance grade. Arithmetic
 * on measured inputs keeps their grade; one owner-stated input makes the
 * figure D. No known input is the floor grade, never a guess.
 */
function inputsGrade(inputs: readonly (FactLike | null)[]): Grade {
  const known = inputs.filter((i): i is FactLike => i !== null);
  if (known.length === 0) return "D";
  return provenanceGrade({ source: "derived", inputs: known.map((i) => sourceGrade(i.source)) });
}

/** Sub-facts of one entity: "offers.<id>.price" → { price: … }. */
function entityFacts(view: SnapshotView, spine: string, id: string): Map<string, FactLike> {
  const out = new Map<string, FactLike>();
  const prefix = `${spine}.${id}.`;
  for (const [key, f] of view.facts) {
    if (!key.startsWith(prefix)) continue;
    // Owner answers, plus connector measurements such as a store's units
    // sold per matched product (P2-16), for the same reason as fact().
    const usable =
      f.status === "answered" || (f.status === "inferred" && isMeasuredSource(f.source));
    if (!usable || f.value === null) continue;
    out.set(key.slice(prefix.length), {
      value: f.value,
      status: f.status,
      confidence: Number(f.confidence),
      source: f.source,
    });
  }
  return out;
}

/**
 * Minor units ÷ a count that may carry decimals (units sold, orders, new
 * customers): a whole count divides exactly; a fractional one is taken to
 * thousandths, so the division is still one exact integer division (hard rule 1).
 */
export function perCount(amountMinor: number, count: number): number {
  if (Number.isInteger(count)) return perUnit(amountMinor, count);
  return scaleMinorBy(amountMinor, 1000, Math.max(1, Math.round(count * 1000)));
}

const CADENCE_DIVISOR: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

/* ── the computations ── */

/** P1-07: margin and contribution per offer, currency-safe. */
function offerEconomics(view: SnapshotView, entities: SnapshotEntity[]): OfferEconomics[] {
  const out: OfferEconomics[] = [];
  for (const e of entities.filter((x) => x.spine === "offers")) {
    const f = entityFacts(view, "offers", e.id);
    const priceFact = f.get("price") ?? null;
    const price = asMoney(priceFact?.value);
    if (!price) continue; // an offer without a price is not economics, it's a gap

    const costFact = f.get("cost_to_deliver") ?? null;
    const cost = asMoney(costFact?.value);
    const nameFact = f.get("name");
    const name = typeof nameFact?.value === "string" ? nameFact.value : "Unnamed offer";
    const volume = asNumber(f.get("volume_period")?.value ?? null);

    let marginPct: Computed<number> | null = null;
    let contribution: Computed<Money> | null = null;

    if (cost && price.amount_minor > 0) {
      // subtract() throws on a currency mismatch — that refusal is the point.
      if (cost.currency !== price.currency) {
        out.push({
          offer_id: e.id,
          name,
          kind: e.kind,
          price,
          cost_to_deliver: cost,
          margin_pct: null,
          contribution: null,
          volume,
        });
        continue;
      }
      const contrib = subtract(price, cost);
      // Per mille of the price, exact; the margin keeps one decimal of a percent.
      const perMille = perUnit(contrib.amount_minor * 1000, price.amount_minor);
      const conf = derivedConfidence([priceFact, costFact]);
      const grade = inputsGrade([priceFact, costFact]);
      const from = [`offers.${e.id}.price`, `offers.${e.id}.cost_to_deliver`];
      marginPct = {
        value: perMille / 10,
        derived_from: from,
        formula: "(price − cost_to_deliver) ÷ price × 100",
        confidence: conf,
        grade,
      };
      contribution = {
        value: contrib,
        derived_from: from,
        formula: "price − cost_to_deliver",
        confidence: conf,
        grade,
      };
    }

    out.push({
      offer_id: e.id,
      name,
      kind: e.kind,
      price,
      cost_to_deliver: cost,
      margin_pct: marginPct,
      contribution,
      volume,
    });
  }
  return out.sort((a, b) => (b.margin_pct?.value ?? -1) - (a.margin_pct?.value ?? -1));
}

/** P1-08: blended margin, volume-weighted where volumes exist. */
function blendedMargin(offers: OfferEconomics[]): Computed<number> | null {
  const priced = offers.filter((o) => o.margin_pct !== null);
  if (priced.length === 0) return null;

  const weighted = priced.filter((o) => o.volume !== null && o.volume > 0);
  const use = weighted.length > 0 ? weighted : priced;
  const totalWeight =
    weighted.length > 0 ? use.reduce((n, o) => n + (o.volume ?? 0), 0) : use.length;
  const sum = use.reduce(
    (n, o) => n + o.margin_pct!.value * (weighted.length > 0 ? (o.volume ?? 0) : 1),
    0,
  );

  return {
    value: Math.round((sum / totalWeight) * 10) / 10,
    derived_from: use.flatMap((o) => o.margin_pct!.derived_from),
    formula:
      weighted.length > 0
        ? "Σ(offer margin × units sold) ÷ Σ(units sold)"
        : "mean(offer margins): no volumes recorded, so each offer counts once",
    confidence: Math.min(...use.map((o) => o.margin_pct!.confidence)),
    grade: lowestGrade(use.map((o) => o.margin_pct!.grade)),
  };
}

/** Fixed monthly costs, normalised from their cadence. */
function fixedMonthly(
  view: SnapshotView,
  entities: SnapshotEntity[],
  currency: string,
  refusals: Refusal[],
): Computed<Money> | null {
  const fixed = entities.filter((e) => e.spine === "cost_items" && e.kind === "fixed");
  if (fixed.length === 0) return null;

  // Totalled in twelfths of a month's minor units, so every cadence divides exactly
  // and the one rounding happens at the end (hard rule 1).
  let totalTwelfths = 0;
  const from: string[] = [];
  const inputs: FactLike[] = [];
  const skipped: string[] = [];

  for (const e of fixed) {
    const f = entityFacts(view, "costs", e.id);
    const amountFact = f.get("amount") ?? null;
    const amount = asMoney(amountFact?.value);
    const cadence = asCode(f.get("cadence")?.value ?? null);
    if (!amount || !cadence) {
      skipped.push(`costs.${e.id}`);
      continue;
    }
    if (amount.currency !== currency) {
      refusals.push({
        what: "fixed costs per month",
        missing: [`costs.${e.id}.amount`],
        why: `recorded in ${amount.currency}, the profile reports in ${currency}: converting would need an FX rate nobody has given me`,
      });
      return null;
    }
    const divisor = CADENCE_DIVISOR[cadence];
    if (divisor === undefined) {
      // per_unit / per_job depend on volume — they are variable, not fixed.
      skipped.push(`costs.${e.id} (${cadence})`);
      continue;
    }
    const twelfths = 12 / divisor; // 12, 4 or 1: whole
    totalTwelfths += amount.amount_minor * twelfths;
    from.push(`costs.${e.id}.amount`, `costs.${e.id}.cadence`);
    if (amountFact) inputs.push(amountFact);
  }

  if (inputs.length === 0) return null;
  if (skipped.length > 0) {
    refusals.push({
      what: "fixed costs per month (partial)",
      missing: skipped,
      why: "these cost items have no amount, no cadence, or a per-unit cadence that isn't a fixed monthly figure",
    });
  }

  return {
    value: money(perUnit(totalTwelfths, 12), currency),
    derived_from: from,
    formula: "Σ(fixed cost ÷ cadence months)",
    confidence: derivedConfidence(inputs),
    grade: inputsGrade(inputs),
  };
}

/** P1-09: break-even, with the volume assumption stated out loud. */
function breakEven(
  offers: OfferEconomics[],
  fixed: Computed<Money> | null,
  currency: string,
  refusals: Refusal[],
): Computed<BreakEven> | null {
  if (!fixed) {
    refusals.push({
      what: "break-even",
      missing: ["costs.<fixed cost items>"],
      why: "no fixed monthly costs recorded, so there is nothing to cover",
    });
    return null;
  }
  const contributing = offers.filter((o) => o.contribution !== null);
  if (contributing.length === 0) {
    refusals.push({
      what: "break-even",
      missing: ["offers.<id>.cost_to_deliver"],
      why: "no offer has both a price and a cost, so a contribution per sale can't be computed",
    });
    return null;
  }

  const weighted = contributing.filter((o) => o.volume !== null && o.volume > 0);
  const use = weighted.length > 0 ? weighted : contributing;
  const weightOf = (o: OfferEconomics) => (weighted.length > 0 ? (o.volume ?? 0) : 1);
  const totalWeight = use.reduce((n, o) => n + weightOf(o), 0);

  // Σ(contribution × weight) and Σ(price × weight), each line scaled exactly to minor units.
  const contribSum = use.reduce(
    (n, o) => n + scaleMinor(o.contribution!.value.amount_minor, weightOf(o)),
    0,
  );
  if (contribSum <= 0) {
    refusals.push({
      what: "break-even",
      missing: [],
      why: "every sale loses money at these prices: there is no volume that breaks even",
    });
    return null;
  }
  const priceSum = use.reduce((n, o) => n + scaleMinor(o.price.amount_minor, weightOf(o)), 0);

  // fixed ÷ (contribSum ÷ weight) units; their revenue is fixed × priceSum ÷ contribSum, exactly.
  const units = (fixed.value.amount_minor * totalWeight) / contribSum; // not money: a count of units, rounded up below
  return {
    value: {
      units_per_month: Math.ceil(units),
      revenue_per_month: money(
        scaleMinorBy(fixed.value.amount_minor, priceSum, contribSum),
        currency,
      ),
      fixed_costs_per_month: fixed.value,
      contribution_per_unit: money(perCount(contribSum, totalWeight), currency),
    },
    derived_from: [...fixed.derived_from, ...use.flatMap((o) => o.contribution!.derived_from)],
    formula:
      weighted.length > 0
        ? "fixed costs ÷ weighted contribution per unit: assumes the current offer mix holds"
        : "fixed costs ÷ mean contribution per unit: no volumes recorded, so the mix is assumed even",
    confidence: Math.min(fixed.confidence, ...use.map((o) => o.contribution!.confidence)),
    grade: lowestGrade([fixed.grade, ...use.map((o) => o.contribution!.grade)]),
  };
}

/** P1-10: average order value. */
function averageOrderValue(
  view: SnapshotView,
  currency: string,
  refusals: Refusal[],
): Computed<Money> | null {
  const revFact = fact(view, "revenue.monthly_revenue");
  const ordersFact = fact(view, "revenue.order_count_monthly");
  const revenue = asMoney(revFact?.value);
  const orders = asNumber(ordersFact?.value);

  if (!revenue || orders === null || orders <= 0) {
    refusals.push({
      what: "average order value",
      missing: [
        ...(revenue ? [] : ["revenue.monthly_revenue"]),
        ...(orders && orders > 0 ? [] : ["revenue.order_count_monthly"]),
      ],
      why: "both monthly revenue and an order count are needed; I won't estimate either",
    });
    return null;
  }
  if (revenue.currency !== currency) return null;

  return {
    value: money(perCount(revenue.amount_minor, orders), currency),
    derived_from: ["revenue.monthly_revenue", "revenue.order_count_monthly"],
    formula: "monthly revenue ÷ monthly orders",
    confidence: derivedConfidence([revFact, ordersFact]),
    grade: inputsGrade([revFact, ordersFact]),
  };
}

/** P1-11: cost per acquisition — only when every input genuinely exists. */
function costPerAcquisition(
  view: SnapshotView,
  currency: string,
  refusals: Refusal[],
): Computed<Money> | null {
  const spendFact = fact(view, "marketing.monthly_ad_spend");
  const ordersFact = fact(view, "revenue.order_count_monthly");
  const repeatFact = fact(view, "revenue.repeat_customer_rate");

  const spend = asMoney(spendFact?.value);
  const orders = asNumber(ordersFact?.value);
  const repeat = asNumber(repeatFact?.value);

  const missing = [
    ...(spend ? [] : ["marketing.monthly_ad_spend"]),
    ...(orders !== null ? [] : ["revenue.order_count_monthly"]),
    ...(repeat !== null ? [] : ["revenue.repeat_customer_rate"]),
  ];
  if (missing.length > 0) {
    refusals.push({
      what: "cost per acquisition",
      missing,
      why: "without all three I can't separate new customers from returning ones, and a CPA that counts repeat buyers as acquisitions flatters the number",
    });
    return null;
  }
  if (spend!.currency !== currency) {
    refusals.push({
      what: "cost per acquisition",
      missing: ["marketing.monthly_ad_spend"],
      why: `ad spend is in ${spend!.currency} but the profile reports in ${currency}: that needs an FX rate`,
    });
    return null;
  }

  // The bank asks the repeat rate as a percentage, 0–100 (question 4.1d), and
  // every writer stores it so: an owner's answer and the bookings measure
  // alike. Guessing "fraction or percent" from the size read 1 % as 100 %.
  const repeatFraction = repeat! / 100;
  const newCustomers = orders! * (1 - repeatFraction);
  if (newCustomers <= 0) {
    refusals.push({
      what: "cost per acquisition",
      missing: [],
      why: "the repeat rate implies no new customers this month",
    });
    return null;
  }

  return {
    value: money(perCount(spend!.amount_minor, newCustomers), currency),
    derived_from: [
      "marketing.monthly_ad_spend",
      "revenue.order_count_monthly",
      "revenue.repeat_customer_rate",
    ],
    formula: "ad spend ÷ (orders × (1 − repeat rate))",
    confidence: derivedConfidence([spendFact, ordersFact, repeatFact]),
    grade: inputsGrade([spendFact, ordersFact, repeatFact]),
  };
}

/**
 * P2-21: return on ad spend, blended — all monthly revenue over all monthly
 * ad spend, not attributed to particular ads. Computed only when both
 * sides exist; a ratio with a guessed side is a guess.
 */
function returnOnAdSpend(
  view: SnapshotView,
  currency: string,
  refusals: Refusal[],
): Computed<number> | null {
  const revFact = fact(view, "revenue.monthly_revenue");
  const spendFact = fact(view, "marketing.monthly_ad_spend");
  const revenue = asMoney(revFact?.value);
  const spend = asMoney(spendFact?.value);
  const missing = [
    ...(revenue ? [] : ["revenue.monthly_revenue"]),
    ...(spend ? [] : ["marketing.monthly_ad_spend"]),
  ];
  if (missing.length > 0) {
    refusals.push({
      what: "return on ad spend",
      missing,
      why: "monthly revenue and monthly ad spend are both needed; a ratio with a guessed side is a guess",
    });
    return null;
  }
  if (spend!.amount_minor <= 0) {
    refusals.push({
      what: "return on ad spend",
      missing: [],
      why: "ad spend is zero, so there is nothing to return on",
    });
    return null;
  }
  if (revenue!.currency !== currency || spend!.currency !== currency) {
    refusals.push({
      what: "return on ad spend",
      missing: [],
      why: `revenue is in ${revenue!.currency} and ad spend in ${spend!.currency}; the profile reports in ${currency}, and converting needs an FX rate nobody has given me`,
    });
    return null;
  }
  // In hundredths, exact; ROAS is a ratio shown to two decimals.
  const roasHundredths = perUnit(revenue!.amount_minor * 100, spend!.amount_minor);
  return {
    value: roasHundredths / 100,
    derived_from: ["revenue.monthly_revenue", "marketing.monthly_ad_spend"],
    formula:
      "monthly revenue ÷ monthly ad spend (blended: all revenue over all ad spend, not attributed)",
    confidence: derivedConfidence([revFact, spendFact]),
    grade: inputsGrade([revFact, spendFact]),
  };
}

/**
 * P1-13 / §8.3: when the owner's stated margin disagrees with the
 * arithmetic, the computed value drives analysis and BOTH are shown.
 * Neither is overwritten — the contradiction itself is raised by the
 * Session Q validation engine on write, not invented here.
 */
function statedVsComputed(
  view: SnapshotView,
  computed: Computed<number> | null,
): StatedVsComputed | null {
  const statedFact = fact(view, "costs.gross_margin");
  const stated = asNumber(statedFact?.value);
  if (stated === null || !computed) return null;
  return {
    stated_pct: stated,
    computed_pct: computed.value,
    delta_pts: Math.round((computed.value - stated) * 10) / 10,
    used_for_analysis: "computed",
  };
}

/**
 * Everything the report's unit-economics block needs, computed from one
 * snapshot. Nothing here calls a model; nothing here guesses.
 */
export function computeEconomics(view: SnapshotView, currency: string): EconomicsResult {
  const refusals: Refusal[] = [];
  const offers = offerEconomics(view, view.entities);
  const blended = blendedMargin(offers);
  const fixed = fixedMonthly(view, view.entities, currency, refusals);

  if (offers.length === 0) {
    refusals.push({
      what: "offer margins",
      missing: ["offers.<id>.price"],
      why: "no offer has a price recorded yet",
    });
  }
  for (const o of offers) {
    if (o.margin_pct === null) {
      refusals.push({
        what: `margin for ${o.name}`,
        missing: [`offers.${o.offer_id}.cost_to_deliver`],
        why: o.cost_to_deliver
          ? "price and cost are in different currencies"
          : "no cost to deliver recorded, so the margin is unknown rather than assumed",
      });
    }
  }

  return {
    currency,
    offers,
    blended_margin_pct: blended,
    break_even: breakEven(offers, fixed, currency, refusals),
    average_order_value: averageOrderValue(view, currency, refusals),
    cost_per_acquisition: costPerAcquisition(view, currency, refusals),
    return_on_ad_spend: returnOnAdSpend(view, currency, refusals),
    fixed_costs_monthly: fixed,
    stated_vs_computed_margin: statedVsComputed(view, blended),
    refusals,
  };
}

/** Monthly revenue implied by an offer's price × volume — used by the report. */
export function impliedRevenue(offer: OfferEconomics): Money | null {
  if (offer.volume === null) return null;
  return multiply(offer.price, offer.volume);
}
