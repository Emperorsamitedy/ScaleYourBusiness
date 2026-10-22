// Who the slow-stock screen exists for — feature 34. Pure, so the menu, the
// screen and their tests read the same condition without a database.
//
// Data, not an if on the business type (rule 4): a ConditionExpr over the
// bank's own answers, evaluated by the resolver's evaluator. The business
// sells physical products (1.4), and the owner didn't say they hold no
// stock (1.4.1.2). A services-only business never gets the screen, the
// menu entry or a proposal.

import type { ConditionExpr } from "../conditions/evaluate";

export const STOCK_APPLIES: ConditionExpr = {
  op: "and",
  terms: [
    { op: "includes", field: "identity.sells", value: "physical_products" },
    { op: "not", term: { op: "eq", field: "offers.physical.holds_inventory", value: "no" } },
  ],
};
