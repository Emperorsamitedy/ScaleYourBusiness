// TikTok Ads — the request fence as a build gate. Every request SYB can send
// to TikTok is pinned here; writes carry only their listed fields; DELETE is
// never sent; nothing touches a money surface (rule 18); the token travels
// in a header, never a URL; retries are capped. Fake HTTP only.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { touchesMoneySurface } from "../execution/scopes";
import type { TikTokContext } from "./api";
import {
  TIKTOK_MAX_ATTEMPTS,
  TIKTOK_READ_REQUESTS,
  TIKTOK_REQUESTS,
  TikTokFenceError,
  TikTokRequestError,
  classifyTikTokCode,
  parseTikTokCredential,
  tiktokBodyViolation,
  tiktokCall,
  tiktokRead,
} from "./api";
import { fakeTikTok, tiktokError, tiktokOk } from "./fake";

const noSleep = async () => undefined;
const ctxOf = (fetch: TikTokContext["fetch"]): TikTokContext => ({ fetch, sleep: noSleep });

describe("TikTok Ads — the pinned request table (THE BUILD GATE)", () => {
  it("is exactly these six requests, and nothing else", () => {
    expect(TIKTOK_REQUESTS).toEqual({
      access_token: {
        method: "POST",
        path: "/open_api/v1.3/oauth2/access_token/",
        auth: "app",
        body_fields: ["app_id", "secret", "auth_code"],
      },
      advertiser_info: { method: "GET", path: "/open_api/v1.3/advertiser/info/", auth: "token" },
      report: { method: "GET", path: "/open_api/v1.3/report/integrated/get/", auth: "token" },
      campaign_get: { method: "GET", path: "/open_api/v1.3/campaign/get/", auth: "token" },
      campaign_update: {
        method: "POST",
        path: "/open_api/v1.3/campaign/update/",
        auth: "token",
        body_fields: ["advertiser_id", "campaign_id", "budget"],
      },
      campaign_status_update: {
        method: "POST",
        path: "/open_api/v1.3/campaign/status/update/",
        auth: "token",
        body_fields: ["advertiser_id", "campaign_ids", "operation_status"],
      },
    });
  });

  it("the read side is GET only", () => {
    for (const r of TIKTOK_READ_REQUESTS) expect(TIKTOK_REQUESTS[r].method).toBe("GET");
    expect(TIKTOK_READ_REQUESTS).toEqual(["advertiser_info", "report", "campaign_get"]);
  });

  it("rule 18: no path and no body field names billing, payment, funding or the like", () => {
    for (const spec of Object.values(TIKTOK_REQUESTS)) {
      expect(touchesMoneySurface(spec.path), spec.path).toBe(false);
      for (const f of "body_fields" in spec ? spec.body_fields : []) {
        expect(touchesMoneySurface(f), f).toBe(false);
      }
    }
    // The check has teeth: TikTok's own billing paths would trip it.
    expect(touchesMoneySurface("/open_api/v1.3/bc/billing_group/get/")).toBe(true);
    expect(touchesMoneySurface("/open_api/v1.3/bc/payment/transfer/")).toBe(true);
  });

  it("no module under lib names a TikTok endpoint outside this fence", () => {
    const root = join(process.cwd(), "lib");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (
          /\.tsx?$/.test(name) &&
          !name.endsWith(".test.ts") &&
          !p.endsWith(join("tiktok", "api.ts")) &&
          !p.endsWith(join("tiktok", "fake.ts"))
        ) {
          const src = readFileSync(p, "utf8");
          if (/\/open_api\/|business-api\.tiktok\.com\/open_api|sandbox-ads\.tiktok\.com/.test(src))
            offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("only the executor sends a campaign write, and only the sign-in and the executor hold tiktokCall", () => {
    // Review 2026-11-08: tiktokCall is generic — a module that imports it can
    // reach campaign_update and campaign_status_update. This pins who may.
    const MAY_CALL: Readonly<Record<string, readonly string[]>> = {
      [join("lib", "tiktok", "login.ts")]: ["access_token"],
      [join("lib", "execution", "providers", "tiktok-ads.ts")]: [
        "campaign_get",
        "campaign_update",
        "campaign_status_update",
      ],
    };
    const importsFence = (src: string) =>
      /import\s*\{[^}]*\btiktokCall\b[^}]*\}\s*from\s*["'](?:\.\/api|[^"']*\/tiktok\/api)["']/.test(
        src,
      );
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "node_modules" && !name.startsWith(".")) walk(p);
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const rel = p.slice(process.cwd().length + 1);
          if (rel === join("lib", "tiktok", "api.ts")) continue;
          const src = readFileSync(p, "utf8");
          if (!importsFence(src)) continue;
          const allowed = MAY_CALL[rel];
          if (!allowed) {
            offenders.push(`${rel}: imports tiktokCall`);
            continue;
          }
          for (const [, id] of src.matchAll(/tiktokCall\(\s*\w+\s*,\s*"([a-z_]+)"/g)) {
            if (!allowed.includes(id as string)) offenders.push(`${rel}: ${id}`);
          }
        }
      }
    };
    for (const top of ["lib", "app", "components", "scripts"]) walk(join(process.cwd(), top));
    expect(offenders).toEqual([]);
    // The check has teeth: a planted write outside the executor is named.
    const planted = `import { tiktokCall } from "../tiktok/api";\nawait tiktokCall(ctx, "campaign_status_update", {});`;
    expect(importsFence(planted)).toBe(true);
  });
});

