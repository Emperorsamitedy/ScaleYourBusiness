// Area tiles — the status of each bank section, computed from the bank's
// ConditionExpr data and the current responses. Pure: a fake context
// stands in for the profile. Each status has a passing and a failing case.

import { describe, expect, it } from "vitest";
import type { ConditionContext, ConditionExpr, FieldView } from "../conditions/evaluate";
import type { AreaQuestion, ResponseKind } from "./areas";
import {
  areaBars,
  areaOfField,
  computeAreas,
  naturalIdCompare,
  responseKindOf,
  unmetDependencies,
} from "./areas";

function ctxOf(entries: Record<string, FieldView>): ConditionContext {
  const map = new Map(Object.entries(entries));
  return { get: (key) => map.get(key) };
}

const answered = (value: unknown): FieldView => ({ status: "answered", value });
const unknownView: FieldView = { status: "unknown", value: null };

const sellsPhysical: ConditionExpr = {
  op: "includes",
  field: "identity.sells",
  value: "physical_products",
};
const shipsProducts: ConditionExpr = { op: "eq", field: "fulfilment.ships_products", value: true };

// A miniature bank: identity asks what is sold; operations depends on it;
// goals is unconditional; marketing depends on an identity answer that is
// FALSE for this business when recorded.
const BANK: AreaQuestion[] = [
  { id: "1.1", section: "identity", writes_to: "identity.legal_name", condition: null },
  { id: "1.4", section: "identity", writes_to: "identity.sells", condition: null },
  {
    id: "1.4.1.5",
    section: "offers",
    writes_to: "fulfilment.ships_products",
    condition: sellsPhysical,
  },
  {
    id: "9.4",
    section: "operations",
    writes_to: "operations.shipping_cost",
    condition: shipsProducts,
  },
  { id: "13.1", section: "goals", writes_to: "goals.primary", condition: null },
  { id: "13.2", section: "goals", writes_to: "goals.horizon", condition: null },
  {
    id: "8.9",
    section: "marketing",
    writes_to: "marketing.services_promo",
    condition: { op: "includes", field: "identity.sells", value: "services" },
  },
];

const areas = (
  ctx: ConditionContext,
  responded: string[] = [],
  skipped: string[] = [],
  activeSection: string | null = null,
) =>
  computeAreas({
    questions: BANK,
    ctx,
    responded: new Set(responded),
    skippedKeys: new Set(skipped),
    activeSection,
  });
const area = (list: ReturnType<typeof areas>, section: string) =>
  list.find((a) => a.section === section);

describe("completed", () => {
  it("passes when every applicable question in the area has a response", () => {
    const ctx = ctxOf({
      "identity.legal_name": answered("Fernhill"),
      "identity.sells": unknownView,
    });
    const a = area(areas(ctx, ["identity.legal_name", "identity.sells"]), "identity");
    expect(a).toMatchObject({ status: "completed", answered: 2, open: 0, needs: null });
  });

  it("fails while one applicable question is still open", () => {
    const ctx = ctxOf({ "identity.legal_name": answered("Fernhill") });
    const a = area(areas(ctx, ["identity.legal_name"]), "identity");
    expect(a?.status).not.toBe("completed");
    expect(a).toMatchObject({ answered: 1, open: 1 });
  });

  it("an explicit unknown counts as a response; a skip does not (rule 5)", () => {
    const ctx = ctxOf({});
    const a = area(areas(ctx, ["goals.primary"], ["goals.horizon"]), "goals");
    expect(a).toMatchObject({ status: "in_progress", answered: 1, skipped: 1, open: 0 });
  });
});

describe("in progress", () => {
  it("passes when some, not all, applicable questions have a response", () => {
    const a = area(areas(ctxOf({}), ["goals.primary"]), "goals");
    expect(a).toMatchObject({ status: "in_progress", answered: 1, open: 1 });
  });

  it("passes for the area being asked right now, before its first answer", () => {
    const a = area(areas(ctxOf({}), [], [], "goals"), "goals");
    expect(a?.status).toBe("in_progress");
  });

  it("fails for an untouched area that is not being asked", () => {
    const a = area(areas(ctxOf({}), [], [], "identity"), "goals");
    expect(a?.status).toBe("not_started");
  });
});

describe("not started", () => {
  it("passes when applicable questions are open and none has a response", () => {
    const a = area(areas(ctxOf({})), "identity");
    expect(a).toMatchObject({ status: "not_started", answered: 0, open: 2 });
  });

  it("fails once one of its questions is skipped — the area has been visited", () => {
    const a = area(areas(ctxOf({}), [], ["identity.legal_name"]), "identity");
    expect(a?.status).toBe("in_progress");
  });
});

