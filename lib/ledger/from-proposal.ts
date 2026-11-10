// A proposal's measurement plan — what the engine writes before anything
// runs (the v1 build spec §3.1, P7-36).
//
// The proposal already states its expectation: a summary of the action, and
// a scenario whose base, downside and upside cases each carry a monthly
// profit change. The plan takes those for its window — base as the point,
// downside and upside as the range — so the forecast is on record before the
// outcome is known. A proposal with no money in its base case gets a plan
// that says so: an expected effect of zero with a zero range, a hypothesis
// that names the missing forecast, and no place in the calibration score.

import type { Money } from "../core/money";
import { isIsoCurrency, money, scaleMinorBy } from "../core/money";
import type { OpenPlanInput } from "./plans";
import { DEFAULT_WINDOW_DAYS } from "./plans";

interface CaseLike {
  statement?: unknown;
  profit_delta_monthly?: { amount_minor?: unknown; currency?: unknown } | null;
}

function moneyOf(c: CaseLike | undefined): Money | null {
  const m = c?.profit_delta_monthly;
  if (!m || !Number.isSafeInteger(m.amount_minor)) return null;
  if (typeof m.currency !== "string" || !isIsoCurrency(m.currency)) return null;
  return money(m.amount_minor as number, m.currency);
}

/** A monthly figure scaled to the plan's window, in whole minor units. */
function forWindow(m: Money, days: number): Money {
  return money(scaleMinorBy(m.amount_minor, days, 30), m.currency);
}

export interface ProposalLike {
  id: string;
  profile_id: string;
  module: string;
  action: unknown;
  scenario: unknown;
}

/** The fallback currency for a plan with no forecast in money. */
export const NO_FORECAST_CURRENCY = "EUR";

export function planFromProposal(
  proposal: ProposalLike,
  args: {
    accountId: string;
    provider: string;
    op: string;
    reversible: boolean;
    station: 1 | 2 | 3 | 4;
    shadow: boolean;
    now?: Date;
    windowDays?: number;
  },
): OpenPlanInput {
  const days = args.windowDays ?? DEFAULT_WINDOW_DAYS;
  const action = (proposal.action ?? {}) as { summary?: unknown };
  const scenario = (proposal.scenario ?? {}) as {
    base_case?: CaseLike;
    downside_case?: CaseLike;
    upside_case?: CaseLike;
  };
  const base = moneyOf(scenario.base_case);
  const down = moneyOf(scenario.downside_case);
  const up = moneyOf(scenario.upside_case);

  let expected: OpenPlanInput["expected"] = null;
  if (base) {
    const same = (m: Money | null) => (m && m.currency === base.currency ? m : base);
    const effect = forWindow(base, days);
    const a = forWindow(same(down), days).amount_minor;
    const b = forWindow(same(up), days).amount_minor;
    expected = {
      effect,
      low: money(Math.min(a, b, effect.amount_minor), base.currency),
      high: money(Math.max(a, b, effect.amount_minor), base.currency),
    };
  }

  const summary =
    typeof action.summary === "string" && action.summary.trim() !== ""
      ? action.summary
      : `${args.op.replace(/_/g, " ")} on ${args.provider.replace(/_/g, " ")}`;
  const statement =
    typeof scenario.base_case?.statement === "string" ? scenario.base_case.statement.trim() : "";
  const hypothesis = base
    ? statement || "Profit changes by the base case's amount over the window."
    : `No forecast in money was made for this action${statement ? `: ${statement}` : "."}`;

  return {
    profileId: proposal.profile_id,
    accountId: args.accountId,
    provider: args.provider,
    module: proposal.module,
    proposalId: proposal.id,
    action_summary: summary,
    hypothesis,
    expected,
    currency: base?.currency ?? NO_FORECAST_CURRENCY,
    cost: null,
    reversible: args.reversible,
    rollback_token: args.reversible ? `execution:${proposal.id}` : null,
    opened_by: "agent",
    station: args.station,
    shadow: args.shadow,
    windowDays: days,
    ...(args.now ? { now: args.now } : {}),
  };
}
