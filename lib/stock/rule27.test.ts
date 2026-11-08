// Rule 27 — stock suggestions stop at the owner. A build-failing test:
//   · the reorder note's kind is a NOTE kind, never one the diagnosis
//     classifier or the alert review can emit, and no executor knows it;
//   · amended 2026-11-08 (P6-04, TASKS-PHASE6.md): the ONE supplier operation
//     any provider declares is purchase_order's send_purchase_order — an
//     approved order emailed through the engine, from lib/purchasing, never
//     from here. lib/purchasing/rule27.test.ts holds its own fence;
//   · nothing in lib/stock can reach a network, an executor or a supplier:
//     no fetch, no execution import, no write scope, no order operation;
//   · a stock proposal that carries an execution plan in its detail is not
//     run from it: the due runner's allow-list has no "stock" entry.
// Each check has its failing case beside it: the scanner flags a planted line.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PREBOUND_ALLOWED, preboundPlan } from "../execution/due";
import { EXECUTION_SCOPE_REGISTRY } from "../execution/scopes";
import { ACTION_KINDS, NOTE_KINDS, checkHardLimits } from "../proposals/hard-limits";
import { REORDER_KIND } from "./reorder";

const DIR = join(process.cwd(), "lib", "stock");

/** What a stock source file must never contain: a way to act outside SYB. */
const FORBIDDEN: readonly [RegExp, string][] = [
  [/\bfetch\s*\(/, "a network call"],
  [/from\s+["']\.\.\/execution\//, "an execution-engine import"],
  [/from\s+["']\.\.\/connectors\/providers\//, "a provider client import"],
  [/\bhttps?:\/\//, "a URL"],
  [/\b(place|submit|create|cancel|edit)_?(purchase_)?order\b/i, "an order operation"],
];

function violations(source: string): string[] {
  return FORBIDDEN.filter(([re]) => re.test(source)).map(([, what]) => what);
}

const sources = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ file: f, text: readFileSync(join(DIR, f), "utf8") }));

describe("rule 27 — no supplier write, anywhere in lib/stock", () => {
  it("scans every stock source file", () => {
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining(["cover.ts", "cover-load.ts", "reorder.ts", "warnings.ts"]),
    );
  });

  it("no stock source can reach a network, an executor or an order", () => {
    for (const s of sources)
      expect({ file: s.file, found: violations(s.text) }).toEqual({
        file: s.file,
        found: [],
      });
  });

  it("the scanner itself catches what it is for", () => {
    expect(violations(`await fetch("https://supplier.example/orders")`)).toEqual([
      "a network call",
      "a URL",
    ]);
    expect(violations(`import { x } from "../execution/engine";`)).toEqual([
      "an execution-engine import",
    ]);
    expect(violations(`const op = "place_order";`)).toEqual(["an order operation"]);
    expect(violations(`const note = "a note for you, not an order";`)).toEqual([]);
  });
});

describe("rule 27 — a reorder note records intent only", () => {
  it("is a note kind, outside the kinds a classifier or review can emit", () => {
    expect(NOTE_KINDS).toContain(REORDER_KIND);
    expect((ACTION_KINDS as readonly string[]).includes(REORDER_KIND)).toBe(false);
  });

  it("no execution provider declares an order or a supplier operation but sending an approved purchase order (rule 27 amended)", () => {
    const ops = Object.entries(EXECUTION_SCOPE_REGISTRY).flatMap(([provider, p]) =>
      p.operations.map((o) => ({ provider, op: o.op as string, reversible: o.reversible })),
    );
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.filter((o) => /order|supplier|purchase|stock|inventory/i.test(o.op))).toEqual([
      { provider: "purchase_order", op: "send_purchase_order", reversible: false },
    ]);
  });

  it("a plan planted in a stock proposal's detail is never run", () => {
    expect(Object.hasOwn(PREBOUND_ALLOWED, "stock")).toBe(false);
    const planted = {
      module: "stock",
      action: {
        kind: REORDER_KIND,
        detail: { execution: { provider: "fixture", op: "set_value", params: {} } },
      },
    };
    expect(preboundPlan(planted)).toBeNull();
    // The same plan under the one module the allow-list admits is a plan:
    // the refusal is about the module, not a malformed plan.
    expect(preboundPlan({ ...planted, module: "diagnosis" })).not.toBeNull();
  });

  it("passes through the hard-limit check: manual limits ride along", () => {
    const verdict = checkHardLimits(
      [
        { code: "no_discounts", quote: "We never discount.", enforcement: "auto" },
        { code: "other", quote: "Ask me before big orders.", enforcement: "manual" },
      ],
      REORDER_KIND,
    );
    expect(verdict.verdict).toBe("pass");
    expect(verdict.manual.map((l) => l.quote)).toEqual(["Ask me before big orders."]);
  });
});
