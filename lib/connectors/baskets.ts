// Order baskets — idea 48, bundles. Pure.
//
// A store provider already reads every order's lines to count units per
// product (units.daily). This turns the same lines into one basket per
// order: the distinct store product ids it contained. A line with no
// product (a custom line, a tip) or no quantity left (refunded away) is
// not in it; an order with nothing left in it is not a basket at all.

import type { BasketInput } from "./provider";

export function basketOf(
  orderRef: string,
  day: string,
  lines: readonly { productRef: string | null; quantity: number }[],
): BasketInput | null {
  const refs = new Set<string>();
  for (const line of lines) {
    if (line.productRef === null || line.productRef === "" || line.quantity <= 0) continue;
    refs.add(line.productRef);
  }
  if (refs.size === 0) return null;
  return {
    order_ref: orderRef,
    day,
    product_refs: [...refs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}
