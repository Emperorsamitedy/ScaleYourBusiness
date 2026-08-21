// 20 synthetic business personas — P0-52 / step 22.
//
// Each persona pins the branching-critical facts (what they sell, stage,
// team size, a few gate booleans) and a seed; everything else is
// synthesized deterministically by input type. Diversity targets the
// resolver's branch space: services-only, physical-only, digital, every
// hybrid, idea-stage, high-unknown owners, skip-happy owners.

export interface Persona {
  name: string;
  seed: number;
  /** sells_type codes — drives THE branching field, identity.sells. */
  sells: readonly string[];
  /** business_stage code. */
  stage: string;
  teamSize: number;
  /** Probability an allow-unknown question is answered "I don't know". */
  unknownRate: number;
  /**
   * Pinned answers by writes_to. `{ code }` wraps into EnumValue;
   * `{ codes }` into EnumValue[]; `{ value }` is used verbatim;
   * `{ unknown: true }` forces an explicit unknown.
   */
  overrides: Readonly<
    Record<string, { code: string } | { codes: string[] } | { value: unknown } | { unknown: true }>
  >;
}

const base = (
  name: string,
  seed: number,
  sells: string[],
  stage: string,
  teamSize: number,
  overrides: Persona["overrides"] = {},
  unknownRate = 0.08,
): Persona => ({ name, seed, sells, stage, teamSize, unknownRate, overrides });

export const PERSONAS: readonly Persona[] = [
  base("solo-services-idea", 101, ["services"], "idea", 1, {
    "revenue.generates_revenue": { code: "not_launched" },
  }),
  base("physical-shop-small", 102, ["physical_products"], "operating", 3, {
    "offers.physical.holds_inventory": { code: "yes" },
    "offers.physical.manufactures_in_house": { value: false },
    "fulfilment.ships_products": { value: true },
  }),
  base("hybrid-shop-classic", 103, ["physical_products", "services"], "growing", 3, {
    "offers.physical.holds_inventory": { code: "yes" },
    "fulfilment.ships_products": { value: true },
    "service.uses_booking": { value: true },
  }),
  base("digital-saas", 104, ["software"], "growing", 5, {
    "revenue.generates_revenue": { code: "yes" },
  }),
  base("services-agency", 105, ["services"], "stable", 10, {
    "service.uses_booking": { value: false },
  }),
  base("maker-in-house", 106, ["physical_products"], "operating", 4, {
    "offers.physical.holds_inventory": { code: "partly" },
    "offers.physical.manufactures_in_house": { value: true },
    "fulfilment.ships_products": { value: true },
  }),
  base("dropshipper", 107, ["physical_products"], "recently_launched", 1, {
    "offers.physical.holds_inventory": { code: "no" },
    "offers.physical.manufactures_in_house": { value: false },
    "fulfilment.ships_products": { value: false },
  }),
  base("subscription-box", 108, ["subscriptions", "physical_products"], "growing", 2, {
    "offers.physical.holds_inventory": { code: "yes" },
    "fulfilment.ships_products": { value: true },
  }),
  base("marketplace-seller", 109, ["marketplace_access", "physical_products"], "operating", 2, {
    "offers.physical.holds_inventory": { code: "yes" },
    "fulfilment.ships_products": { value: true },
  }),
  base("consultancy-plus-tool", 110, ["services", "software"], "operating", 6, {}),
  base(
    "everything-stress",
    111,
    ["physical_products", "services", "software", "subscriptions"],
    "growing",
    12,
    {
      "offers.physical.holds_inventory": { code: "partly" },
      "offers.physical.manufactures_in_house": { value: true },
      "fulfilment.ships_products": { value: true },
      "service.uses_booking": { value: true },
    },
  ),
  base(
    "doesnt-track-much",
    112,
    ["physical_products"],
    "operating",
    2,
    { "offers.physical.holds_inventory": { code: "yes" } },
    0.35,
  ),
  base("bookings-studio", 113, ["services"], "operating", 3, {
    "service.uses_booking": { value: true },
  }),
  base("course-creator", 114, ["digital_products"], "recently_launched", 1, {}),
  base("importer", 115, ["physical_products"], "stable", 5, {
    "offers.physical.holds_inventory": { code: "yes" },
    "offers.physical.manufactures_in_house": { value: false },
    "fulfilment.ships_products": { value: true },
  }),
  base("local-food-delivery", 116, ["physical_products", "services"], "operating", 4, {
    "offers.physical.holds_inventory": { code: "yes" },
    "fulfilment.ships_products": { value: false },
    "fulfilment.local_delivery": { value: true },
  }),
  base("idea-stage-digital", 117, ["software"], "preparing_to_launch", 2, {
    "revenue.generates_revenue": { code: "not_launched" },
  }),
  base("physical-plus-digital", 118, ["physical_products", "digital_products"], "growing", 3, {
    "offers.physical.holds_inventory": { code: "yes" },
    "fulfilment.ships_products": { value: true },
  }),
  base(
    "declining-tired",
    119,
    ["services"],
    "declining",
    1,
    { "service.uses_booking": { value: false } },
    0.22,
  ),
  base(
    "minimal-answers",
    120,
    ["physical_products"],
    "operating",
    1,
    {
      "offers.physical.holds_inventory": { code: "no" },
      "fulfilment.ships_products": { value: false },
    },
    0.3,
  ),
];

/** Deterministic PRNG (mulberry32) so every run of a persona is identical. */
export function rngFor(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
