// Rule 26's build gate, widened (amended 2026-11-08, P6-05): money is
// prepared, never moved. Beside lib/cash/fence.test.ts and rule 18's money
// fence (lib/execution/scopes.test.ts), this reads every source file of
// prepared payments — lib/payments, its API routes, its screen — and fails
// the build if any of them:
//
//   · holds a bank credential field (a password, PIN, TAN, one-time code,
//     client secret, access or refresh token, API key, login) — SYB never
//     signs in to a bank;
//   · names a payment-initiation scope (PSD2's PIS, open banking, a
//     write-shaped payment or transfer scope);
//   · names a transfer endpoint (a path to payouts, transfers, payment
//     initiation or a bank's API), or a money-moving operation joined in
//     an identifier (sendPayment, initiate_transfer, pay(…));
//   · reaches the network (fetch to anything but its own /api/payments,
//     an http module, a URL);
//   · imports the execution engine, a connector's provider module, or the
//     billing checkout (the only code that talks to a payment provider).
//
// And neither registry has a provider for a bank or a payment initiator,
// and the due runner routes nothing of the payments module. Each check has
// a planted failing case below, so the scanner can't pass by being blind.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCOPE_REGISTRY, auditRegistry, isWriteCapable } from "../connectors/scopes";
import { EXECUTION_SCOPE_REGISTRY, auditExecutionRegistry } from "../execution/scopes";

