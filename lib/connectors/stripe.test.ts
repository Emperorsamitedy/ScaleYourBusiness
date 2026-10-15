// P2-07..09 — the Stripe connector, against a recorded-shape Stripe.
//
// No network and no Stripe account: providers/stripe-fake.ts implements the
// one endpoint the connector calls, with Stripe's documented list
// behaviour. Four groups carry the weight:
//
//   · READ-ONLY, AS FAR AS CAN BE PROVEN. Full-access keys are refused
//     before any request, and every request is a GET to a registered path,
//     checked at runtime, at the type level, and by scanning the module's
//     source. Stripe offers no API to list a restricted key's permissions
//     (owner decision, 2026-09-14), so these are the guarantees rule 9 can
//     actually have.
//   · THE ARITHMETIC. Refunds netted, fees, disputes and payouts excluded,
//     UTC days, currencies kept apart, zero days emitted.
//   · THE BACKFILL AND SYNC CONTRACT. A year read in windows, resumable by
//     cursor, incremental runs re-reading a short tail, busy days handled.
//   · RETRIES ARE CAPPED, and errors never carry the key.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Observation, Provider, PullPage } from "./provider";
import { ProviderError } from "./provider";
import type { StripeRequestInit } from "./providers/stripe";
import {
  STRIPE_API_VERSION,
  STRIPE_BACKFILL_DAYS,
  STRIPE_MAX_ATTEMPTS,
  STRIPE_MAX_PAGES_PER_WINDOW,
  STRIPE_PAGE_LIMIT,
  STRIPE_READ_ENDPOINTS,
  STRIPE_WINDOW_DAYS,
  aggregateDays,
  classifyStripeKey,
  createStripeProvider,
} from "./providers/stripe";
import type { FakeStripe } from "./providers/stripe-fake";
import { FAKE_STRIPE_KEY, fakeStripe, jsonResponse, txn } from "./providers/stripe-fake";
import { PROVIDER_IDS, SCOPE_GUIDE, SCOPE_REGISTRY, auditRegistry } from "./scopes";

const NOW = new Date("2026-09-14T12:00:00Z");

