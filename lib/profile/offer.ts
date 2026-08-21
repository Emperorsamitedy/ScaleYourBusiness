// Offer kinds and their detail variants — data-model-v1.md §5.3.
//
// The offers table stores the spine (id, profile, kind); offer attributes
// are field_records under "offers.<offer_id>.<attr>" and detail attributes
// under "offers.<offer_id>.<detail>.<attr>". This module owns the rule for
// which detail namespace a kind may carry: an inventory record on a
// service offer is a mis-filed fact, and mis-filed facts are invisible to
// the diagnosis queries that look for them.

export const OFFER_KINDS = [
  "physical",
  "service",
  "digital",
  "subscription",
  "marketplace_access",
] as const;

export type OfferKind = (typeof OFFER_KINDS)[number];

export const OFFER_DETAILS = ["physical", "service", "digital"] as const;

export type OfferDetail = (typeof OFFER_DETAILS)[number];

/**
 * §5.3 defines a detail extension for physical, service and digital kinds.
 * subscription and marketplace_access carry none in v1 — their specifics
 * live in the shared attributes (price_model, purchase_type, …).
 */
export const DETAIL_FOR_KIND: Readonly<Record<OfferKind, OfferDetail | null>> = {
  physical: "physical",
  service: "service",
  digital: "digital",
  subscription: null,
  marketplace_access: null,
};

export class OfferDetailMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferDetailMismatchError";
  }
}

export function isOfferKind(value: string): value is OfferKind {
  return (OFFER_KINDS as readonly string[]).includes(value);
}

/**
 * Build the field_key for an offer attribute, checking that a detail
 * namespace is only used with the kind it belongs to.
 *
 *   offerFieldKey("7f3a", "physical", ["price"])            → offers.7f3a.price
 *   offerFieldKey("7f3a", "physical", ["physical", "inventory", "current_level"])
 *                                                           → offers.7f3a.physical.inventory.current_level
 *   offerFieldKey("7f3a", "service", ["physical", "shipping"]) → throws
 */
export function offerFieldKey(
  offerId: string,
  kind: OfferKind,
  path: readonly [string, ...string[]],
): string {
  const [head] = path;
  if ((OFFER_DETAILS as readonly string[]).includes(head)) {
    if (DETAIL_FOR_KIND[kind] !== head) {
      throw new OfferDetailMismatchError(
        `detail namespace "${head}" does not belong to kind "${kind}" — ` +
          `${DETAIL_FOR_KIND[kind] === null ? "this kind carries no detail variant" : `it carries "${DETAIL_FOR_KIND[kind]}"`}`,
      );
    }
  }
  return ["offers", offerId, ...path].join(".");
}
