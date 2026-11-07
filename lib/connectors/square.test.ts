// P2-28 — the Square connector, against a recorded-shape Square: the
// token's scopes come from POST /oauth2/token/status and anything beyond
// the two reads is refused; every data read is a GET with the pinned
// Square-Version; payments are read per location (ListPayments defaults
// to the main one) with cursor paging; only COMPLETED payments count,
// refunds net, tips excluded, cash included.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coverageLine } from "../hours/coverage";
import type { Provider, PullPage } from "./provider";
import type { SquareFetch, SquarePayment } from "./providers/square";
import {
  SQUARE_BOOKINGS_SCOPES,
  SQUARE_ORDERS_SCOPE,
  SQUARE_VERSION,
  aggregatePayments,
  createSquareProvider,
  parseSquareCredential,
  readsBookings,
  readsOrders,
  toBasket,
  toBookingInput,
} from "./providers/square";
import { ScopeViolationError, verifyGrantedScopes } from "./scopes";

const NOW = new Date("2026-10-13T12:00:00Z");
const TOKEN = "EAAAl-fake-production-token-0123456789";
const SECRET = JSON.stringify({ access_token: TOKEN, environment: "production" });

const pay = (
  id: string,
  created_at: string,
  amount: number,
  extra: Partial<Record<string, unknown>> = {},
) => ({
  id,
  created_at,
  status: "COMPLETED",
  source_type: "CARD",
  amount_money: { amount, currency: "HUF" },
  tip_money: { amount: 500, currency: "HUF" },
  ...extra,
});

