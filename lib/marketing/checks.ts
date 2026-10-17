// What the diagnosis checks, in the owner's words — the landing page's
// "§2 What's checked" table and its hard counts ("N checks across M
// areas"). Every row names the code that does the check, and a test
// holds this list to the code: a validation rule added without a row
// here fails the suite, so the page can never claim more, or less, than
// the product does.

import type { Area } from "../diagnosis/findings";

export type CheckKind = "consistency" | "arithmetic" | "measured";

export interface Check {
  area: Area;
  kind: CheckKind;
  /** What it checks, plainly. */
  what: string;
  /** Where it lives: a validation rule id, or the computed output it reads. */
  source: string;
}

export const CHECKS: readonly Check[] = [
  {
    area: "finance",
    kind: "arithmetic",
    what: "Margin on every product, from its price and its cost to deliver",
    source: "economics.offers.margin_pct",
  },
  {
    area: "finance",
    kind: "arithmetic",
    what: "Your blended margin across everything you sell",
    source: "economics.blended_margin_pct",
  },
  {
    area: "finance",
    kind: "consistency",
    what: "The margin you state against the margin your prices and costs produce",
    source: "margin_mismatch",
  },
  {
    area: "finance",
    kind: "consistency",
    what: "Monthly revenue you state against prices × volumes",
    source: "revenue_vs_offers",
  },
  {
    area: "finance",
    kind: "consistency",
    what: "Costs that exceed revenue while revenue is marked as growing",
    source: "costs_exceed_revenue",
  },
  {
    area: "finance",
    kind: "arithmetic",
    what: "The sales volume you need each month to cover fixed costs",
    source: "economics.break_even",
  },
  {
    area: "finance",
    kind: "consistency",
    what: "Financial figures too old to rely on",
    source: "stale_financials",
  },
  {
    area: "sales",
    kind: "arithmetic",
    what: "Average order value",
    source: "economics.average_order_value",
  },
  {
    area: "sales",
    kind: "consistency",
    what: "A main sales channel with no revenue figure",
    source: "channel_without_revenue",
  },
  {
    area: "sales",
    kind: "consistency",
    what: "Your stated business stage against your revenue",
    source: "stage_vs_revenue",
  },
  {
    area: "marketing",
    kind: "arithmetic",
    what: "What it costs you to win one customer",
    source: "economics.cost_per_acquisition",
  },
  {
    area: "marketing",
    kind: "arithmetic",
    what: "Return on ad spend",
    source: "economics.return_on_ad_spend",
  },
  {
    area: "marketing",
    kind: "measured",
    what: "Your estimates against what a connected account measured",
    source: "economics.stated_vs_measured",
  },
  {
    area: "operations",
    kind: "consistency",
    what: "Stock held with no supplier recorded",
    source: "inventory_without_supplier",
  },
  {
    area: "operations",
    kind: "consistency",
    what: "Everything resting on one supplier, with no alternative",
    source: "single_supplier_top_offer",
  },
  {
    area: "operations",
    kind: "consistency",
    what: "The business depending on one person, with nothing written down",
    source: "key_person_undocumented",
  },
  {
    area: "customers",
    kind: "measured",
    what: "Which weekdays and hours earn their opening costs",
    source: "trading_hours",
  },
];

export const CHECK_AREAS: readonly Area[] = [...new Set(CHECKS.map((c) => c.area))];
