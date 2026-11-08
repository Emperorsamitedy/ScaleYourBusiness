// P2-20 — the Google Ads read fence, held by the build.
//
// Google's search endpoints are POSTs, so the read side is fenced by URL
// path, not by verb. These tests fail the build if:
//   · the read fence admits a mutate path, or any path it doesn't list;
//   · ":mutate" appears in any source file outside the execution provider
//     (the one file allowed to change anything on Google Ads) and the fake
//     that answers it in tests;
//   · any file in lib/google-ads calls fetch directly instead of through
//     the fenced request function;
//   · money leaves integer minor units (rule 1).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GADS_READ_ENDPOINTS,
  GOOGLE_ADS_SCOPE,
  GadsRequestError,
  allowedReadEndpoint,
  amountToMinor,
  gadsFailure,
  gadsHeaders,
  gadsRequest,
  isReadQuery,
  listAccessibleCustomers,
  microsToMinor,
  minorToMicros,
  readCustomer,
  readInt64,
  searchAll,
} from "./client";
import { fakeGoogleAds } from "./fake";

const ROOT = process.cwd();
const BASE = "https://googleads.googleapis.com/v26";
const ENV = { developer_token: null, login_customer_id: null };

describe("P2-20 — the read fence (search endpoints only, by path)", () => {
  it("admits exactly search, searchStream and listAccessibleCustomers", () => {
    expect(Object.keys(GADS_READ_ENDPOINTS).sort()).toEqual([
      "accessible",
      "search",
      "searchStream",
    ]);
    expect(allowedReadEndpoint("POST", `${BASE}/customers/1234567890/googleAds:search`)).toBe(
      "search",
    );
    expect(allowedReadEndpoint("POST", `${BASE}/customers/1234567890/googleAds:searchStream`)).toBe(
      "searchStream",
    );
    expect(allowedReadEndpoint("GET", `${BASE}/customers:listAccessibleCustomers`)).toBe(
      "accessible",
    );
  });

  it("THE BUILD GATE: refuses every mutate path, whatever the verb", () => {
    for (const path of [
      "campaigns:mutate",
      "campaignBudgets:mutate",
      "googleAds:mutate",
      "adGroups:mutate",
      "billingSetups:mutate",
      "googleAds:search:mutate",
    ]) {
      for (const verb of ["GET", "POST", "PATCH", "DELETE"]) {
        expect(allowedReadEndpoint(verb, `${BASE}/customers/1234567890/${path}`), path).toBeNull();
      }
    }
  });

  it("refuses the wrong verb, another host, another version, a query string, userinfo or a fragment", () => {
    const ok = `${BASE}/customers/1234567890/googleAds:search`;
    expect(allowedReadEndpoint("GET", ok)).toBeNull();
    expect(allowedReadEndpoint("POST", ok.replace("googleads.", "evil."))).toBeNull();
    expect(allowedReadEndpoint("POST", ok.replace("/v26/", "/v25/"))).toBeNull();
    expect(allowedReadEndpoint("POST", `${ok}?x=1`)).toBeNull();
    expect(allowedReadEndpoint("POST", `${ok}#frag`)).toBeNull();
    expect(allowedReadEndpoint("POST", ok.replace("https://", "https://u:p@"))).toBeNull();
    expect(
      allowedReadEndpoint("POST", `${BASE}/customers/123-456-7890/googleAds:search`),
    ).toBeNull();
    expect(allowedReadEndpoint("POST", "not a url")).toBeNull();
  });

  it("a search carries one SELECT, and nothing reaches the network otherwise", async () => {
    expect(isReadQuery("SELECT campaign.id FROM campaign")).toBe(true);
    expect(isReadQuery("  select customer.id FROM customer")).toBe(true);
    expect(isReadQuery("UPDATE campaign SET status = PAUSED")).toBe(false);
    expect(isReadQuery("SELECT campaign.id FROM campaign; DROP")).toBe(false);
    const sent = vi.fn();
    const fetchImpl = async () => {
      sent();
      return new Response("{}");
    };
    await expect(
      gadsRequest(
        "search",
        `${BASE}/customers/1234567890/googleAds:search`,
        { accessToken: "t", env: ENV, body: { query: "REMOVE campaign" } },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ kind: "fence" });
    await expect(
      gadsRequest(
        "search",
        `${BASE}/customers/1234567890/campaigns:mutate`,
        { accessToken: "t", env: ENV, body: { query: "SELECT campaign.id FROM campaign" } },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ kind: "fence" });
    expect(sent).not.toHaveBeenCalled();
  });

  it("sends the bearer token, and the developer token and login-customer-id only when configured", () => {
    expect(gadsHeaders("tok", ENV)).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      authorization: "Bearer tok",
    });
    expect(
      gadsHeaders("tok", { developer_token: "dev", login_customer_id: "9876543210" }),
    ).toMatchObject({ "developer-token": "dev", "login-customer-id": "9876543210" });
  });
});

