// Rule 26's build-failing test (P5-10): finance is read and modelled, never
// moved. Beside rule 18's money fence (lib/execution/scopes.test.ts), this
// reads every source file of the cash forecast — lib/cash, its API route,
// its screen and its chart — and fails the build if any of them:
//
//   · exports an HTTP verb other than GET (no action path at all);
//   · names a money-moving operation (pay, send, transfer, create, issue,
//     collect, refund, charge, … joined to a payment, payout, transfer,
//     invoice, refund, charge, money, funds or cash);
//   · imports the execution engine, the payment checkout, or a connector's
//     provider module (the only code that talks to a payment provider);
//   · reaches the network (fetch, an http module, a URL);
//   · writes to the database (lib/cash reads; the watch log's one row is
//     lib/watch/job.ts's, beside the trading-hours findings);
//   · carries a write-shaped scope string, by the measurement audit's own
//     vocabulary.
//
// And no execution or measurement provider exists for a bank or an
// accounting system. Each check has a planted failing case below, so the
// scanner can't pass by being blind.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCOPE_REGISTRY, auditRegistry, isWriteCapable } from "../connectors/scopes";
import {
  EXECUTION_SCOPE_REGISTRY,
  auditExecutionRegistry,
  touchesMoneySurface,
} from "../execution/scopes";

