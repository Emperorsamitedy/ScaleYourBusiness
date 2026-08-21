import { describe, expect, it } from "vitest";
import {
  DETAIL_FOR_KIND,
  isOfferKind,
  OFFER_KINDS,
  OfferDetailMismatchError,
  offerFieldKey,
} from "./offer";

describe("offer kinds — §5.3", () => {
  it("carries the five kinds, distinctly", () => {
    expect(OFFER_KINDS).toHaveLength(5);
    expect(new Set(OFFER_KINDS).size).toBe(5);
    expect(isOfferKind("physical")).toBe(true);
    expect(isOfferKind("consulting")).toBe(false);
  });

  it("maps each kind to its §5.3 detail variant — none for subscription/marketplace", () => {
    expect(DETAIL_FOR_KIND.physical).toBe("physical");
    expect(DETAIL_FOR_KIND.service).toBe("service");
    expect(DETAIL_FOR_KIND.digital).toBe("digital");
    expect(DETAIL_FOR_KIND.subscription).toBeNull();
    expect(DETAIL_FOR_KIND.marketplace_access).toBeNull();
  });
});

describe("offerFieldKey", () => {
  it("builds shared-attribute keys for any kind", () => {
    expect(offerFieldKey("7f3a", "subscription", ["price"])).toBe("offers.7f3a.price");
  });

  it("builds detail keys when the namespace matches the kind", () => {
    expect(offerFieldKey("7f3a", "physical", ["physical", "inventory", "current_level"])).toBe(
      "offers.7f3a.physical.inventory.current_level",
    );
    expect(offerFieldKey("b2c1", "service", ["service", "key_person_dependency"])).toBe(
      "offers.b2c1.service.key_person_dependency",
    );
  });

  it("refuses a detail namespace on the wrong kind — a mis-filed fact is invisible", () => {
    expect(() => offerFieldKey("7f3a", "service", ["physical", "shipping"])).toThrow(
      OfferDetailMismatchError,
    );
    expect(() => offerFieldKey("7f3a", "subscription", ["digital", "churn_rate_monthly"])).toThrow(
      OfferDetailMismatchError,
    );
  });
});
