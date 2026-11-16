// The prices the v2 landing page prints (specs/ux-spec-v1.md §7.1b): the
// price book's monthly plan prices for an unknown market, and the one-off
// diagnosis at reportPrice() — the same figures checkout charges. Server
// only. If the price book can't be read, the page still renders, with a
// dash where a plan's price would be, rather than failing the front page.

import type { V2Prices } from "../../components/marketing/LandingV2";
import { planPrices } from "../billing/plans";
import { reportPrice } from "../billing/stripe";

export async function landingV2Prices(): Promise<V2Prices> {
  const prices: V2Prices = { report: await reportPrice() };
  try {
    for (const p of await planPrices("*")) {
      prices[p.tier] = { amount_minor: p.monthly_minor, currency: p.currency };
    }
  } catch {
    // The price book is unreachable: the page shows a dash for each plan.
  }
  return prices;
}
