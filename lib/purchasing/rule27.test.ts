// Rule 27 amended (2026-11-08) — "a purchase order goes out only on a recorded
// yes … SYB never edits, cancels or pays an order, and never signs in to a
// supplier's system." The build-failing half, by reading the source:
//   · the registry holds ONE supplier operation, send_purchase_order, and it
//     is irreversible; no op anywhere edits, cancels, pays or signs in;
//   · the one network call is the POST to the email service's send endpoint,
//     made from one place, inside the provider's execute, after the stop;
//   · nothing outside the engine calls the provider's execute, and the
//     owner's "Send now" goes through executeProposal;
//   · lib/purchasing reaches no network and names no supplier system;
//   · no plan carried in a proposal's detail can run it (PREBOUND_ALLOWED).
// Each scanner has its failing case beside it: a planted line is caught.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PREBOUND_ALLOWED } from "../execution/due";
import { EXECUTION_SCOPE_REGISTRY } from "../execution/scopes";

const ROOT = process.cwd();
const PROVIDER = path.join(ROOT, "lib/execution/providers/purchase-order.ts");
const DIR = path.join(ROOT, "lib/purchasing");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const SOURCES = ["app", "lib", "components", "scripts"].flatMap((d) =>
  sourceFiles(path.join(ROOT, d)),
);

/** What no order code may do: act on an order beyond sending it, pay, or sign in anywhere. */
const FORBIDDEN_OP = /cancel|edit|update|amend|delete|pay|refund|charge|login|sign_?in|auth/i;

/** What lib/purchasing must never contain: a way out, or a supplier system. */
const PURCHASING_FORBIDDEN: readonly [RegExp, string][] = [
  [/\bfetch\s*\(/, "a network call"],
  [/\bhttps?:\/\//, "a URL"],
  [/\b(password|oauth|access_token|sign_?in_to)\b/i, "a sign-in"],
  [/\b(cancel|edit|pay)_?(purchase_)?order\b/i, "an order operation beyond sending"],
];
const purchasingViolations = (src: string) =>
  PURCHASING_FORBIDDEN.filter(([re]) => re.test(src)).map(([, what]) => what);

describe("rule 27 amended — the registry", () => {
  it("one supplier operation exists: sending an approved purchase order, irreversible", () => {
    expect(EXECUTION_SCOPE_REGISTRY.purchase_order.operations).toEqual([
      expect.objectContaining({ op: "send_purchase_order", reversible: false }),
    ]);
    expect(EXECUTION_SCOPE_REGISTRY.purchase_order.write_scopes).toEqual([
      "email.send_purchase_order",
    ]);
    expect(EXECUTION_SCOPE_REGISTRY.purchase_order.readback_scopes).toEqual([]);
  });

  it("no provider declares an op that edits, cancels or pays an order, or signs in", () => {
    const ops = Object.values(EXECUTION_SCOPE_REGISTRY).flatMap((p) =>
      p.operations.map((o) => o.op as string),
    );
    expect(
      ops.filter((op) => /order|supplier|purchase/i.test(op) && FORBIDDEN_OP.test(op)),
    ).toEqual([]);
    expect(FORBIDDEN_OP.test("cancel_purchase_order")).toBe(true);
    expect(FORBIDDEN_OP.test("send_purchase_order")).toBe(false);
  });

  it("no plan carried in a proposal can run it", () => {
    for (const entry of Object.values(PREBOUND_ALLOWED)) {
      expect(entry.provider).not.toBe("purchase_order");
    }
    expect(Object.hasOwn(PREBOUND_ALLOWED, "stock")).toBe(false);
  });
});

describe("rule 27 amended — the one way out", () => {
  const src = readFileSync(PROVIDER, "utf8");

  it("the provider names one URL: the email service's send endpoint", () => {
    expect([...src.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0])).toEqual([
      "https://api.resend.com/emails",
    ]);
    expect([...src.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1])).toEqual(["POST"]);
  });

  it("sendPurchaseOrderEmail is called from one place: inside execute, after the stop is checked", () => {
    const sites = SOURCES.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return [...text.matchAll(/\bsendPurchaseOrderEmail\(/g)]
        .filter((m) => !/function\s+$/.test(text.slice(Math.max(0, m.index - 16), m.index)))
        .map(() => rel(f));
    });
    expect(sites).toEqual(["lib/execution/providers/purchase-order.ts"]);
    const execute = src.indexOf("async execute(op, params, ctx)");
    const call = src.indexOf("await sendPurchaseOrderEmail(");
    expect(execute).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(execute);
    expect(call).toBeGreaterThan(src.indexOf("ctx.halted && (await ctx.halted())", execute));
    // The fake sender returns before the real one is ever reached.
    expect(call).toBeGreaterThan(src.indexOf('if (now.mode === "fake")', execute));
  });

  it("nothing outside the engine calls the provider's execute; Send now goes through executeProposal", () => {
    const offenders = SOURCES.filter((f) =>
      /purchaseOrderExecutor\.execute\(|createPurchaseOrderExecutor\([^)]*\)\.execute\(/.test(
        readFileSync(f, "utf8"),
      ),
    ).map(rel);
    expect(offenders).toEqual([]);
    const send = readFileSync(path.join(DIR, "send.ts"), "utf8");
    const fn = send.slice(send.indexOf("export async function sendPurchaseOrderNow("));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain("executeProposal(");
  });
});

describe("rule 27 amended — lib/purchasing reaches nothing outside SYB", () => {
  const files = sourceFiles(DIR).map((f) => ({ file: rel(f), text: readFileSync(f, "utf8") }));

  it("scans every purchasing source file", () => {
    expect(files.map((f) => f.file)).toEqual(
      expect.arrayContaining([
        "lib/purchasing/po.ts",
        "lib/purchasing/propose.ts",
        "lib/purchasing/send.ts",
      ]),
    );
  });

  it("no network call, no URL, no sign-in, no order operation beyond sending", () => {
    for (const f of files) {
      expect({ file: f.file, found: purchasingViolations(f.text) }).toEqual({
        file: f.file,
        found: [],
      });
    }
  });

  it("the scanner catches what it is for", () => {
    expect(purchasingViolations(`await fetch("https://supplier.example/api")`)).toEqual([
      "a network call",
      "a URL",
    ]);
    expect(purchasingViolations("const op = 'cancel_order';")).toEqual([
      "an order operation beyond sending",
    ]);
    expect(purchasingViolations("const t = { password: 'x' };")).toEqual(["a sign-in"]);
    expect(purchasingViolations("emails an approved purchase order")).toEqual([]);
  });
});