describe("blocked — needs another area first", () => {
  it("passes when no question applies yet because a condition reads an unrecorded fact", () => {
    // Nothing recorded: offers waits on identity.sells, operations on
    // fulfilment.ships_products (answered in offers).
    const list = areas(ctxOf({}));
    expect(area(list, "offers")).toMatchObject({ status: "blocked", needs: "identity" });
    expect(area(list, "operations")).toMatchObject({ status: "blocked", needs: "offers" });
  });

  it("fails once the needed fact is recorded and the questions apply", () => {
    const ctx = ctxOf({ "identity.sells": answered([{ code: "physical_products" }]) });
    const list = areas(ctx, ["identity.sells"]);
    expect(area(list, "offers")).toMatchObject({ status: "not_started", open: 1 });
    // Operations still waits — now on the offers answer, not identity.
    expect(area(list, "operations")).toMatchObject({ status: "blocked", needs: "offers" });
  });

  it("an explicit unknown upstream still blocks: the condition has nothing to read", () => {
    const ctx = ctxOf({ "identity.sells": unknownView });
    expect(area(areas(ctx, ["identity.sells"]), "offers")).toMatchObject({
      status: "blocked",
      needs: "identity",
    });
  });
});

describe("blocked after its own questions are done", () => {
  const OPS: AreaQuestion[] = [
    { id: "9.1", section: "operations", writes_to: "operations.status", condition: null },
    {
      id: "9.4",
      section: "operations",
      writes_to: "operations.shipping_cost",
      condition: shipsProducts,
    },
  ];
  const run = (ctx: ConditionContext) =>
    computeAreas({
      questions: OPS,
      ctx,
      responded: new Set(["operations.status"]),
      skippedKeys: new Set(),
    })[0];

  it("passes: answered, but one question waits on a fact another area records", () => {
    // No question in this bank writes the dependency: its key's home section.
    expect(run(ctxOf({}))).toMatchObject({ status: "blocked", needs: "offers", answered: 1 });
  });

  it("fails once that fact is recorded and settles the question out — then completed", () => {
    const ctx = ctxOf({ "fulfilment.ships_products": answered(false) });
    expect(run(ctx)).toMatchObject({ status: "completed", needs: null, answered: 1 });
  });
});

describe("an area that does not apply is left out, not blocked", () => {
  it("passes: conditions false on recorded facts drop the area", () => {
    const ctx = ctxOf({ "identity.sells": answered([{ code: "physical_products" }]) });
    expect(area(areas(ctx, ["identity.sells"]), "marketing")).toBeUndefined();
  });

  it("fails while the deciding fact is unrecorded — then it is blocked", () => {
    expect(area(areas(ctxOf({})), "marketing")).toMatchObject({ status: "blocked" });
  });

  it("keeps profile-section order and skips sections with no questions", () => {
    expect(areas(ctxOf({})).map((a) => a.section)).toEqual([
      "identity",
      "offers",
      "marketing",
      "operations",
      "goals",
    ]);
  });
});

describe("unmetDependencies reads the ConditionExpr, not per-question code", () => {
  it("names the missing field of a leaf comparison", () => {
    expect(unmetDependencies(shipsProducts, ctxOf({}))).toEqual(["fulfilment.ships_products"]);
  });

  it("is empty when the condition already holds", () => {
    const ctx = ctxOf({ "fulfilment.ships_products": answered(true) });
    expect(unmetDependencies(shipsProducts, ctx)).toEqual([]);
  });

  it("is empty when the condition is false on recorded facts alone", () => {
    const ctx = ctxOf({ "fulfilment.ships_products": answered(false) });
    expect(unmetDependencies(shipsProducts, ctx)).toEqual([]);
  });

  it("an AND that fails on a recorded fact cannot be rescued by a missing one", () => {
    const expr: ConditionExpr = { op: "and", terms: [sellsPhysical, shipsProducts] };
    const ctx = ctxOf({ "identity.sells": answered([{ code: "services" }]) });
    expect(unmetDependencies(expr, ctx)).toEqual([]);
  });

  it("an OR names every way forward", () => {
    const expr: ConditionExpr = {
      op: "or",
      terms: [sellsPhysical, { op: "gt", field: "offers.length", value: 1 }],
    };
    expect(unmetDependencies(expr, ctxOf({}))).toEqual(["identity.sells", "offers"]);
  });

  it("a negated `unanswered` needs its field recorded", () => {
    const expr: ConditionExpr = { op: "not", term: { op: "unanswered", field: "goals.primary" } };
    expect(unmetDependencies(expr, ctxOf({}))).toEqual(["goals.primary"]);
    expect(unmetDependencies({ op: "unanswered", field: "goals.primary" }, ctxOf({}))).toEqual([]);
  });

  it("maps a dependency to the area of the question that writes it", () => {
    expect(areaOfField("fulfilment.ships_products", BANK)).toBe("offers");
    expect(areaOfField("identity.sells", BANK)).toBe("identity");
    // No question writes it: the key's own home section.
    expect(areaOfField("revenue.monthly_revenue", BANK)).toBe("revenue");
    expect(areaOfField("nowhere.at_all", BANK)).toBeNull();
  });
});