function fakeSquare(
  opts: {
    scopes?: string[];
    payments?: Record<string, unknown[]>;
    bookings?: unknown[];
    orders?: unknown[];
    pageSize?: number;
  } = {},
) {
  const calls: {
    url: URL;
    method: string;
    version: string | undefined;
    body?: Record<string, unknown>;
  }[] = [];
  const json = (status: number, body: unknown) => ({ status, json: async () => body });
  const fetch: SquareFetch = async (raw, init) => {
    const url = new URL(raw);
    calls.push({
      url,
      method: init.method,
      version: init.headers["square-version"],
      ...(init.body ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
    });
    if (init.headers.authorization !== `Bearer ${TOKEN}`)
      return json(401, { errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED" }] });
    if (url.pathname === "/oauth2/token/status" && init.method === "POST") {
      return json(200, {
        scopes: opts.scopes ?? ["PAYMENTS_READ", "MERCHANT_PROFILE_READ"],
        expires_at: "",
        merchant_id: "M1",
      });
    }
    if (url.pathname === "/v2/locations" && init.method === "GET") {
      return json(200, {
        locations: [
          { id: "L-main", status: "ACTIVE" },
          { id: "L-terrace", status: "ACTIVE" },
        ],
      });
    }
    if (url.pathname === "/v2/payments" && init.method === "GET") {
      const all = (opts.payments ?? {})[url.searchParams.get("location_id") ?? ""] ?? [];
      const begin = url.searchParams.get("begin_time") ?? "";
      const end = url.searchParams.get("end_time") ?? "";
      const inRange = all.filter((p) => {
        const at = (p as { created_at: string }).created_at;
        return at >= begin && at < end;
      });
      const size = opts.pageSize ?? 100;
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const page = inRange.slice(start, start + size);
      return json(200, {
        payments: page,
        ...(start + size < inRange.length ? { cursor: String(start + size) } : {}),
      });
    }
    if (url.pathname === "/v2/bookings" && init.method === "GET") {
      const min = url.searchParams.get("start_at_min") ?? "";
      const max = url.searchParams.get("start_at_max") ?? "";
      if (Date.parse(max) - Date.parse(min) > 31 * 86_400_000) {
        return json(400, { errors: [{ code: "BAD_REQUEST", detail: "range over 31 days" }] });
      }
      const inRange = (opts.bookings ?? []).filter((b) => {
        const at = (b as { start_at: string }).start_at;
        return at >= min && at < max;
      });
      const size = opts.pageSize ?? 100;
      const start = Number(url.searchParams.get("cursor") ?? "0");
      return json(200, {
        bookings: inRange.slice(start, start + size),
        ...(start + size < inRange.length ? { cursor: String(start + size) } : {}),
      });
    }
    if (url.pathname === "/v2/orders/search" && init.method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as {
        location_ids?: string[];
        cursor?: string;
        query?: { filter?: { date_time_filter?: { closed_at?: Record<string, string> } } };
      };
      if ((body.location_ids ?? []).length > 10) {
        return json(400, { errors: [{ code: "BAD_REQUEST", detail: "over 10 locations" }] });
      }
      const range = body.query?.filter?.date_time_filter?.closed_at ?? {};
      const inRange = (opts.orders ?? []).filter((o) => {
        const order = o as { closed_at?: string; location_id?: string };
        return (
          (body.location_ids ?? []).includes(order.location_id ?? "") &&
          (order.closed_at ?? "") >= (range["start_at"] ?? "") &&
          (order.closed_at ?? "") <= (range["end_at"] ?? "")
        );
      });
      const size = opts.pageSize ?? 100;
      const start = Number(body.cursor ?? "0");
      return json(200, {
        orders: inRange.slice(start, start + size),
        ...(start + size < inRange.length ? { cursor: String(start + size) } : {}),
      });
    }
    return json(404, { errors: [{ code: "NOT_FOUND" }] });
  };
  return { fetch, calls };
}

const provider = (fake: ReturnType<typeof fakeSquare>): Provider =>
  createSquareProvider({ fetch: fake.fetch, sleep: async () => {} });

async function runToDone(p: Provider): Promise<PullPage[]> {
  const pages: PullPage[] = [];
  let at: string | null = null;
  for (let i = 0; i < 30; i++) {
    const page = await p.pull(SECRET, at, NOW);
    pages.push(page);
    at = page.cursor;
    if (page.done) break;
  }
  return pages;
}

describe("P2-28 — read-only, proven", () => {
  it("reads the token's scopes from POST token/status; the two reads pass the registry", async () => {
    const fake = fakeSquare();
    const { granted_scopes } = await provider(fake).connect(SECRET);
    expect(granted_scopes).toEqual(["MERCHANT_PROFILE_READ", "PAYMENTS_READ"]);
    expect(() => verifyGrantedScopes("square", granted_scopes)).not.toThrow();
    expect(fake.calls[0]?.method).toBe("POST");
    expect(fake.calls.every((c) => c.version === SQUARE_VERSION)).toBe(true);
  });

  it("a token that could also write is refused by name", async () => {
    const { granted_scopes } = await provider(
      fakeSquare({ scopes: ["PAYMENTS_READ", "MERCHANT_PROFILE_READ", "PAYMENTS_WRITE"] }),
    ).connect(SECRET);
    expect(() => verifyGrantedScopes("square", granted_scopes)).toThrow(ScopeViolationError);
  });

  it("a revoked token says so", async () => {
    const bad = JSON.stringify({
      access_token: "EAAAl-some-other-token-000000000",
      environment: "production",
    });
    await expect(provider(fakeSquare()).connect(bad)).rejects.toThrow(
      /didn't accept the access token/,
    );
  });

  it("the source knows five paths on Square's hosts; data reads are GETs but SearchOrders", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./providers/square.ts", import.meta.url)),
      "utf8",
    );
    const paths = new Set([...source.matchAll(/"(\/(?:v2|oauth2)\/[a-z/_]+)"/g)].map((m) => m[1]));
    expect([...paths].sort()).toEqual([
      "/oauth2/token/status",
      "/v2/bookings",
      "/v2/locations",
      "/v2/orders/search",
      "/v2/payments",
    ]);
    // The only POSTs are the two Square defines as reads (I-48a).
    expect(source).toContain(
      'const post = path === "/oauth2/token/status" || path === "/v2/orders/search";',
    );
    const hosts = new Set([...source.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]));
    expect([...hosts].sort()).toEqual(["connect.squareup.com", "connect.squareupsandbox.com"]);
  });

  it("the credential is a token and an environment", () => {
    expect(parseSquareCredential(SECRET).environment).toBe("production");
    expect(
      parseSquareCredential(JSON.stringify({ access_token: TOKEN, environment: "sandbox" }))
        .environment,
    ).toBe("sandbox");
    expect(() => parseSquareCredential(JSON.stringify({ access_token: "short" }))).toThrow(
      /doesn't look like/,
    );
  });
});