/** Every source file under the app's code roots, tests excluded. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  };
  for (const dir of ["lib", "app", "components", "scripts", "db"]) walk(join(ROOT, dir));
  return out;
}

/** The only files that may name a Google Ads mutate endpoint, each with its reason. */
const MUTATE_ALLOWED: Readonly<Record<string, string>> = {
  "lib/execution/providers/google-ads.ts":
    "the execution provider: reached only through the engine, after a recorded approval",
  "lib/google-ads/fake.ts": "the tests' recorded-shape fake answers mutate calls; it sends nothing",
};

/** Pure: files (relative, forward slashes) naming ":mutate" that aren't allowed to. */
export function mutateViolations(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([path, text]) => text.includes(":mutate") && !(path in MUTATE_ALLOWED))
    .map(([path]) => path);
}

describe("P2-20 — THE BUILD GATE: no Google Ads write outside the execution provider", () => {
  const files = Object.fromEntries(
    sources().map((p) => [relative(ROOT, p).split(sep).join("/"), readFileSync(p, "utf8")]),
  );

  it("names ':mutate' only in the execution provider (and the tests' fake)", () => {
    expect(mutateViolations(files)).toEqual([]);
    expect(files["lib/execution/providers/google-ads.ts"]).toContain(":mutate");
  });

  it("the check has teeth: a planted mutate call anywhere else is caught", () => {
    expect(
      mutateViolations({
        "lib/google-ads/read.ts": "fetch(`${base}/customers/1/campaigns:mutate`)",
        "lib/ads/proposals.ts": "nothing here",
      }),
    ).toEqual(["lib/google-ads/read.ts"]);
  });

  it("lib/google-ads never calls fetch directly: every request goes through the fence", () => {
    const offenders = Object.entries(files)
      .filter(([p]) => p.startsWith("lib/google-ads/"))
      .filter(([, text]) => /(^|[^A-Za-z_.])fetch\(/m.test(text))
      .map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("the Google Ads host is named only by the read client, the executor and the fake", () => {
    const named = Object.entries(files)
      .filter(([, text]) => text.includes("googleads.googleapis.com"))
      .map(([p]) => p)
      .sort();
    expect(named).toEqual([
      "lib/execution/providers/google-ads.ts",
      "lib/google-ads/client.ts",
      "lib/google-ads/fake.ts",
    ]);
  });

  it("the read scope is Google's one scope, and nothing in the read client is a mutate", () => {
    expect(GOOGLE_ADS_SCOPE).toBe("https://www.googleapis.com/auth/adwords");
    expect(files["lib/google-ads/client.ts"]).not.toContain(":mutate");
    expect(files["lib/google-ads/read.ts"]).not.toContain(":mutate");
  });
});

describe("P2-20 — numbers (rule 1)", () => {
  it("micros become integer minor units in the account currency", () => {
    expect(microsToMinor(12_340_000, "EUR")).toBe(1234);
    expect(microsToMinor(1_234_567, "USD")).toBe(123); // $1.234567 → 123 cents
    expect(microsToMinor(1_235_000, "USD")).toBe(124); // half away from zero
    expect(microsToMinor(1_500_000_000, "HUF")).toBe(150_000); // 1 500,00 Ft
    expect(microsToMinor(250_000_000, "JPY")).toBe(250); // no minor unit
    expect(microsToMinor(0, "EUR")).toBe(0);
    expect(() => microsToMinor(1.5, "EUR")).toThrow(RangeError);
  });

  it("minor units go back to micros exactly", () => {
    expect(minorToMicros(1234, "EUR")).toBe(12_340_000);
    expect(minorToMicros(250, "JPY")).toBe(250_000_000);
    expect(() => minorToMicros(0.5, "EUR")).toThrow(RangeError);
  });

  it("a double amount (conversion value) becomes minor units", () => {
    expect(amountToMinor(45.678, "EUR")).toBe(4568);
    expect(amountToMinor(1200, "JPY")).toBe(1200);
  });

  it("int64 arrives as a string or a number; anything else is null", () => {
    expect(readInt64("12340000")).toBe(12_340_000);
    expect(readInt64(42)).toBe(42);
    expect(readInt64("12.5")).toBeNull();
    expect(readInt64("abc")).toBeNull();
    expect(readInt64(null)).toBeNull();
    expect(readInt64(1.5)).toBeNull();
  });
});

describe("P2-20 — reads against the recorded-shape fake", () => {
  it("lists accessible customers and describes one", async () => {
    const fake = fakeGoogleAds({
      customers: [
        { id: "1234567890", name: "Lumen Ads", currency: "eur" },
        { id: "5555555555", name: "Agency MCC", currency: "EUR", manager: true },
      ],
    });
    expect(await listAccessibleCustomers({ accessToken: "t", env: ENV }, fake.fetch)).toEqual([
      "1234567890",
      "5555555555",
    ]);
    expect(
      await readCustomer({ accessToken: "t", env: ENV, customerId: "1234567890" }, fake.fetch),
    ).toEqual({
      customer_id: "1234567890",
      name: "Lumen Ads",
      currency: "EUR",
      time_zone: "Europe/Budapest",
      manager: false,
    });
    expect(fake.calls.every((c) => !c.url.includes(":mutate"))).toBe(true);
  });

  it("follows nextPageToken, and sends no pageSize (Google refuses it)", async () => {
    const days = Array.from({ length: 5 }, (_, i) => ({
      date: `2026-11-0${i + 1}`,
      campaign_id: "111",
      cost_micros: 1_000_000,
      clicks: 1,
      conversions: 0,
      conversions_value: 0,
    }));
    const fake = fakeGoogleAds({ days, pageSize: 2 });
    const rows = await searchAll(
      {
        accessToken: "t",
        env: ENV,
        customerId: "1234567890",
        query:
          "SELECT segments.date FROM campaign WHERE segments.date BETWEEN '2026-11-01' AND '2026-11-05'",
      },
      fake.fetch,
    );
    expect(rows).toHaveLength(5);
    expect(fake.calls).toHaveLength(3);
    for (const call of fake.calls) expect(call.body).not.toHaveProperty("pageSize");
  });

  it("maps Google's refusals to the owner's words, the access level first", () => {
    expect(
      gadsFailure(403, {
        error: {
          details: [
            {
              errors: [
                { errorCode: { authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" } },
              ],
            },
          ],
        },
      }).kind,
    ).toBe("access_level");
    expect(gadsFailure(401, null).kind).toBe("auth");
    expect(gadsFailure(403, null).kind).toBe("permission");
    expect(gadsFailure(429, null).kind).toBe("quota");
    expect(gadsFailure(503, null).kind).toBe("unavailable");
    expect(gadsFailure(400, null)).toBeInstanceOf(GadsRequestError);
  });
});
