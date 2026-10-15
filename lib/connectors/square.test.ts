// P2-28 — the Square connector, against a recorded-shape Square: the
// token's scopes come from POST /oauth2/token/status and anything beyond
// the two reads is refused; every data read is a GET with the pinned
// Square-Version; payments are read per location (ListPayments defaults
// to the main one) with cursor paging; only COMPLETED payments count,
// refunds net, tips excluded, cash included.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coverageLine } from "../hours/coverage";
import type { Provider, PullPage } from "./provider";
import type { SquareFetch, SquarePayment } from "./providers/square";
import {
  SQUARE_VERSION,
  aggregatePayments,
  createSquareProvider,
  parseSquareCredential,
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
  opts: { scopes?: string[]; payments?: Record<string, unknown[]>; pageSize?: number } = {},
) {
  const calls: { url: URL; method: string; version: string | undefined }[] = [];
  const json = (status: number, body: unknown) => ({ status, json: async () => body });
  const fetch: SquareFetch = async (raw, init) => {
    const url = new URL(raw);
    calls.push({ url, method: init.method, version: init.headers["square-version"] });
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

  it("the source knows three paths on Square's hosts; data reads are GETs", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./providers/square.ts", import.meta.url)),
      "utf8",
    );
    const paths = new Set([...source.matchAll(/"(\/(?:v2|oauth2)\/[a-z/_]+)"/g)].map((m) => m[1]));
    expect([...paths].sort()).toEqual(["/oauth2/token/status", "/v2/locations", "/v2/payments"]);
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
    expect(coverageLine(["square", "stripe"])).toContain("and card payments through stripe");
    expect(coverageLine(["stripe"])).toContain("card payments through stripe only");
  });
});