describe("P2-28 — the arithmetic", () => {
  const p = (over: Partial<SquarePayment>): SquarePayment => ({
    id: "x",
    created_at: "2026-10-01T18:30:00.000Z",
    status: "COMPLETED",
    source_type: "CARD",
    location_id: "L",
    amount: 10_000,
    refunded: 0,
    currency: "HUF",
    ...over,
  });

  it("completed payments only, refunds netted, cash counted, by day and by hour", () => {
    const obs = aggregatePayments(
      [
        p({}),
        p({ source_type: "CASH", amount: 4_000, created_at: "2026-10-01T18:45:00.000Z" }),
        p({ refunded: 2_500, created_at: "2026-10-01T21:10:00.000Z" }),
        p({ status: "CANCELED", amount: 99_999 }),
        p({ status: "FAILED", amount: 99_999 }),
      ],
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-10-02T00:00:00Z"),
      NOW.toISOString(),
    );
    const daily = obs.find(
      (o) => o.metric_key === "revenue.daily" && o.period_date === "2026-10-01",
    );
    expect(daily?.value_minor).toBe(10_000 + 4_000 + 7_500);
    expect(
      obs.find((o) => o.metric_key === "orders.daily" && o.period_date === "2026-10-01")?.value_num,
    ).toBe(3);
    expect(
      obs.find((o) => o.metric_key === "revenue.daily" && o.period_date === "2026-10-02")
        ?.value_minor,
    ).toBe(0);
    expect(
      obs.find((o) => o.metric_key === "revenue.hourly" && o.dimensions.hour_utc === "18")
        ?.value_minor,
    ).toBe(14_000);
  });
});

describe("P2-28 — the sync", () => {
  it("reads every location with cursor paging, a year in windows, never today; tips are not takings", async () => {
    const main = Array.from({ length: 7 }, (_, i) =>
      pay(`m${i}`, `2026-10-0${i + 1}T19:00:00.000Z`, 1_000),
    );
    const terrace = [pay("t1", "2026-10-05T12:00:00.000Z", 2_000, { source_type: "CASH" })];
    const fake = fakeSquare({ payments: { "L-main": main, "L-terrace": terrace }, pageSize: 3 });
    const pages = await runToDone(provider(fake));
    expect(pages.at(-1)?.done).toBe(true);
    const all = pages.flatMap((pg) => pg.observations);
    const total = all
      .filter((o) => o.metric_key === "revenue.daily")
      .reduce((s, o) => s + (o.value_minor ?? 0), 0);
    expect(total).toBe(7 * 1_000 + 2_000); // tip_money never counted
    const read = fake.calls.filter((c) => c.url.pathname === "/v2/payments");
    expect(new Set(read.map((c) => c.url.searchParams.get("location_id")))).toEqual(
      new Set(["L-main", "L-terrace"]),
    );
    expect(read.some((c) => c.url.searchParams.get("cursor") === "3")).toBe(true);
    expect(read.every((c) => c.method === "GET")).toBe(true);
    expect(
      read.every((c) => (c.url.searchParams.get("end_time") ?? "") <= "2026-10-13T00:00:00.000Z"),
    ).toBe(true);
  });
});

describe("P2-28 — the screens say what is measured", () => {
  it("Square includes till cash; other sources say card only", () => {
    expect(coverageLine(["square"])).toBe(
      "card and cash payments rung up in Square — cash that never goes through a till isn't seen",
    );
    expect(coverageLine(["square", "stripe"])).toContain("and card payments through Stripe");
    expect(coverageLine(["stripe"])).toContain("card payments through Stripe only");
  });
});

