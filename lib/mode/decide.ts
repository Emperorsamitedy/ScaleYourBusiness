// The mode decision rule — Session H (P1-42), data-model §9.
//
// Deterministic, auditable, not a vibe from a prompt: a pure function
// from named inputs to a mode, so every decision can be replayed from
// its stored inputs and every rule has a passing and a failing test.
//
// The asymmetry is the spec's, stated plainly: a wrongly-instant
// decision can damage a live business; a wrongly-long watch costs a
// few weeks. When uncertain, wait.

export interface ModeDecisionInputs {
  /** identity.stage code, e.g. "idea" | "operating" | "growing". */
  stage: string | null;
  has_revenue: boolean;
  monthly_order_count: number | null;
  months_operating: number | null;
  /** Excluding the owner: team_size 1 means zero employees. */
  employee_count: number;
  has_active_ad_spend: boolean;
  has_customer_support_process: boolean;
  has_existing_automations: boolean;
  /** Mean confidence of responded core fields, 0–1. */
  data_confidence: number;
  /** Overall completeness, 0–1. */
  completeness: number;
}

export interface ModeRuling {
  mode: "instant" | "watching";
  watch_weeks: 4 | 6 | 8 | null;
  /** The inputs that triggered the ruling, as owner-readable lines. */
  reasons: string[];
  reasoning: string;
  confidence: number;
}

export interface DeferredRuling {
  deferred: true;
  completeness: number;
  reasoning: string;
}

/** §9: below this, defer rather than guess (P1-45). */
export const DEFER_BELOW_COMPLETENESS = 0.5;

/** Monthly ad spend (minor units, reporting currency) that forces 8 weeks. */
export const AD_SPEND_8W_MINOR = 50_000; // 500.00 in major units

/** Above this many monthly orders, the watch extends to 8 weeks. */
export const ORDERS_8W = 100;

/** Below this data confidence, the watch extends to 8 weeks. */
export const CONFIDENCE_8W = 0.6;

/** "Tiny": at most this many monthly orders can qualify for 4 weeks. */
export const TINY_ORDERS_4W = 30;

/** 4 weeks needs at least this data confidence. */
export const CONFIDENCE_4W = 0.8;

export function decideMode(
  inputs: ModeDecisionInputs,
  adSpendMinor: number | null,
): ModeRuling | DeferredRuling {
  // P1-45: too little data → no guess. The interviewer keeps asking.
  if (inputs.completeness < DEFER_BELOW_COMPLETENESS) {
    return {
      deferred: true,
      completeness: inputs.completeness,
      reasoning:
        "The profile is under half complete, so I won't guess how carefully " +
        "to treat your business. I'll decide once the core questions are answered.",
    };
  }

  // §9: instant requires ALL of these — one failure means watching.
  const instantBlockers: string[] = [];
  if (inputs.has_revenue && (inputs.monthly_order_count ?? 10) >= 10) {
    instantBlockers.push(
      inputs.monthly_order_count !== null
        ? `~${inputs.monthly_order_count} orders per month`
        : "Revenue is coming in",
    );
  }
  if (inputs.employee_count > 0) {
    instantBlockers.push(
      `${inputs.employee_count} ${inputs.employee_count === 1 ? "person" : "people"} working in the business besides you`,
    );
  }
  if (inputs.has_active_ad_spend) instantBlockers.push("Paid ads are running");
  if (inputs.has_customer_support_process) {
    instantBlockers.push("A customer support process exists");
  }
  if (inputs.months_operating !== null && inputs.months_operating >= 3) {
    instantBlockers.push(`Operating for ${inputs.months_operating} months`);
  }

  if (instantBlockers.length === 0) {
    return {
      mode: "instant",
      watch_weeks: null,
      reasons: [
        inputs.has_revenue ? "Fewer than 10 lifetime orders" : "No revenue yet",
        "Nobody besides you works in the business",
        "No paid ads running",
        inputs.months_operating === null
          ? "Not operating yet"
          : `Operating under 3 months`,
      ],
      reasoning:
        "There is nothing running that a change could break: no meaningful " +
        "order flow, no staff, no ad spend, and the business is brand new. " +
        "Acting immediately risks nothing that waiting would protect.",
      confidence: inputs.data_confidence,
    };
  }

  // Watching. Length starts at 6 and moves by the spec's rules.
  const eightWeekReasons: string[] = [];
  if (inputs.employee_count > 0) eightWeekReasons.push("Employees are present");
  if (adSpendMinor !== null && adSpendMinor > AD_SPEND_8W_MINOR) {
    eightWeekReasons.push("Monthly ad spend is significant");
  }
  if ((inputs.monthly_order_count ?? 0) > ORDERS_8W) {
    eightWeekReasons.push(`More than ${ORDERS_8W} orders per month`);
  }
  if (inputs.data_confidence < CONFIDENCE_8W) {
    eightWeekReasons.push("The figures given are mostly estimates");
  }

  let weeks: 4 | 6 | 8 = 6;
  if (eightWeekReasons.length > 0) {
    weeks = 8;
  } else if (
    inputs.stage !== null &&
    inputs.months_operating !== null &&
    inputs.months_operating >= 3 &&
    inputs.employee_count === 0 &&
    (inputs.monthly_order_count ?? Number.POSITIVE_INFINITY) <= TINY_ORDERS_4W &&
    inputs.data_confidence >= CONFIDENCE_4W
  ) {
    // Operating but tiny, high confidence, no staff — the only 4-week path.
    weeks = 4;
  }

  return {
    mode: "watching",
    watch_weeks: weeks,
    reasons: weeks === 8 ? [...instantBlockers, ...eightWeekReasons] : instantBlockers,
    reasoning:
      `Your business is operating with real customers. Changing things quickly ` +
      `could cost you sales, so I'll spend ${weeks} weeks learning how it ` +
      `actually behaves before proposing anything.`,
    confidence: inputs.data_confidence,
  };
}