describe("TikTok Ads — tiktokCall refuses before it sends", () => {
  it("refuses DELETE, a body field outside the list, several campaigns, and a GET body", async () => {
    const tt = fakeTikTok();
    const ctx = ctxOf(tt.fetch);
    const token = tt.token;
    await expect(
      tiktokCall(ctx, "campaign_status_update", {
        token,
        body: {
          advertiser_id: "7000000000001",
          campaign_ids: ["1700000000001"],
          operation_status: "DELETE",
        },
      }),
    ).rejects.toBeInstanceOf(TikTokFenceError);
    await expect(
      tiktokCall(ctx, "campaign_update", {
        token,
        body: {
          advertiser_id: "7000000000001",
          campaign_id: "1700000000001",
          budget: 60,
          po_number: "x",
        },
      }),
    ).rejects.toThrow(/po_number/);
    await expect(
      tiktokCall(ctx, "campaign_status_update", {
        token,
        body: {
          advertiser_id: "7000000000001",
          campaign_ids: ["1700000000001", "1700000000002"],
          operation_status: "DISABLE",
        },
      }),
    ).rejects.toThrow(/one campaign at a time/);
    await expect(tiktokCall(ctx, "report", { token, body: { a: 1 } })).rejects.toBeInstanceOf(
      TikTokFenceError,
    );
    await expect(tiktokCall(ctx, "report", {})).rejects.toBeInstanceOf(TikTokFenceError);
    await expect(tiktokCall(ctx, "nope" as never, { token })).rejects.toBeInstanceOf(
      TikTokFenceError,
    );
    expect(tt.calls).toEqual([]);
  });

  it("passes ENABLE and DISABLE for one campaign (the passing case)", () => {
    const body = { advertiser_id: "1", campaign_ids: ["2"], operation_status: "ENABLE" };
    expect(tiktokBodyViolation("campaign_status_update", body)).toBeNull();
    expect(
      tiktokBodyViolation("campaign_status_update", { ...body, operation_status: "DISABLE" }),
    ).toBeNull();
    expect(
      tiktokBodyViolation("campaign_update", { advertiser_id: "1", campaign_id: "2", budget: 50 }),
    ).toBeNull();
  });

  it("tiktokRead takes only the read requests", async () => {
    const tt = fakeTikTok();
    await expect(
      tiktokRead(ctxOf(tt.fetch), "campaign_update" as never, { token: tt.token }),
    ).rejects.toBeInstanceOf(TikTokFenceError);
    expect(tt.calls).toEqual([]);
  });
});

