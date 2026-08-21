// Session I — condition evaluator. P0-39 every operator (pass + fail) ·
// P0-40 the .length accessor · P0-41 three levels of nesting + totality
// over every condition in the real bank.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConditionContext, ConditionExpr, FieldView } from "./evaluate";
import { evaluate } from "./evaluate";

/** Context over a plain map — what Session J builds from a live profile. */
function ctx(fields: Record<string, FieldView>): ConditionContext {
  return { get: (key) => fields[key] };
}

const answered = (value: unknown): FieldView => ({ status: "answered", value });

describe("P0-39 — every operator, passing and failing", () => {
  it("eq / neq on scalars and on EnumValue codes", () => {
    const c = ctx({
      "identity.stage": answered({ code: "growing" }),
      "identity.team_size": answered(3),
    });
    expect(evaluate({ op: "eq", field: "identity.stage", value: "growing" }, c)).toBe(true);
    expect(evaluate({ op: "eq", field: "identity.stage", value: "idea" }, c)).toBe(false);
    expect(evaluate({ op: "neq", field: "identity.stage", value: "idea" }, c)).toBe(true);
    expect(evaluate({ op: "neq", field: "identity.stage", value: "growing" }, c)).toBe(false);
    expect(evaluate({ op: "eq", field: "identity.team_size", value: 3 }, c)).toBe(true);
  });

  it("includes on multi-select EnumValue arrays and plain arrays", () => {
    const c = ctx({
      "identity.sells": answered([{ code: "physical_products" }, { code: "services" }]),
      "tooling.stack": answered(["shopify", "meta_ads"]),
    });
    expect(
      evaluate({ op: "includes", field: "identity.sells", value: "physical_products" }, c),
    ).toBe(true);
    expect(evaluate({ op: "includes", field: "identity.sells", value: "software" }, c)).toBe(false);
    expect(evaluate({ op: "includes", field: "tooling.stack", value: "shopify" }, c)).toBe(true);
  });

  it("gt / gte / lt / lte", () => {
    const c = ctx({ "identity.team_size": answered(3) });
    expect(evaluate({ op: "gt", field: "identity.team_size", value: 2 }, c)).toBe(true);
    expect(evaluate({ op: "gt", field: "identity.team_size", value: 3 }, c)).toBe(false);
    expect(evaluate({ op: "gte", field: "identity.team_size", value: 3 }, c)).toBe(true);
    expect(evaluate({ op: "lt", field: "identity.team_size", value: 4 }, c)).toBe(true);
    expect(evaluate({ op: "lt", field: "identity.team_size", value: 3 }, c)).toBe(false);
    expect(evaluate({ op: "lte", field: "identity.team_size", value: 3 }, c)).toBe(true);
  });

  it("answered / unanswered — value-bearing statuses only", () => {
    const c = ctx({
      "revenue.monthly_revenue": answered({ amount_minor: 1, currency: "HUF" }),
      "costs.gross_margin": { status: "inferred", value: 0.31 },
      "revenue.repeat_customer_rate": { status: "unknown", value: null },
      "identity.founded": { status: "skipped", value: null },
    });
    expect(evaluate({ op: "answered", field: "revenue.monthly_revenue" }, c)).toBe(true);
    expect(evaluate({ op: "answered", field: "costs.gross_margin" }, c)).toBe(true);
    // The owner's "I don't know" is a real answer — but not a usable value.
    expect(evaluate({ op: "answered", field: "revenue.repeat_customer_rate" }, c)).toBe(false);
    expect(evaluate({ op: "unanswered", field: "identity.founded" }, c)).toBe(true);
    expect(evaluate({ op: "unanswered", field: "presence.website" }, c)).toBe(true);
  });

  it("and / or / not", () => {
    const c = ctx({ "identity.team_size": answered(3) });
    const yes: ConditionExpr = { op: "gt", field: "identity.team_size", value: 1 };
    const no: ConditionExpr = { op: "lt", field: "identity.team_size", value: 1 };
    expect(evaluate({ op: "and", terms: [yes, yes] }, c)).toBe(true);
    expect(evaluate({ op: "and", terms: [yes, no] }, c)).toBe(false);
    expect(evaluate({ op: "or", terms: [no, yes] }, c)).toBe(true);
    expect(evaluate({ op: "or", terms: [no, no] }, c)).toBe(false);
    expect(evaluate({ op: "not", term: no }, c)).toBe(true);
    expect(evaluate({ op: "not", term: yes }, c)).toBe(false);
  });

  it("every value comparison is false against a missing or valueless field — neq included", () => {
    const c = ctx({ "revenue.repeat_customer_rate": { status: "unknown", value: null } });
    const missing = "presence.website";
    expect(evaluate({ op: "eq", field: missing, value: "x" }, c)).toBe(false);
    // neq means "answered and different", never "not known to be equal":
    // a follow-up must not surface before its upstream fact exists.
    expect(evaluate({ op: "neq", field: missing, value: "x" }, c)).toBe(false);
    expect(evaluate({ op: "neq", field: "revenue.repeat_customer_rate", value: 0.5 }, c)).toBe(
      false,
    );
    expect(evaluate({ op: "includes", field: missing, value: "x" }, c)).toBe(false);
    expect(evaluate({ op: "gt", field: missing, value: 0 }, c)).toBe(false);
  });
});