describe("bars — one per applicable question, in bank order", () => {
  const Q: AreaQuestion[] = [
    { id: "3.10", section: "offers", writes_to: "offers.ten", condition: null },
    { id: "3.2", section: "offers", writes_to: "offers.two", condition: null },
    { id: "3.3", section: "offers", writes_to: "offers.three", condition: null },
    { id: "3.4", section: "offers", writes_to: "offers.four", condition: null },
    { id: "3.5", section: "offers", writes_to: "offers.five", condition: null },
    { id: "3.6", section: "offers", writes_to: "offers.six", condition: null },
    { id: "3.7", section: "offers", writes_to: "offers.seven", condition: null },
  ];
  const responded = new Set(["offers.two", "offers.three", "offers.four", "offers.five"]);
  const skipped = new Set(["offers.six"]);
  const kinds = new Map<string, ResponseKind>([
    ["offers.two", "owner"],
    ["offers.three", "measured"],
    ["offers.four", "unknown"],
    ["offers.five", "derived"],
  ]);

  it("passes: each bar says what its question's record is, the asked one is current", () => {
    expect(areaBars(Q, responded, skipped, "3.7", kinds)).toEqual([
      "owner", // 3.2
      "measured", // 3.3
      "unknown", // 3.4
      "derived", // 3.5
      "skipped", // 3.6
      "current", // 3.7
      "open", // 3.10 — natural order puts it last
    ]);
  });

  it("keeps unknown, skipped and open apart (rule 5)", () => {
    const bars = areaBars(Q, responded, skipped, null, kinds);
    expect(bars[2]).toBe("unknown");
    expect(bars[4]).toBe("skipped");
    expect(bars[5]).toBe("open");
  });

  it("fails over to the owner for a responded key with no recorded kind (an entity spine)", () => {
    expect(areaBars(Q.slice(1, 2), responded, skipped, null, new Map())).toEqual(["owner"]);
  });

  it("only applicable questions get a bar: a condition false on the record drops one", () => {
    const ctx = ctxOf({ "identity.sells": answered([{ code: "physical_products" }]) });
    const list = computeAreas({
      questions: BANK,
      ctx,
      responded: new Set(["identity.legal_name"]),
      skippedKeys: new Set(),
      activeQuestionId: "1.4",
    });
    expect(area(list, "identity")?.bars).toEqual(["owner", "current"]);
    // marketing's only question needs services: false on the record, so no area, no bars.
    expect(area(list, "marketing")).toBeUndefined();
  });
});

describe("responseKindOf reads status and source, never the question", () => {
  it("names a measurement, a derivation, an owner answer and an explicit unknown", () => {
    expect(responseKindOf("inferred", "connector")).toBe("measured");
    expect(responseKindOf("answered", "connector")).toBe("measured");
    expect(responseKindOf("inferred", "inferred")).toBe("derived");
    expect(responseKindOf("answered", "owner_input")).toBe("owner");
    expect(responseKindOf("unknown", "owner_input")).toBe("unknown");
  });

  it("is null for a record that is not a response — a skip, unasked, not applicable", () => {
    expect(responseKindOf("skipped", "owner_input")).toBeNull();
    expect(responseKindOf("unasked", "owner_input")).toBeNull();
    expect(responseKindOf("not_applicable", "owner_input")).toBeNull();
  });
});

describe("naturalIdCompare", () => {
  it("orders bank ids by number, then by suffix", () => {
    expect(["1.10", "1.9", "1.4.1.5a", "1.4.1.5"].sort(naturalIdCompare)).toEqual([
      "1.4.1.5",
      "1.4.1.5a",
      "1.9",
      "1.10",
    ]);
  });
});