/** Every file prepared payments are made of. A new one under these roots is read automatically. */
const ROOTS = ["lib/payments", "app/api/payments", "app/payments", "components/payments"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

export interface PaymentFenceViolation {
  file: string;
  rule: "credential" | "initiation_scope" | "endpoint" | "money_op" | "network" | "import";
  match: string;
}

/**
 * A bank credential, as an identifier, a key or a quoted name. The long,
 * distinctive words are caught inside a longer identifier (bankPassword);
 * the short ones only as whole words (so "pinned" is not a PIN).
 */
const CREDENTIAL =
  /\b\w*(?:password|passwd|passcode|client_?secret|access_?token|refresh_?token|api_?key|private_?key|secret_?key|credentials?)\w*\b|\b(?:pin|pin_?code|tan|otp|one_?time_?code|bearer|login|username)\b/gi;
/** PSD2 payment initiation, open banking, or a write-shaped payment scope ("write:payments"). */
const INITIATION =
  /payment[_ .:-]?initiation|\bpisp?\b|\bpsd2\b|open[_ -]?banking|initiate[_ .:-]?(?:payment|transfer)|\b(?:write|create|send|submit|execute)[_.:-](?:payments?|transfers?|payouts?)\b|\b(?:payments?|transfers?|payouts?)[_.:-](?:write|create|send|submit|execute)\b/gi;
/** A path a transfer is made through. */
const ENDPOINT =
  /["'`][^"'`]*\/(?:v\d+\/)?(?:payouts?|transfers?|payment[-_]?initiations?|pis|sepa[-_]?credit[-_]?transfers?|instructions\/execute)\b[^"'`]*["'`]/gi;
const MOVE =
  "pay|send|transfer|move|make|create|initiate|execute|schedule|submit|issue|collect|withdraw|deposit|refund|charge|settle|place|release|top_?up|wire|remit|dispatch";
const MONEY =
  "payment|payout|transfer|invoice|refund|charge|money|funds|cash|deposit|withdrawal|card|sepa|iban";
const MONEY_OP = new RegExp(`\\b(?:${MOVE})\\w*?(?:${MONEY})\\w*`, "gi");
const BARE_PAY = /\b(?:payNow|pay_now|pay|wire|remit)\s*\(/g;
/** The screen may fetch its own API, and nothing else. */
const NETWORK =
  /\bfetch\s*\((?!\s*[`"']\/api\/payments\b)|from\s+["'](?:node:)?(?:https?|net|tls|dgram|undici|axios|node-fetch)["']|\bnew\s+XMLHttpRequest\b|https?:\/\//g;
const IMPORTS =
  /from\s+["']([^"']*(?:\/execution(?:\/|["'])|connectors\/providers|\/billing(?:\/|["'])|checkout|stripe)[^"']*)["']/g;

/**
 * Pure: the source without its comments — prose saying what SYB never does
 * ("no bank credential exists here") is not a field. A `//` right after a
 * colon or inside a quote ("https://…") is not a comment and stays.
 */
export function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

/** Pure: every fence violation in one source text. */
export function auditPaymentsSource(file: string, source: string): PaymentFenceViolation[] {
  const text = withoutComments(source);
  const v: PaymentFenceViolation[] = [];
  const all = (re: RegExp, rule: PaymentFenceViolation["rule"], group = 0) => {
    for (const m of text.matchAll(re)) v.push({ file, rule, match: m[group] ?? m[0] });
  };
  all(CREDENTIAL, "credential");
  all(INITIATION, "initiation_scope");
  all(ENDPOINT, "endpoint");
  for (const m of text.matchAll(MONEY_OP)) {
    if (/\s/.test(m[0])) continue;
    const verb = new RegExp(`^(?:${MOVE})`, "i").exec(m[0])?.[0] ?? "";
    const joint = m[0].charAt(verb.length);
    if (joint === "_" || /[A-Z]/.test(joint)) v.push({ file, rule: "money_op", match: m[0] });
  }
  all(BARE_PAY, "money_op");
  all(NETWORK, "network");
  all(IMPORTS, "import", 1);
  return v;
}

const files = () => ROOTS.flatMap(walk);

describe("rule 26 (amended) — THE BUILD GATE: prepared payments can't move money", () => {
  it("reads every file of it (the scan is not blind)", () => {
    const list = files().map((f) => f.replace(/\\/g, "/"));
    for (const must of [
      "lib/payments/iban.ts",
      "lib/payments/sepa.ts",
      "lib/payments/store.ts",
      "lib/payments/instructions.ts",
      "app/api/payments/route.ts",
      "app/api/payments/file/route.ts",
      "app/payments/page.tsx",
      "components/payments/PaymentsScreen.tsx",
      "components/payments/payments-view.ts",
    ]) {
      expect(list).toContain(must);
    }
    // SYB's own report billing (Stripe Checkout) lives in lib/billing, not here.
    expect(list.some((f) => /stripe|checkout/i.test(f))).toBe(false);
  });

  it("zero violations: no credential, no initiation scope, no transfer endpoint, no money op, no network, no provider", () => {
    const violations = files().flatMap((f) => auditPaymentsSource(f, readFileSync(f, "utf8")));
    expect(violations).toEqual([]);
  });

  it("the routes download and record, nothing else: GET and POST to its own API only", () => {
    for (const f of files().filter((x) => /route\.ts$/.test(x))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(
        /export\s+(?:async\s+)?(?:function|const)\s+(?:PUT|PATCH|DELETE)\b/,
      );
    }
  });

  it("no provider for a bank or a payment initiator exists, on either side, and both registries still pass", () => {
    const fenced =
      /bank|ledger|xero|quickbooks|sage|freeagent|wise|revolut|plaid|truelayer|gocardless|tink|yapily|nordigen|saltedge|adyen|mollie|paypal|sepa|payment|payout|transfer/i;
    expect(Object.keys(EXECUTION_SCOPE_REGISTRY).filter((p) => fenced.test(p))).toEqual([]);
    expect(Object.keys(SCOPE_REGISTRY).filter((p) => fenced.test(p))).toEqual([]);
    expect(auditRegistry()).toEqual([]);
    expect(auditExecutionRegistry(EXECUTION_SCOPE_REGISTRY, isWriteCapable)).toEqual([]);
  });

  it("the execution engine and the due runner know nothing of payments", () => {
    for (const f of walk("lib/execution")) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/from\s+["'][^"']*\/payments(?:\/|["'])/);
      expect(text, f).not.toMatch(/["']prepared_payment["']|PAYMENTS_MODULE/);
    }
  });
});

describe("rule 26 (amended) — the scanner catches each thing it fences, planted deliberately", () => {
  const rules = (text: string) =>
    auditPaymentsSource("planted.ts", text).map((x) => `${x.rule}:${x.match}`);

  it("a bank credential field", () => {
    expect(rules("const bankPassword = row.password;")).toEqual([
      "credential:bankPassword",
      "credential:password",
    ]);
    expect(rules('{ "access_token": t, tan: "123456" }')).toEqual([
      "credential:access_token",
      "credential:tan",
    ]);
    expect(rules("interface Login { username: string; client_secret: string }")).toEqual([
      "credential:Login",
      "credential:username",
      "credential:client_secret",
    ]);
    // An IBAN or a BIC is not a credential; nor is the word "pinned".
    expect(rules("const iban = x.iban; const bic = x.bic; const pinned = 1;")).toEqual([]);
  });

  it("a payment-initiation scope", () => {
    expect(rules('const scopes = ["payment_initiation"];')).toEqual([
      "initiation_scope:payment_initiation",
    ]);
    expect(rules('scope: "PIS"')).toEqual(["initiation_scope:PIS"]);
    expect(rules('scope: "write:payments"')).toEqual(["initiation_scope:write:payments"]);
    expect(rules('const consent = "open_banking";')).toEqual(["initiation_scope:open_banking"]);
    // Prose in a comment is not a scope or a field.
    expect(rules("// no open banking, no PIS scope, no bank credential")).toEqual([]);
  });

  it("a transfer endpoint, and a money-moving operation", () => {
    expect(rules('const url = "/v1/payouts";')).toEqual(['endpoint:"/v1/payouts"']);
    expect(rules("post(`${base}/payment-initiations/sepa`)")).toEqual([
      "initiation_scope:payment-initiation",
      "endpoint:`${base}/payment-initiations/sepa`",
    ]);
    expect(rules("await sendPayment(p); initiate_transfer(x); pay(y);")).toEqual([
      "initiation_scope:initiate_transfer",
      "money_op:sendPayment",
      "money_op:initiate_transfer",
      "money_op:pay(",
    ]);
    // Prose and nouns are not operations; preparing and marking paid are not moving money.
    expect(
      rules("// SYB never pays or transfers money. preparedPayments; markPaidInBank();"),
    ).toEqual([]);
  });

  it("the network, and an import of the engine, a provider or the checkout", () => {
    expect(rules('await fetch("https://api.bank.example/transfers")')).toEqual([
      'endpoint:"https://api.bank.example/transfers"',
      "network:fetch(",
      "network:https://",
    ]);
    expect(rules("await fetch(url)")).toEqual(["network:fetch("]);
    expect(rules('await fetch("/api/payments")')).toEqual([]);
    expect(rules('import { request } from "node:https";')).toEqual(['network:from "node:https"']);
    expect(rules('import { executeProposal } from "../execution/engine";')).toEqual([
      "import:../execution/engine",
    ]);
    expect(rules('import { x } from "../connectors/providers/stripe";')).toEqual([
      "import:../connectors/providers/stripe",
    ]);
    expect(rules('import { reportPrice } from "../billing/stripe";')).toEqual([
      "import:../billing/stripe",
    ]);
  });
});