describe("TikTok Ads — how a call goes out", () => {
  it("sends the token as the Access-Token header, never in the URL; arrays as JSON in the query", async () => {
    const tt = fakeTikTok();
    await tiktokRead(ctxOf(tt.fetch), "advertiser_info", {
      token: tt.token,
      query: { advertiser_ids: ["7000000000001"], fields: ["currency"] },
    });
    const call = tt.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.init.headers["Access-Token"]).toBe(tt.token);
    expect(call.url.toString()).not.toContain(tt.token);
    expect(call.url.searchParams.get("advertiser_ids")).toBe('["7000000000001"]');
  });

  it("retries a rate limit, at most three attempts in all", async () => {
    const fetch = vi.fn(async () => tiktokError(40100, "Requests made too frequently"));
    await expect(
      tiktokRead(ctxOf(fetch), "report", { token: "t", query: {} }),
    ).rejects.toMatchObject({ kind: "rate_limit", code: 40100 });
    expect(fetch).toHaveBeenCalledTimes(TIKTOK_MAX_ATTEMPTS);
  });

  it("succeeds after one rate limit (the passing case)", async () => {
    let n = 0;
    const fetch = vi.fn(async () =>
      ++n === 1 ? tiktokError(40133, "slow down") : tiktokOk({ list: [] }),
    );
    await expect(tiktokRead(ctxOf(fetch), "report", { token: "t", query: {} })).resolves.toEqual({
      list: [],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never retries the OAuth exchange: an auth code works once", async () => {
    const fetch = vi.fn(async () => tiktokError(50000, "System error"));
    await expect(
      tiktokCall(ctxOf(fetch), "access_token", {
        body: { app_id: "a", secret: "s", auth_code: "c" },
      }),
    ).rejects.toBeInstanceOf(TikTokRequestError);
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = (
      fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    )[1];
    expect(init.headers["Access-Token"]).toBeUndefined();
  });

  it("does not retry an auth failure", async () => {
    const fetch = vi.fn(async () => tiktokError(40105, "Invalid access token"));
    await expect(tiktokRead(ctxOf(fetch), "report", { token: "t" })).rejects.toMatchObject({
      kind: "auth",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies TikTok's return codes", () => {
    expect(classifyTikTokCode(40100, 200)).toBe("rate_limit");
    expect(classifyTikTokCode(50002, 200)).toBe("unavailable");
    expect(classifyTikTokCode(40102, 200)).toBe("auth");
    expect(classifyTikTokCode(40001, 200)).toBe("permission");
    expect(classifyTikTokCode(40002, 200)).toBe("invalid");
    expect(classifyTikTokCode(40007, 200)).toBe("not_found");
    expect(classifyTikTokCode(null, 503)).toBe("unavailable");
    expect(classifyTikTokCode(12345, 200)).toBe("unknown");
  });
});

describe("TikTok Ads — the credential at rest", () => {
  it("reads a well-formed one", () => {
    const c = parseTikTokCredential(
      JSON.stringify({
        v: 1,
        access_token: "tok",
        advertiser_ids: ["7000000000002", "7000000000001"],
        scope_ids: [100, 44],
      }),
    );
    expect(c.advertiser_ids).toEqual(["7000000000001", "7000000000002"]);
  });

  it("refuses one with no ad account, a spaced token or a non-numeric id", () => {
    for (const bad of [
      { v: 1, access_token: "tok", advertiser_ids: [], scope_ids: [] },
      { v: 1, access_token: "to k", advertiser_ids: ["7000000000001"], scope_ids: [] },
      { v: 1, access_token: "tok", advertiser_ids: ["act_1"], scope_ids: [] },
      { v: 2, access_token: "tok", advertiser_ids: ["7000000000001"], scope_ids: [] },
    ]) {
      expect(() => parseTikTokCredential(JSON.stringify(bad))).toThrow(TikTokFenceError);
    }
    expect(() => parseTikTokCredential("not json")).toThrow(TikTokFenceError);
  });
});