describe("P0-40 — the .length accessor", () => {
  it("compares the length of an array field", () => {
    const c = ctx({
      "identity.sells": answered([{ code: "physical_products" }, { code: "services" }]),
    });
    expect(evaluate({ op: "gt", field: "identity.sells.length", value: 1 }, c)).toBe(true);
    expect(evaluate({ op: "gt", field: "identity.sells.length", value: 2 }, c)).toBe(false);
    expect(evaluate({ op: "eq", field: "identity.sells.length", value: 2 }, c)).toBe(true);
  });

  it("works over entity-count views the context exposes (offers.length)", () => {
    const c = ctx({ offers: answered([{}, {}, {}]) });
    expect(evaluate({ op: "gte", field: "offers.length", value: 3 }, c)).toBe(true);
    expect(evaluate({ op: "gt", field: "offers.length", value: 3 }, c)).toBe(false);
  });

  it("is false when the base is missing, valueless, or not an array", () => {
    const c = ctx({
      "identity.team_size": answered(3),
      "identity.sells": { status: "unknown", value: null },
    });
    expect(evaluate({ op: "gt", field: "channels.length", value: 0 }, c)).toBe(false);
    expect(evaluate({ op: "gt", field: "identity.sells.length", value: 0 }, c)).toBe(false);
    expect(evaluate({ op: "gt", field: "identity.team_size.length", value: 0 }, c)).toBe(false);
  });

  it("answered/unanswered on a .length reference checks the base field", () => {
    const c = ctx({ "identity.sells": answered([{ code: "services" }]) });
    expect(evaluate({ op: "answered", field: "identity.sells.length" }, c)).toBe(true);
    expect(evaluate({ op: "unanswered", field: "channels.length" }, c)).toBe(true);
  });
});

describe("P0-41 — nesting and totality", () => {
  it("evaluates three levels of nesting correctly", () => {
    const c = ctx({
      "identity.sells": answered([{ code: "physical_products" }, { code: "services" }]),
      "identity.stage": answered({ code: "growing" }),
      "identity.team_size": answered(3),
    });
    // and( or( eq(stage,idea), gt(team,1) ), not( and( includes(sells,software), gt(team,10) ) ) )
    const expr: ConditionExpr = {
      op: "and",
      terms: [
        {
          op: "or",
          terms: [
            { op: "eq", field: "identity.stage", value: "idea" },
            { op: "gt", field: "identity.team_size", value: 1 },
          ],
        },
        {
          op: "not",
          term: {
            op: "and",
            terms: [
              { op: "includes", field: "identity.sells", value: "software" },
              { op: "gt", field: "identity.team_size", value: 10 },
            ],
          },
        },
      ],
    };
    expect(evaluate(expr, c)).toBe(true);
    // Flip the innermost leaf: stage→idea AND team_size→0 kills the or-branch.
    const c2 = ctx({
      "identity.sells": answered([{ code: "software" }]),
      "identity.stage": answered({ code: "growing" }),
      "identity.team_size": answered(0),
    });
    expect(evaluate(expr, c2)).toBe(false);
  });

  it("evaluates every condition in the real bank without throwing — empty and populated contexts", () => {
    const bank = JSON.parse(readFileSync("specs/question-bank-v1.json", "utf8")) as {
      questions: { condition: ConditionExpr | null }[];
    };
    const conditions = bank.questions.flatMap((q) => (q.condition ? [q.condition] : []));
    expect(conditions.length).toBeGreaterThanOrEqual(80);

    const empty = ctx({});
    const populated = ctx({
      "identity.sells": answered([{ code: "physical_products" }, { code: "services" }]),
      "identity.stage": answered({ code: "growing" }),
      offers: answered([{}, {}]),
      channels: answered([{}]),
    });
    for (const condition of conditions) {
      // Totality: every stored condition evaluates to a boolean, never throws.
      expect(typeof evaluate(condition, empty)).toBe("boolean");
      expect(typeof evaluate(condition, populated)).toBe("boolean");
    }
  });
});
