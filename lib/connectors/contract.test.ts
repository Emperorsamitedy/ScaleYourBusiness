// The uniform connector contract — the v1 build spec §11.1, Phase 0's gate:
// "a Stripe connector and a bank-statement parser both produce normalised
// events with grades attached" — and §11.5's "a connector can be added
// without changes to the diagnosis, ledger or ladder code".

import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Connector, NormalisedEvent } from "./contract";
import {
  BANK_STATEMENT_CONNECTOR,
  CONNECTOR_READS,
  bankStatementConnector,
  fromProvider,
  normalise,
  scopesNeeded,
} from "./contract";
import { fixtureProvider, FIXTURE_FAILING_SECRET, FIXTURE_SECRET } from "./providers/fixture";
import { createStripeProvider } from "./providers/stripe";
import { FAKE_STRIPE_KEY, fakeStripe, txn } from "./providers/stripe-fake";
import { SCOPE_REGISTRY } from "./scopes";

const NOW = new Date("2026-09-14T12:00:00Z");

function stripeConnector(ledger = [txn("2026-09-10T10:00:00Z", 12_000)], key = FAKE_STRIPE_KEY) {
  const fake = fakeStripe(ledger);
  const provider = createStripeProvider({ fetch: fake.fetch, sleep: async () => {} });
  return { connector: fromProvider(provider, { secret: key, now: () => NOW }), fake };
}

const STATEMENT = [
  "Date,Description,Amount,Balance",
  "2026-09-01,Card sale,100.00,1000.00",
  "2026-09-02,Rent,-400.00,600.00",
  "2026-09-04,Card sale,50.50,650.50",
].join("\n");

function expectContract(c: Connector): void {
  for (const m of ["authorize", "health", "pull", "capabilities", "cost_model"] as const) {
    expect(typeof c[m], m).toBe("function");
  }
  // Measuring connectors are read-only forever (rule 9): no push at all.
  expect(c.push).toBeUndefined();
}

function expectGraded(events: NormalisedEvent[]): void {
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) {
    expect(e.grade).toBe("B");
    expect(e.source).toBe("measured");
    expect(e.source_detail.length).toBeGreaterThan(0);
    expect((e.amount === null) !== (e.quantity === null)).toBe(true);
    if (e.amount) expect(Number.isSafeInteger(e.amount.amount_minor)).toBe(true);
  }
}

describe("PHASE 0 GATE — Stripe and a bank statement both produce graded normalised events", () => {
  it("Stripe: revenue and orders, B, in one schema", async () => {
    const { connector } = stripeConnector();
    expectContract(connector);
    expect(await connector.authorize()).toEqual({
      ok: true,
      scopes_held: ["read_balance_transactions"],
    });
    const events = await connector.pull("2026-09-01");
    expectGraded(events);
    const revenue = events.find((e) => e.metric === "revenue.daily" && e.day === "2026-09-10");
    expect(revenue?.amount).toEqual({ amount_minor: 12_000, currency: "EUR" });
    expect(revenue?.source_detail).toBe("Stripe, 2026-09-10");
    expect(events.every((e) => e.day >= "2026-09-01")).toBe(true);
  });

  it("a bank statement: closing balances, B, in the same schema", async () => {
    const c = bankStatementConnector(STATEMENT, { currency: "EUR", now: () => NOW });
    expectContract(c);
    expect(c.id).toBe(BANK_STATEMENT_CONNECTOR);
    expect(await c.authorize()).toEqual({ ok: true, scopes_held: [] });
    const events = await c.pull("2026-09-02");
    expectGraded(events);
    const balances = events.filter((e) => e.metric === "cash.balance");
    expect(balances.map((e) => [e.day, e.amount?.amount_minor])).toEqual([
      ["2026-09-02", 60_000],
      ["2026-09-03", 60_000],
      ["2026-09-04", 65_050],
    ]);
    // D52: the statement's money in, in the same schema, beside the balances.
    const moneyIn = events.filter((e) => e.metric === "cash.money_in.daily");
    expect(moneyIn.map((e) => e.day)).toEqual(["2026-09-02", "2026-09-03", "2026-09-04"]);
    expect(moneyIn.find((e) => e.day === "2026-09-04")?.amount?.amount_minor).toBe(5_050);
    expect(events[0]?.metric).toBe("cash.balance");
    expect(events[0]?.source_detail).toBe("Bank statement, 2026-09-01 to 2026-09-04");
  });

  it("the two are indistinguishable by shape — the diagnosis can't tell them apart", async () => {
    const stripe = await stripeConnector().connector.pull("2026-09-01");
    const bank = await bankStatementConnector(STATEMENT, { currency: "EUR", now: () => NOW }).pull(
      "2026-09-01",
    );
    const keys = (e: NormalisedEvent) => Object.keys(e).sort();
    expect(keys(stripe[0]!)).toEqual(keys(bank[0]!));
  });

  it("an event's id is deterministic, so a re-pull is idempotent", async () => {
    const a = await stripeConnector().connector.pull("2026-09-01");
    const b = await stripeConnector().connector.pull("2026-09-01");
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
    expect(new Set(a.map((e) => e.id)).size).toBe(a.length);
  });
});