/** Every file the cash forecast is made of. A new one under these roots is read automatically. */
const ROOTS = ["lib/cash", "app/api/cash", "app/cash", "components/cash"];
const EXTRA = ["components/charts/CashChart.tsx"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

export interface FenceViolation {
  file: string;
  rule: "verb" | "money_op" | "import" | "network" | "db_write" | "scope";
  match: string;
}

const VERBS = /export\s+(?:async\s+)?(?:function|const)\s+(POST|PUT|PATCH|DELETE)\b/g;
const MOVE =
  "pay|send|transfer|move|make|create|initiate|execute|schedule|submit|issue|collect|withdraw|deposit|refund|charge|settle|place|release|top_?up";
const MONEY =
  "payment|payout|transfer|invoice|refund|charge|money|funds|cash|deposit|withdrawal|card";
/** camelCase or snake_case: a verb joined to a money noun, e.g. createPayout, send_payment. */
const MONEY_OP = new RegExp(`\\b(?:${MOVE})\\w*?(?:${MONEY})\\w*`, "gi");
const BARE_PAY = /\b(?:payNow|pay_now|pay)\s*\(/g;
const IMPORTS =
  /from\s+["']([^"']*(?:\/execution(?:\/|["'])|\/payments(?:\/|["'])|connectors\/providers|checkout|stripe)[^"']*)["']/g;
/** The screen may fetch its own read endpoint, and nothing else. */
const NETWORK =
  /\bfetch\s*\((?!\s*[`"']\/api\/cash\b)|from\s+["'](?:node:)?(?:https?|net|tls|dgram)["']|https?:\/\//g;
const CLIENT_VERB = /method:\s*["'](POST|PUT|PATCH|DELETE)["']/g;
const DB_WRITE =
  /\.(?:insert|update|delete)\s*\(|\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/g;
const STRINGS = /["'`]([a-z0-9_.:/*-]{3,})["'`]/g;

/** Pure: every fence violation in one source text. */
export function auditSource(
  file: string,
  text: string,
  opts: { dbWrites: boolean },
): FenceViolation[] {
  const v: FenceViolation[] = [];
  const all = (re: RegExp, rule: FenceViolation["rule"], group = 0) => {
    for (const m of text.matchAll(re)) v.push({ file, rule, match: m[group] ?? m[0] });
  };
  all(VERBS, "verb", 1);
  all(CLIENT_VERB, "verb", 1);
  // Money ops: the camel/snake form only, so prose in comments ("never pays or transfers") is fine.
  for (const m of text.matchAll(MONEY_OP)) {
    // A case-insensitive match must still be a joined identifier, not two words.
    if (/\s/.test(m[0])) continue;
    const verb = new RegExp(`^(?:${MOVE})`, "i").exec(m[0])?.[0] ?? "";
    const joint = m[0].charAt(verb.length);
    if (joint === "_" || /[A-Z]/.test(joint)) v.push({ file, rule: "money_op", match: m[0] });
  }
  all(BARE_PAY, "money_op");
  all(IMPORTS, "import", 1);
  all(NETWORK, "network");
  if (opts.dbWrites) all(DB_WRITE, "db_write");
  for (const m of text.matchAll(STRINGS)) {
    const s = m[1]!;
    if (isWriteCapable(s)) v.push({ file, rule: "scope", match: s });
  }
  return v;
}

const files = () => [...ROOTS.flatMap(walk), ...EXTRA];

describe("rule 26 — THE BUILD GATE: nothing in the cash forecast can move money", () => {
  it("reads every file of it (the scan is not blind)", () => {
    const list = files().map((f) => f.replace(/\\/g, "/"));
    for (const must of [
      "lib/cash/model.ts",
      "lib/cash/load.ts",
      "lib/cash/warnings.ts",
      "lib/cash/scenarios.ts",
      "lib/cash/payout.ts",
      "app/api/cash/route.ts",
      "app/cash/page.tsx",
      "components/cash/CashScreen.tsx",
      "components/charts/CashChart.tsx",
    ]) {
      expect(list).toContain(must);
    }
  });

  it("zero violations: no verb but GET, no money op, no engine or provider import, no network, no write, no write scope", () => {
    const violations = files().flatMap((f) =>
      auditSource(f, readFileSync(f, "utf8"), {
        dbWrites: f.replace(/\\/g, "/").startsWith("lib/cash/"),
      }),
    );
    expect(violations).toEqual([]);
  });

  it("no provider for a bank or an accounting system exists, on either side, and both registries still pass", () => {
    const fenced =
      /bank|ledger|account|xero|quickbooks|sage|freeagent|wise|revolut|plaid|truelayer|gocardless|cash/i;
    expect(Object.keys(EXECUTION_SCOPE_REGISTRY).filter((p) => fenced.test(p))).toEqual([]);
    expect(Object.keys(SCOPE_REGISTRY).filter((p) => fenced.test(p))).toEqual([]);
    expect(auditRegistry()).toEqual([]);
    expect(auditExecutionRegistry(EXECUTION_SCOPE_REGISTRY, isWriteCapable)).toEqual([]);
  });
});

describe("rule 26 — the scanner catches each thing it fences, planted deliberately", () => {
  const rules = (text: string, dbWrites = true) =>
    auditSource("planted.ts", text, { dbWrites }).map((x) => `${x.rule}:${x.match}`);

  it("an action verb on the route", () => {
    expect(rules("export async function POST(req) {}")).toEqual(["verb:POST"]);
    expect(rules("export const DELETE = handler;")).toEqual(["verb:DELETE"]);
    expect(rules("export async function GET() {}")).toEqual([]);
  });

  it("a money-moving operation, camelCase or snake_case", () => {
    expect(rules("await createPayout(account);")).toEqual(["money_op:createPayout"]);
    // As an op name and as a write-shaped scope string: caught twice.
    expect(rules('const op = { op: "send_payment" };')).toEqual([
      "money_op:send_payment",
      "scope:send_payment",
    ]);
    expect(rules("transferFunds(a, b); issueInvoice(c); pay(x);")).toEqual([
      "money_op:transferFunds",
      "money_op:issueInvoice",
      "money_op:pay(",
    ]);
    // Prose and nouns are not operations.
    expect(
      rules("// ScaleX never pays, transfers or collects money; payout timing is read."),
    ).toEqual([]);
    expect(rules("export function payoutFor() {}")).toEqual([]);
  });

  it("an import of the engine, the checkout or a provider module", () => {
    expect(rules('import { execute } from "../execution/engine";')).toEqual([
      "import:../execution/engine",
    ]);
    expect(rules('import { checkout } from "../payments/checkout";')).toEqual([
      "import:../payments/checkout",
    ]);
    expect(rules('import { stripeGet } from "../connectors/providers/stripe";')).toEqual([
      "import:../connectors/providers/stripe",
    ]);
    expect(rules('import { MONEY_METRICS } from "../connectors/provider";')).toEqual([]);
  });

  it("the network, a database write, a write-shaped scope", () => {
    expect(rules('await fetch("https://api.stripe.com/v1/payouts")')).toEqual([
      "network:fetch(",
      "network:https://",
    ]);
    expect(rules("await fetch(url)")).toEqual(["network:fetch("]);
    expect(rules("await fetch(`/api/cash?${q}`)")).toEqual([]);
    expect(rules('fetch("/api/cash", { method: "POST" })')).toEqual(["verb:POST"]);
    expect(rules("await db.insert(rows).values(x)")).toEqual(["db_write:.insert("]);
    expect(rules("await db.insert(rows)", false)).toEqual([]);
    expect(rules('const scopes = ["write_payments"];')).toEqual(["scope:write_payments"]);
    expect(touchesMoneySurface("write_payments")).toBe(true);
  });
});