// Bookings (specs/bookings.md §2): the two read-only Bookings permissions,
// optional, read only when both were granted. Square is never called: the
// global fetch fails the test if anything reaches for it.
describe("Bookings — read-only, optional", () => {
  const BOOKING_SCOPES = ["PAYMENTS_READ", "MERCHANT_PROFILE_READ", ...SQUARE_BOOKINGS_SCOPES];
  beforeEach(() => {
    vi.stubGlobal("fetch", () => {
      throw new Error("the real network was called");
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const booking = (id: string, start_at: string, status: string, extra: object = {}) => ({
    id,
    version: 1,
    status,
    start_at,
    location_id: "L-main",
    customer_id: `CUST-${id}`,
    customer_note: "allergic to the blue dye",
    seller_note: "VIP",
    appointment_segments: [
      { duration_minutes: 45, service_variation_id: "SV-cut", team_member_id: "TM-kata" },
      { duration_minutes: 15, service_variation_id: "SV-wash", team_member_id: "TM-kata" },
    ],
    ...extra,
  });

  it("the Bookings read permissions pass the registry; the write ones are refused", async () => {
    const { granted_scopes } = await provider(fakeSquare({ scopes: BOOKING_SCOPES })).connect(
      SECRET,
    );
    expect(() => verifyGrantedScopes("square", granted_scopes)).not.toThrow();
    expect(readsBookings(granted_scopes)).toBe(true);
    expect(readsBookings(["PAYMENTS_READ", "APPOINTMENTS_READ"])).toBe(false);
    for (const write of ["APPOINTMENTS_WRITE", "APPOINTMENTS_ALL_WRITE"]) {
      expect(() => verifyGrantedScopes("square", [...BOOKING_SCOPES, write])).toThrow(
        ScopeViolationError,
      );
    }
  });

  it("connect proves the bookings read when the permissions are there, and only then", async () => {
    const withB = fakeSquare({ scopes: BOOKING_SCOPES });
    await provider(withB).connect(SECRET);
    expect(withB.calls.some((c) => c.url.pathname === "/v2/bookings")).toBe(true);
    const without = fakeSquare();
    await provider(without).connect(SECRET);
    expect(without.calls.some((c) => c.url.pathname === "/v2/bookings")).toBe(false);
  });

  it("a payments-only token never reads bookings", async () => {
    const fake = fakeSquare({ bookings: [booking("b1", "2026-10-05T10:00:00Z", "ACCEPTED")] });
    const pages = await runToDone(provider(fake));
    expect(fake.calls.some((c) => c.url.pathname === "/v2/bookings")).toBe(false);
    expect(pages.every((pg) => pg.appointments === undefined)).toBe(true);
    expect(
      pages.flatMap((pg) => pg.observations).some((o) => o.metric_key.startsWith("appointments")),
    ).toBe(false);
  });

  it("reads every location's bookings in GETs of at most 31 days, and maps the statuses", async () => {
    const fake = fakeSquare({
      pageSize: 2,
      bookings: [
        booking("b1", "2026-10-05T10:00:00Z", "ACCEPTED"),
        booking("b2", "2026-10-05T11:00:00Z", "NO_SHOW"),
        booking("b3", "2026-10-06T09:30:00Z", "CANCELLED_BY_CUSTOMER"),
        booking("b4", "2026-10-06T12:00:00Z", "PENDING"), // never accepted: left out
        booking("b5", "2026-10-07T12:00:00Z", "DECLINED"),
      ],
    });
    const p = provider(fake);
    const pages: PullPage[] = [];
    let at: string | null = null;
    for (let i = 0; i < 30; i++) {
      const page = await p.pull(SECRET, at, NOW, { granted_scopes: BOOKING_SCOPES });
      pages.push(page);
      at = page.cursor;
      if (page.done) break;
    }
    const reads = fake.calls.filter((c) => c.url.pathname === "/v2/bookings");
    expect(reads.length).toBeGreaterThan(12); // a year in 30-day windows, plus paging
    expect(reads.every((c) => c.method === "GET")).toBe(true);
    expect(reads.every((c) => c.url.searchParams.get("location_id") === null)).toBe(true);
    expect(reads.some((c) => c.url.searchParams.get("cursor") === "2")).toBe(true);

    const appts = pages.flatMap((pg) => pg.appointments ?? []);
    expect(appts.map((a) => [a.source_ref, a.status])).toEqual([
      ["square:b1", "completed"],
      ["square:b2", "no_show"],
      ["square:b3", "cancelled"],
      ["square:b5", "cancelled"],
    ]);
    expect(appts[0]).toMatchObject({
      day: "2026-10-05",
      start_time: "10:00",
      service: "SV-cut",
      staff_ref: "TM-kata",
      duration_minutes: 60,
      price_minor: null,
      client: { kind: "id", value: "CUST-b1" },
    });
    // Notes are never carried.
    expect(JSON.stringify(appts)).not.toContain("allergic");
    expect(JSON.stringify(appts)).not.toContain("VIP");

    const obs = pages.flatMap((pg) => pg.observations);
    const day = (metric: string, d: string) =>
      obs.find((o) => o.metric_key === metric && o.period_date === d)?.value_num;
    expect(day("appointments_completed.daily", "2026-10-05")).toBe(1);
    expect(day("appointments_no_show.daily", "2026-10-05")).toBe(1);
    expect(day("appointments_cancelled.daily", "2026-10-06")).toBe(1);
    expect(day("appointments_completed.daily", "2026-10-08")).toBe(0);
    // Square doesn't separate late cancellations, so no series claims to.
    expect(obs.some((o) => o.metric_key === "appointments_cancelled_late.daily")).toBe(false);
  });

  it("a booking still to come is booked_future; unknown statuses are left out", () => {
    expect(
      toBookingInput(booking("f", "2026-11-01T10:00:00Z", "ACCEPTED"), "2026-10-13"),
    ).toMatchObject({ status: "booked_future" });
    expect(
      toBookingInput(booking("u", "2026-10-01T10:00:00Z", "SOMETHING_NEW"), "2026-10-13"),
    ).toBeNull();
    expect(toBookingInput({ id: "x", status: "ACCEPTED" }, "2026-10-13")).toBeNull();
  });
});

// Till orders (idea 48, I-48a, owner 2026-11-03: "Yes, add ORDERS_READ"):
// the read-only ORDERS_READ, optional, feeds baskets only when granted.
// Square is never called: the global fetch fails the test if anything
// reaches for it.
describe("Till orders — read-only, optional (I-48a)", () => {
  const ORDER_SCOPES = ["PAYMENTS_READ", "MERCHANT_PROFILE_READ", SQUARE_ORDERS_SCOPE];
  beforeEach(() => {
    vi.stubGlobal("fetch", () => {
      throw new Error("the real network was called");
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const order = (id: string, closed_at: string, lines: object[], extra: object = {}) => ({
    id,
    location_id: "L-main",
    state: "COMPLETED",
    closed_at,
    customer_id: `CUST-${id}`,
    total_money: { amount: 4_200, currency: "HUF" },
    line_items: lines,
    ...extra,
  });
  const item = (name: string, extra: object = {}) => ({
    uid: name,
    name,
    quantity: "1",
    item_type: "ITEM",
    catalog_object_id: `VAR-${name}`,
    base_price_money: { amount: 1_200, currency: "HUF" },
    note: "no sugar",
    ...extra,
  });

  it("ORDERS_READ passes the registry; ORDERS_WRITE is refused", async () => {
    const { granted_scopes } = await provider(fakeSquare({ scopes: ORDER_SCOPES })).connect(SECRET);
    expect(() => verifyGrantedScopes("square", granted_scopes)).not.toThrow();
    expect(readsOrders(granted_scopes)).toBe(true);
    expect(readsOrders(["PAYMENTS_READ"])).toBe(false);
    expect(() => verifyGrantedScopes("square", [...ORDER_SCOPES, "ORDERS_WRITE"])).toThrow(
      ScopeViolationError,
    );
  });

  it("connect proves the orders read when the permission is there, and only then", async () => {
    const withO = fakeSquare({ scopes: ORDER_SCOPES });
    await provider(withO).connect(SECRET);
    const search = withO.calls.filter((c) => c.url.pathname === "/v2/orders/search");
    expect(search).toHaveLength(1);
    expect(search[0]?.method).toBe("POST");
    const without = fakeSquare();
    await provider(without).connect(SECRET);
    expect(without.calls.some((c) => c.url.pathname === "/v2/orders/search")).toBe(false);
  });

  it("a token without ORDERS_READ never reads orders and hands back no baskets", async () => {
    const fake = fakeSquare({
      orders: [order("o1", "2026-10-05T10:00:00Z", [item("Latte"), item("Croissant")])],
    });
    const pages = await runToDone(provider(fake));
    expect(fake.calls.some((c) => c.url.pathname === "/v2/orders/search")).toBe(false);
    expect(pages.every((pg) => pg.baskets === undefined)).toBe(true);
  });

  it("reads each window's completed orders into baskets of item names, and nothing else", async () => {
    const fake = fakeSquare({
      pageSize: 2,
      orders: [
        order("o1", "2026-10-05T10:00:00Z", [
          item("Latte"),
          item("Croissant"),
          item("Latte", { uid: "second" }),
        ]),
        order("o2", "2026-10-05T11:00:00Z", [item("Flat  white "), item("Croissant")]),
        order("o3", "2026-10-06T09:30:00Z", [
          item("Custom amount", { item_type: "CUSTOM_AMOUNT", catalog_object_id: undefined }),
          item("Gift card", { item_type: "GIFT_CARD" }),
        ]),
        order("o4", "2026-10-07T12:00:00Z", [item("Latte"), item("Scone")], { state: "OPEN" }),
        order("o5", "2026-10-07T13:00:00Z", [item("Tea"), item("Scone")], {
          location_id: "L-terrace",
        }),
      ],
    });
    const p = provider(fake);
    const pages: PullPage[] = [];
    let at: string | null = null;
    for (let i = 0; i < 30; i++) {
      const page = await p.pull(SECRET, at, NOW, { granted_scopes: ORDER_SCOPES });
      pages.push(page);
      at = page.cursor;
      if (page.done) break;
    }
    const reads = fake.calls.filter((c) => c.url.pathname === "/v2/orders/search");
    expect(reads.length).toBeGreaterThan(12); // a year in 30-day windows, plus paging
    expect(reads.every((c) => c.method === "POST")).toBe(true);
    expect(reads.some((c) => c.body?.["cursor"] === "2")).toBe(true);
    expect(
      reads.every((c) => (c.body?.["location_ids"] as string[]).join() === "L-main,L-terrace"),
    ).toBe(true);
    // Every page carries its window, and the window's baskets.
    expect(pages.every((pg) => pg.baskets !== undefined)).toBe(true);
    const baskets = pages.flatMap((pg) => pg.baskets?.orders ?? []);
    expect(baskets).toEqual([
      { order_ref: "o1", day: "2026-10-05", product_refs: ["Croissant", "Latte"] },
      { order_ref: "o2", day: "2026-10-05", product_refs: ["Croissant", "Flat white"] },
      { order_ref: "o5", day: "2026-10-07", product_refs: ["Scone", "Tea"] },
    ]);
    // No amount, customer, note or catalogue id is kept.
    expect(JSON.stringify(baskets)).not.toMatch(/CUST-|no sugar|VAR-|1200|4200/);
  });

  it("a basket is a completed order closed inside the window, with at least one item", () => {
    const from = new Date("2026-10-01T00:00:00Z");
    const to = new Date("2026-10-30T00:00:00Z");
    expect(toBasket(order("a", "2026-10-02T08:00:00Z", [item("Tea")]), from, to)).toEqual({
      order_ref: "a",
      day: "2026-10-02",
      product_refs: ["Tea"],
    });
    expect(
      toBasket(order("b", "2026-10-02T08:00:00Z", [item("Tea")], { state: "CANCELED" }), from, to),
    ).toBeNull();
    expect(toBasket(order("c", "2026-10-31T00:00:00Z", [item("Tea")]), from, to)).toBeNull();
    expect(
      toBasket(
        order("d", "2026-10-02T08:00:00Z", [item("Tip", { item_type: "CUSTOM_AMOUNT" })]),
        from,
        to,
      ),
    ).toBeNull();
    expect(toBasket({ id: "e", state: "COMPLETED" }, from, to)).toBeNull();
  });
});