describe("authorize and health, in plain words", () => {
  it("a wrong Stripe key fails authorize with words, not a status code", async () => {
    const { connector } = stripeConnector([], "rk_test_notTheRightKey");
    const result = await connector.authorize();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toMatch(/\b4\d\d\b|\b5\d\d\b/);
  });

  it("a file that isn't a statement fails authorize and reports itself failed", async () => {
    const c = bankStatementConnector("Date,Amount\n2026-09-01,10", { currency: "EUR" });
    const result = await c.authorize();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/balance/);
    expect((await c.health()).status).toBe("failed");
  });

  it("health reports what it holds and what it needs", async () => {
    const { connector } = stripeConnector();
    await connector.authorize();
    const h = await connector.health();
    expect(h.status).toBe("healthy");
    expect(h.scopes_needed).toEqual(["read_balance_transactions"]);
    expect(h.scopes_held).toEqual(["read_balance_transactions"]);
    expect(h.latency_ms).not.toBeNull();
    expect(h.last_success_at).toBe(NOW.toISOString());
  });

  it("a stored connection's state shows through: failed, disconnected, degraded", async () => {
    const base = {
      granted_scopes: ["read_revenue", "read_orders", "read_ad_spend"],
      last_sync_at: null,
    };
    const make = (status: string, failure_count = 0) =>
      fromProvider(fixtureProvider, {
        secret: FIXTURE_SECRET,
        connection: { ...base, status, failure_count },
      });
    expect((await make("connected").health()).status).toBe("healthy");
    expect((await make("connected", 2).health()).status).toBe("degraded");
    expect((await make("failed").health()).status).toBe("failed");
    expect((await make("disconnected").health()).status).toBe("not_connected");
  });

  it("a failing pull leaves the connector degraded, not blank", async () => {
    const c = fromProvider(fixtureProvider, { secret: FIXTURE_FAILING_SECRET, now: () => NOW });
    await expect(c.pull("2026-09-01")).rejects.toThrow();
    expect((await c.health()).status).toBe("degraded");
  });

  it("optional scopes aren't needed: Shopify works without read_all_orders", () => {
    expect(scopesNeeded("shopify")).not.toContain("read_all_orders");
    expect(scopesNeeded("shopify")).toContain("read_orders");
  });
});

describe("capabilities and cost, as data", () => {
  it("every registered provider declares what it reads and what it costs", () => {
    for (const id of Object.keys(SCOPE_REGISTRY) as (keyof typeof SCOPE_REGISTRY)[]) {
      expect(CONNECTOR_READS[id].length, id).toBeGreaterThan(0);
    }
  });

  it("Stripe's declared reads cover every metric it actually emits", async () => {
    const events = await stripeConnector().connector.pull("2026-09-01");
    const declared = new Set(
      stripeConnector()
        .connector.capabilities()
        .map((c) => "metric" in c && c.metric),
    );
    for (const e of events) expect(declared.has(e.metric), e.metric).toBe(true);
  });

  it("the fixture's declared reads cover every metric it emits", async () => {
    const c = fromProvider(fixtureProvider, { secret: FIXTURE_SECRET, now: () => NOW });
    const declared = new Set(c.capabilities().map((x) => "metric" in x && x.metric));
    for (const e of await c.pull("2026-09-01")) expect(declared.has(e.metric), e.metric).toBe(true);
  });

  it("cost is money, never a bare number (rule 1)", () => {
    const cost = stripeConnector().connector.cost_model();
    expect(cost.per_call).toEqual({ amount_minor: 0, currency: "EUR" });
  });

  it("a money metric without its currency is refused at the boundary", () => {
    expect(() =>
      normalise("x", "X", {
        metric_key: "revenue.daily",
        period_date: "2026-09-01",
        dimensions: {},
        value_minor: 10,
        observed_at: NOW.toISOString(),
      }),
    ).toThrow(/currency/);
  });
});

// §11.5: a connector can be added without touching the diagnosis, ledger or
// ladder — so none of them may know a provider module by name.
const ROOT = path.resolve(__dirname, "../..");
const CORE_DIRS = ["lib/diagnosis", "lib/ledger", "lib/ladder", "lib/figures"];

function sourcesUnder(dir: string): string[] {
  const abs = path.resolve(ROOT, dir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const p = path.join(abs, name);
    if (statSync(p).isDirectory()) out.push(...sourcesUnder(path.relative(ROOT, p)));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("§11.5 — no connector-specific logic in the diagnosis, ledger, ladder or figures", () => {
  it("none of them imports a provider module", () => {
    const offenders = CORE_DIRS.flatMap(sourcesUnder).filter((file) =>
      /from\s+["'][^"']*connectors\/providers\//.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