function stripeWith(fake: FakeStripe, sleeps: number[] = []): Provider {
  return createStripeProvider({
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

/** Drive pull() the way the sync runner does, until the provider says it is done. */
async function runToDone(provider: Provider, cursor: string | null = null): Promise<PullPage[]> {
  const pages: PullPage[] = [];
  let at = cursor;
  for (let i = 0; i < 100; i += 1) {
    const page = await provider.pull(FAKE_STRIPE_KEY, at, NOW);
    pages.push(page);
    at = page.cursor;
    if (page.done) break;
  }
  return pages;
}

const revenueOf = (obs: readonly Observation[], currency: string): number =>
  obs
    .filter((o) => o.metric_key === "revenue.daily" && o.dimensions.currency === currency)
    .reduce((sum, o) => sum + (o.value_minor ?? 0), 0);

const ordersOf = (obs: readonly Observation[]): number =>
  obs
    .filter((o) => o.metric_key === "orders.daily")
    .reduce((sum, o) => sum + (o.value_num ?? 0), 0);

const orderDays = (obs: readonly Observation[]): string[] =>
  obs.filter((o) => o.metric_key === "orders.daily").map((o) => o.period_date);

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("P2-07 — only restricted keys", () => {
  it("accepts test and live restricted keys, trimming stray whitespace", () => {
    expect(classifyStripeKey("rk_test_abc")).toBe("restricted_test");
    expect(classifyStripeKey("  rk_live_abc \n")).toBe("restricted_live");
  });

  it("refuses full-access, publishable and unrecognisable keys, saying why", () => {
    expect(() => classifyStripeKey("sk_live_abc")).toThrow(/full-access secret key/);
    expect(() => classifyStripeKey("sk_test_abc")).toThrow(/full-access secret key/);
    expect(() => classifyStripeKey("pk_test_abc")).toThrow(/publishable key/);
    expect(() => classifyStripeKey("hunter2")).toThrow(/rk_test_ or rk_live_/);
  });

  it("refuses a full-access key before sending a single request", async () => {
    const fake = fakeStripe([]);
    const stripe = stripeWith(fake);
    await expect(stripe.connect("sk_live_51Dangerous")).rejects.toThrow(ProviderError);
    await expect(stripe.pull("sk_live_51Dangerous", null, NOW)).rejects.toThrow(ProviderError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("P2-07 — connecting proves the read", () => {
  it("returns the proven capabilities after one small, pinned, authenticated request", async () => {
    const fake = fakeStripe([txn("2026-09-01T10:00:00Z", 1_000)]);
    const result = await stripeWith(fake).connect(FAKE_STRIPE_KEY);

    expect(result.granted_scopes).toEqual(Object.keys(STRIPE_READ_ENDPOINTS));
    expect(result.granted_scopes).toEqual([...SCOPE_REGISTRY.stripe]);
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call?.url.searchParams.get("limit")).toBe("1");
    expect(call?.init.headers["stripe-version"]).toBe(STRIPE_API_VERSION);
    expect(call?.init.headers["authorization"]).toBe(`Bearer ${FAKE_STRIPE_KEY}`);
  });

  it("a key Stripe rejects is reported as not accepted, and the error never repeats the key", async () => {
    const fake = fakeStripe([], undefined, "rk_test_theOtherKey");
    const error = await errorOf(stripeWith(fake).connect(FAKE_STRIPE_KEY));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toMatch(/not accepted/);
    expect(error.message).not.toContain(FAKE_STRIPE_KEY);
  });

  it("a missing permission surfaces Stripe's own message, so the owner knows what to add", async () => {
    const fake = fakeStripe([], () =>
      jsonResponse(403, {
        error: {
          type: "invalid_request_error",
          message:
            "The provided key 'rk_test_***' does not have the required permissions for this endpoint.",
        },
      }),
    );
    const error = await errorOf(stripeWith(fake).connect(FAKE_STRIPE_KEY));
    expect(error.message).toMatch(/missing a read permission/);
    expect(error.message).toContain("Stripe says: The provided key");
    expect(error.message).not.toContain(FAKE_STRIPE_KEY);
  });

  it("a response of the wrong shape is refused rather than half-parsed", async () => {
    const fake = fakeStripe([], () => jsonResponse(200, { object: "list", items: [] }));
    await expect(stripeWith(fake).connect(FAKE_STRIPE_KEY)).rejects.toThrow(
      /unexpected list response/,
    );
  });
});

describe("rule 9 — read-only, as far as it can be proven", () => {
  it("every request across connect, a year's backfill and a daily run is a GET to a registered read", async () => {
    const fake = fakeStripe([
      txn("2025-12-01T10:00:00Z", 4_000),
      txn("2026-09-13T10:00:00Z", 2_000),
    ]);
    const stripe = stripeWith(fake);
    await stripe.connect(FAKE_STRIPE_KEY);
    await runToDone(stripe);
    await stripe.pull(FAKE_STRIPE_KEY, "2026-09-12", NOW);

    const allowed: string[] = Object.values(STRIPE_READ_ENDPOINTS);
    expect(fake.calls.length).toBeGreaterThan(10);
    for (const call of fake.calls) {
      expect(call.init.method).toBe("GET");
      expect(call.url.origin).toBe("https://api.stripe.com");
      expect(allowed).toContain(call.url.pathname);
    }
  });

  it("THE BUILD GATE, type level: the request type admits no verb but GET", () => {
    // @ts-expect-error — if StripeRequestInit.method is ever widened, this line stops erroring and typecheck fails.
    const widened: StripeRequestInit = { method: "POST", headers: {} };
    expect(widened).toBeDefined();
  });

  it("THE BUILD GATE, source level: the connector names no other verb and sets no other method", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./providers/stripe.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    const methods = [...source.matchAll(/method:\s*([^,;\n}]+)/g)].map((m) => m[1]?.trim());
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(['"GET"', "init.method"]).toContain(method);
    }
  });

  it("the endpoint list, the capability registry and the connect guide agree for every provider", () => {
    expect(Object.keys(STRIPE_READ_ENDPOINTS)).toEqual([...SCOPE_REGISTRY.stripe]);
    for (const id of PROVIDER_IDS) {
      expect(SCOPE_GUIDE[id].map((g) => g.scope)).toEqual([...SCOPE_REGISTRY[id]]);
    }
    expect(auditRegistry()).toEqual([]);
  });
});

describe("P2-08 — the arithmetic", () => {
  const start = new Date("2026-09-01T00:00:00Z");
  const end = new Date("2026-09-03T00:00:00Z");
  const obs = aggregateDays(
    [
      txn("2026-09-01T09:00:00Z", 5_000),
      txn("2026-09-01T10:00:00Z", 2_500),
      txn("2026-09-01T11:00:00Z", -1_000, "refund"),
      txn("2026-09-01T12:00:00Z", -500, "partial_capture_reversal"),
      txn("2026-09-01T13:00:00Z", -300, "fee"),
      txn("2026-09-01T14:00:00Z", -2_500, "dispute"),
      txn("2026-09-01T15:00:00Z", -9_000, "payout"),
      txn("2026-09-01T23:59:59Z", 700), // the last second of the 1st, in UTC
      txn("2026-09-02T00:00:00Z", 4_000, "charge", "usd"), // the first second of the 2nd
      txn("2026-09-03T08:00:00Z", 0), // a zero charge is not an order
      txn("2026-08-31T23:59:59Z", 99_999), // before the window
      txn("2026-09-04T00:00:00Z", 99_999), // after the window
    ],
    start,
    end,
    NOW.toISOString(),
  );

  const find = (metric: string, day: string, currency?: string) =>
    obs.find(
      (o) => o.metric_key === metric && o.period_date === day && o.dimensions.currency === currency,
    );

  it("nets refunds and partial-capture reversals, and ignores fees, disputes and payouts", () => {
    expect(find("revenue.daily", "2026-09-01", "EUR")?.value_minor).toBe(
      5_000 + 2_500 - 1_000 - 500 + 700,
    );
  });

  it("counts positive charges as orders, and nothing else", () => {
    expect(find("orders.daily", "2026-09-01")?.value_num).toBe(3);
    expect(find("orders.daily", "2026-09-02")?.value_num).toBe(1);
    expect(find("orders.daily", "2026-09-03")?.value_num).toBe(0);
  });

  it("buckets by UTC day and keeps currencies apart, uppercase (rule 1)", () => {
    expect(find("revenue.daily", "2026-09-02", "USD")?.value_minor).toBe(4_000);
    expect(find("revenue.daily", "2026-09-02", "EUR")?.value_minor).toBe(0);
    expect(find("revenue.daily", "2026-09-01", "USD")?.value_minor).toBe(0);
    expect(obs.some((o) => o.dimensions.currency === "eur")).toBe(false);
  });

  it("emits zero days, so a quiet day reads as zero rather than a gap", () => {
    expect(orderDays(obs)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(find("revenue.daily", "2026-09-03", "EUR")?.value_minor).toBe(0);
    // three days × (two currencies + one order count)
    expect(obs.filter((o) => o.metric_key.endsWith(".daily"))).toHaveLength(9);
  });

  // P2-27: the same transactions per UTC hour, stored as an exact instant.
  const hourly = (metric: string, day: string, hour: string, currency?: string) =>
    obs.find(
      (o) =>
        o.metric_key === metric &&
        o.period_date === day &&
        o.dimensions.hour_utc === hour &&
        o.dimensions.currency === currency,
    );

  it("buckets revenue by UTC hour with the same netting, currencies apart", () => {
    expect(hourly("revenue.hourly", "2026-09-01", "09", "EUR")?.value_minor).toBe(5_000);
    expect(hourly("revenue.hourly", "2026-09-01", "11", "EUR")?.value_minor).toBe(-1_000);
    expect(hourly("revenue.hourly", "2026-09-01", "23", "EUR")?.value_minor).toBe(700);
    expect(hourly("revenue.hourly", "2026-09-02", "00", "USD")?.value_minor).toBe(4_000);
    // Fees, disputes and payouts are not revenue in any hour.
    for (const h of ["13", "14", "15"]) {
      expect(hourly("revenue.hourly", "2026-09-01", h, "EUR")).toBeUndefined();
    }
    // The hourly rows sum to the day.
    const sum = obs
      .filter(
        (o) =>
          o.metric_key === "revenue.hourly" &&
          o.period_date === "2026-09-01" &&
          o.dimensions.currency === "EUR",
      )
      .reduce((s, o) => s + (o.value_minor ?? 0), 0);
    expect(sum).toBe(find("revenue.daily", "2026-09-01", "EUR")?.value_minor);
  });

  it("emits only hours where something happened; orders per hour count positive charges", () => {
    expect(hourly("orders.hourly", "2026-09-01", "09")?.value_num).toBe(1);
    expect(hourly("orders.hourly", "2026-09-01", "11")).toBeUndefined(); // a refund is not an order
    expect(hourly("orders.hourly", "2026-09-03", "08")).toBeUndefined(); // a zero charge is not one either
    expect(hourly("revenue.hourly", "2026-09-03", "08", "EUR")).toBeUndefined(); // nets to nothing
    expect(obs.filter((o) => o.metric_key === "orders.hourly")).toHaveLength(4);
  });
});

describe("P2-08 — the year's backfill", () => {
  it("reads 365 days in 30-day windows, oldest first, and never reads today", async () => {
    const busyDay = Array.from({ length: 250 }, (_, i) =>
      txn(
        `2026-03-15T${String(i % 24).padStart(2, "0")}:${String(Math.floor(i / 24)).padStart(2, "0")}:00Z`,
        1_000,
      ),
    );
    const fake = fakeStripe([
      txn("2025-09-01T10:00:00Z", 99_999), // more than a year ago
      txn("2025-10-01T10:00:00Z", 10_000),
      ...busyDay,
      txn("2026-09-13T23:30:00Z", 5_000),
      txn("2026-09-13T23:31:00Z", -2_000, "refund"),
      txn("2026-09-14T01:00:00Z", 77_777), // today, still being written
    ]);

    const pages = await runToDone(stripeWith(fake));

    expect(pages).toHaveLength(Math.ceil(STRIPE_BACKFILL_DAYS / STRIPE_WINDOW_DAYS));
    expect(pages[0]?.cursor).toBe("2025-10-13");
    expect(pages.slice(0, -1).every((p) => !p.done)).toBe(true);
    expect(pages.at(-1)).toMatchObject({ cursor: "2026-09-13", done: true });

    const all = pages.flatMap((p) => p.observations);
    const days = orderDays(all);
    expect(days).toHaveLength(STRIPE_BACKFILL_DAYS);
    expect(new Set(days).size).toBe(STRIPE_BACKFILL_DAYS);
    expect(days[0]).toBe("2025-09-14");
    expect(days.at(-1)).toBe("2026-09-13");

    expect(revenueOf(all, "EUR")).toBe(10_000 + 250 * 1_000 + 5_000 - 2_000);
    expect(ordersOf(all)).toBe(1 + 250 + 1);
    // 250 transactions in one window means Stripe's cursor was followed.
    expect(fake.calls.some((c) => c.url.searchParams.has("starting_after"))).toBe(true);
  });

  it("a killed backfill resumes from its cursor instead of restarting", async () => {
    const stripe = stripeWith(fakeStripe([]));
    const first = await stripe.pull(FAKE_STRIPE_KEY, null, NOW);
    const second = await stripe.pull(FAKE_STRIPE_KEY, first.cursor, NOW);
    expect(first.cursor).toBe("2025-10-13");
    expect(orderDays(second.observations)[0]).toBe("2025-10-14");
  });

  it("a stretch busier than one window's page cap shrinks to a day instead of skipping any", async () => {
    const fake = fakeStripe([
      ...Array.from({ length: 100 }, () => txn("2025-09-14T10:00:00Z", 100)),
      ...Array.from({ length: 4_950 }, () => txn("2025-09-15T12:00:00Z", 100)),
    ]);
    const stripe = stripeWith(fake);

    const first = await stripe.pull(FAKE_STRIPE_KEY, null, NOW);
    expect(first).toMatchObject({ cursor: "2025-09-14", done: false });
    expect(orderDays(first.observations)).toEqual(["2025-09-14"]);
    expect(ordersOf(first.observations)).toBe(100);

    const second = await stripe.pull(FAKE_STRIPE_KEY, first.cursor, NOW);
    expect(orderDays(second.observations)[0]).toBe("2025-09-15");
    expect(ordersOf(second.observations)).toBe(4_950);
    expect(second.cursor).toBe("2025-10-14");
  });

  it("a single day beyond the cap is a clear failure, never a silent undercount", async () => {
    const fake = fakeStripe(
      Array.from({ length: STRIPE_PAGE_LIMIT * STRIPE_MAX_PAGES_PER_WINDOW + 1 }, () =>
        txn("2025-09-14T10:00:00Z", 100),
      ),
    );
    await expect(stripeWith(fake).pull(FAKE_STRIPE_KEY, null, NOW)).rejects.toThrow(
      /more than 5000 balance transactions on 2025-09-14/,
    );
  });
});

describe("P2-09 — incremental sync", () => {
  const stripe = () => stripeWith(fakeStripe([txn("2026-09-13T10:00:00Z", 1_000)]));

  it("a daily run re-reads the two most recent complete days", async () => {
    const page = await stripe().pull(FAKE_STRIPE_KEY, "2026-09-12", NOW);
    expect(orderDays(page.observations)).toEqual(["2026-09-12", "2026-09-13"]);
    expect(page).toMatchObject({ cursor: "2026-09-13", done: true });
  });

  it("running twice in one day re-reads the tail and keeps the cursor where it was", async () => {
    const page = await stripe().pull(FAKE_STRIPE_KEY, "2026-09-13", NOW);
    expect(orderDays(page.observations)).toEqual(["2026-09-12", "2026-09-13"]);
    expect(page).toMatchObject({ cursor: "2026-09-13", done: true });
  });

  it("resuming from further back continues without an overlap", async () => {
    const days = orderDays((await stripe().pull(FAKE_STRIPE_KEY, "2026-09-01", NOW)).observations);
    expect(days[0]).toBe("2026-09-02");
    expect(days.at(-1)).toBe("2026-09-13");
    expect(days).toHaveLength(12);
  });

  it("the cursor never moves backwards", async () => {
    const page = await stripe().pull(FAKE_STRIPE_KEY, "2026-09-20", NOW);
    expect(page).toMatchObject({ cursor: "2026-09-20", done: true });
  });

  it("a malformed cursor is an error, not a restart", async () => {
    await expect(stripe().pull(FAKE_STRIPE_KEY, "yesterday", NOW)).rejects.toThrow(
      /malformed cursor/,
    );
  });
});

describe("retries are capped", () => {
  const tooMany = () => jsonResponse(429, { error: { message: "Too many requests" } });

  it("a rate limit is retried with backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const fake = fakeStripe([], (_call, n) => (n <= 2 ? tooMany() : null));
    await expect(stripeWith(fake, sleeps).connect(FAKE_STRIPE_KEY)).resolves.toBeDefined();
    expect(fake.calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it("a persistent rate limit fails after the attempt cap", async () => {
    const sleeps: number[] = [];
    const fake = fakeStripe([], () => tooMany());
    await expect(stripeWith(fake, sleeps).connect(FAKE_STRIPE_KEY)).rejects.toThrow(/status 429/);
    expect(fake.calls).toHaveLength(STRIPE_MAX_ATTEMPTS);
    expect(sleeps).toHaveLength(STRIPE_MAX_ATTEMPTS - 1);
  });

  it("a persistent server error fails after the attempt cap", async () => {
    const fake = fakeStripe([], () => jsonResponse(503, { error: { message: "unavailable" } }));
    await expect(stripeWith(fake).connect(FAKE_STRIPE_KEY)).rejects.toThrow(/status 503/);
    expect(fake.calls).toHaveLength(STRIPE_MAX_ATTEMPTS);
  });

  it("network failures are retried to the cap, then reported", async () => {
    let attempts = 0;
    const stripe = createStripeProvider({
      fetch: async () => {
        attempts += 1;
        throw new TypeError("fetch failed");
      },
      sleep: async () => {},
    });
    await expect(stripe.connect(FAKE_STRIPE_KEY)).rejects.toThrow(
      /network failure after 3 attempts/,
    );
    expect(attempts).toBe(STRIPE_MAX_ATTEMPTS);
  });

  it("a bad request is not retried", async () => {
    const fake = fakeStripe([], () => jsonResponse(400, { error: { message: "Invalid limit" } }));
    await expect(stripeWith(fake).connect(FAKE_STRIPE_KEY)).rejects.toThrow(/status 400/);
    expect(fake.calls).toHaveLength(1);
  });
});
