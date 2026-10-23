// P3-20f/g — the Meta write connector, against a recorded-shape Graph API.
//
// What these tests hold:
//
//   · PROVEN BEFORE STORED. A token with exactly a consent's scopes
//     connects as an execute connection, encrypted, never returned; one
//     scope too many or too few is refused by name before any asset is
//     touched; the asset itself (Page, Instagram account, ad account) must
//     answer to the token.
//   · WHAT IT CAN SEND. Only the registered requests, the token in a header
//     and never in a URL; the source scan fails the build otherwise. POST
//     only on the registered publish paths (P3-21b) and the token exchange,
//     DELETE only on a post or media id (P3-21c), no native scheduling.
//     No registered path under act_* names a money surface.
//   · NO PUBLISH WITHOUT ITS DISCLOSURE (rule 17). Every publishing request
//     passes one check before it is sent; the scan proves none can skip it.
//   · THE AD WRITES (P3-22b). POST only on a campaign by id and the ad
//     account's campaigns edge; only the fields AD_WRITE_FIELDS lists; a
//     status of PAUSED or ACTIVE only — DELETED and ARCHIVED, both permanent
//     on Meta, appear nowhere in the code. Rule 18 re-proven: no registered
//     op, path or ad field names billing, funding, payment methods or
//     payment cycles. (The ops themselves: meta-ads-exec.test.ts.)

import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../../db";
import {
  accounts,
  businessProfiles,
  connections,
  fieldRecords,
  intakeEvents,
} from "../../../db/schema";
import type { MetaResponse } from "../../connectors/providers/meta-ads";
import { metaError, metaJson } from "../../connectors/providers/meta-fake";
import { decryptSecret } from "../../connectors/secrets";
import { EXECUTION_SCOPE_REGISTRY, touchesMoneySurface } from "../scopes";
import { bootstrapIntake } from "../../intake/service";
import {
  ExecutionConnectionError,
  connectForExecution,
  expectedExecutionScopes,
} from "../connections";
import type {
  MetaExecFetch,
  MetaExecRequestInit,
  MetaExecutionProviderId,
  MetaRequestError,
} from "./meta";
import {
  DISCLOSED_TEXT_FIELD,
  FB_POST_METRICS,
  IG_POST_METRICS,
  META_EXEC_MAX_ATTEMPTS,
  META_EXEC_REQUESTS,
  META_READBACK_REQUESTS,
  AD_STATUSES,
  AD_WRITE_FIELDS,
  VALIDATE_ONLY,
  adWriteViolation,
  adsAccessTier,
  auditMetaRequests,
  createMetaExecution,
  disclosureViolation,
  parseFbPostInsights,
  parseIgInsights,
  parseMetaExecutionCredential,
} from "./meta";

const TOKEN = "EAAFakeSystemUserWriteTokenForTestsOnly";
const PAGE_TOKEN = "EAAFakeDerivedPageTokenForTestsOnly";
const PAGE = "1000000001";
const IG = "17800000000000001";
const ACT = "2000000002";
const V = "/v26.0";

const PUBLISH_SECRET = JSON.stringify({ access_token: TOKEN, page_id: PAGE, ig_user_id: IG });
const ADS_SECRET = JSON.stringify({ access_token: TOKEN, ad_account_id: `act_${ACT}` });

type Perm = { permission: string; status: string };
const granted = (...names: string[]): Perm[] => [
  ...names.map((permission) => ({ permission, status: "granted" })),
  { permission: "public_profile", status: "granted" },
];

interface Call {
  url: URL;
  init: MetaExecRequestInit;
}

function fakeGraph(
  options: {
    permissions?: Perm[];
    noPageToken?: boolean;
    respond?: (call: Call) => MetaResponse | null;
  } = {},
): { fetch: MetaExecFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: MetaExecFetch = async (url, init) => {
    const call = { url: new URL(url), init };
    calls.push(call);
    const forced = options.respond?.(call) ?? null;
    if (forced !== null) return forced;
    const auth = init.headers["authorization"];
    if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${PAGE_TOKEN}`) {
      return metaError(190, "Invalid OAuth access token - Cannot parse access token");
    }
    const path = call.url.pathname;
    if (path === `${V}/me/permissions`) return metaJson(200, { data: options.permissions ?? [] });
    if (path === `${V}/${PAGE}`) {
      const wantsToken = call.url.searchParams.get("fields")?.includes("access_token");
      return metaJson(200, {
        id: PAGE,
        name: "Ember & Oak",
        ...(wantsToken && !options.noPageToken ? { access_token: PAGE_TOKEN } : {}),
      });
    }
    if (path === `${V}/${IG}`) return metaJson(200, { id: IG, username: "emberandoak" });
    if (path === `${V}/act_${ACT}`) {
      return metaJson(200, { id: `act_${ACT}`, name: "Ember & Oak", currency: "EUR" });
    }
    return metaError(
      100,
      "Unsupported get request. Object does not exist or missing permissions",
      33,
    );
  };
  return { fetch, calls };
}

function meta(options: Parameters<typeof fakeGraph>[0] = {}) {
  const graph = fakeGraph(options);
  return { ...graph, exec: createMetaExecution({ fetch: graph.fetch, sleep: async () => {} }) };
}

const PUBLISH_SCOPES = expectedExecutionScopes("meta_publish");
const ADS_SCOPES = expectedExecutionScopes("meta_ads");

describe("P3-20g — the credential", () => {
  it("publishing needs a Page id; ad management needs an ad account id, with or without act_", () => {
    expect(parseMetaExecutionCredential(PUBLISH_SECRET, "meta_publish")).toMatchObject({
      page_id: PAGE,
      ig_user_id: IG,
    });
    expect(parseMetaExecutionCredential(ADS_SECRET, "meta_ads").ad_account_id).toBe(ACT);
    expect(() =>
      parseMetaExecutionCredential(JSON.stringify({ access_token: TOKEN }), "meta_publish"),
    ).toThrow(/id of the Page/);
    expect(() =>
      parseMetaExecutionCredential(
        JSON.stringify({ access_token: TOKEN, page_id: PAGE }),
        "meta_ads",
      ),
    ).toThrow(/ad account id/);
  });

  it("refuses a token with whitespace, a non-numeric id, or no token at all", () => {
    expect(() =>
      parseMetaExecutionCredential(
        JSON.stringify({ access_token: "EAA x", page_id: PAGE }),
        "meta_publish",
      ),
    ).toThrow(/one line/);
    expect(() =>
      parseMetaExecutionCredential(
        JSON.stringify({ access_token: TOKEN, page_id: "my page" }),
        "meta_publish",
      ),
    ).toThrow(/Page id is a number/);
    expect(() =>
      parseMetaExecutionCredential(JSON.stringify({ page_id: PAGE }), "meta_publish"),
    ).toThrow(/access token is needed/);
  });
});

describe("P3-20g — the verifier proves the token and the asset", () => {
  it("meta_publish: exactly the registered scopes, the Page reached and a Page token had, the Instagram account reached", async () => {
    const { exec, calls } = meta({ permissions: granted(...PUBLISH_SCOPES) });
    const proof = await exec.verifier("meta_publish")(PUBLISH_SECRET);
    expect(proof.granted_scopes).toEqual([...PUBLISH_SCOPES]);
    expect(calls.map((c) => c.url.pathname)).toEqual([
      `${V}/me/permissions`,
      `${V}/${PAGE}`,
      `${V}/${IG}`,
    ]);
  });

  it("meta_ads: exactly ads_management, and the ad account answers", async () => {
    const { exec, calls } = meta({ permissions: granted("ads_management") });
    expect((await exec.verifier("meta_ads")(ADS_SECRET)).granted_scopes).toEqual([
      "ads_management",
    ]);
    expect(calls.map((c) => c.url.pathname)).toEqual([`${V}/me/permissions`, `${V}/act_${ACT}`]);
  });

  it("one token holding both consents' scopes connects as neither — publishing never implies ads", async () => {
    const both = granted(...PUBLISH_SCOPES, ...ADS_SCOPES);
    for (const [provider, secret] of [
      ["meta_publish", PUBLISH_SECRET],
      ["meta_ads", ADS_SECRET],
    ] as [MetaExecutionProviderId, string][]) {
      const { exec, calls } = meta({ permissions: both });
      await expect(exec.verifier(provider)(secret)).rejects.toThrow(/one scope too many/);
      expect(calls).toHaveLength(1); // refused before any asset was touched
    }
  });

  it("one scope too many or too few is refused by name", async () => {
    const extra = meta({ permissions: granted(...PUBLISH_SCOPES, "pages_messaging") });
    await expect(extra.exec.verifier("meta_publish")(PUBLISH_SECRET)).rejects.toThrow(
      /granted "pages_messaging" which the consent does not name/,
    );
    const short = meta({
      permissions: granted(...PUBLISH_SCOPES.filter((s) => s !== "instagram_content_publish")),
    });
    await expect(short.exec.verifier("meta_publish")(PUBLISH_SECRET)).rejects.toThrow(
      /missing "instagram_content_publish"/,
    );
  });

  it("a declined permission is not a granted one", async () => {
    const { exec } = meta({
      permissions: [
        ...granted(...PUBLISH_SCOPES.filter((s) => s !== "pages_manage_posts")),
        { permission: "pages_manage_posts", status: "declined" },
      ],
    });
    await expect(exec.verifier("meta_publish")(PUBLISH_SECRET)).rejects.toThrow(
      /missing "pages_manage_posts"/,
    );
  });

  it("a Page the token can't reach, or no Page token to be had, says how to fix it", async () => {
    const elsewhere = meta({ permissions: granted(...PUBLISH_SCOPES) });
    await expect(
      elsewhere.exec.verifier("meta_publish")(
        JSON.stringify({ access_token: TOKEN, page_id: "9999999" }),
      ),
    ).rejects.toThrow(/can't reach Page 9999999/);
    const noToken = meta({ permissions: granted(...PUBLISH_SCOPES), noPageToken: true });
    await expect(noToken.exec.verifier("meta_publish")(PUBLISH_SECRET)).rejects.toThrow(
      /no Page token could be had for Page/,
    );
  });

  it("THE ATTACK (review 2026-10-17): a pasted Page token is refused — its permissions can't be checked against the consent", async () => {
    const { exec, calls } = meta({ permissions: granted(...PUBLISH_SCOPES) });
    const secret = JSON.stringify({
      access_token: TOKEN,
      page_id: PAGE,
      page_access_token: PAGE_TOKEN,
    });
    await expect(exec.verifier("meta_publish")(secret)).rejects.toThrow(
      /a pasted Page token can't be checked against your consent/,
    );
    expect(calls).toHaveLength(0); // refused before anything was sent
  });

  it("an invalid token is reported as not accepted, without echoing it", async () => {
    const { exec } = meta({ permissions: granted(...PUBLISH_SCOPES) });
    const secret = JSON.stringify({ access_token: "EAAwrongToken", page_id: PAGE });
    const error = await exec
      .verifier("meta_publish")(secret)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecutionConnectionError);
    expect((error as Error).message).toMatch(/expired or was revoked/);
    expect((error as MetaRequestError).failure).toMatchObject({
      kind: "auth",
      connection_state: "paused",
    });
    expect((error as Error).message).not.toContain("EAAwrongToken");
  });

  it("rate limiting retries to the cap, then fails", async () => {
    const { exec, calls } = meta({ respond: () => metaError(17, "User request limit reached") });
    await expect(exec.verifier("meta_ads")(ADS_SECRET)).rejects.toThrow(/asked SYB to slow down/);
    expect(calls).toHaveLength(META_EXEC_MAX_ATTEMPTS);
  });
});

describe("rules 13 and 18 — what the connector can send", () => {
  it("every request is a registered GET on graph.facebook.com, the token never in the URL", async () => {
    const pub = meta({ permissions: granted(...PUBLISH_SCOPES) });
    await pub.exec.verifier("meta_publish")(PUBLISH_SECRET);
    const ads = meta({ permissions: granted("ads_management") });
    await ads.exec.verifier("meta_ads")(ADS_SECRET);

    const allowed = [`${V}/me/permissions`, `${V}/${PAGE}`, `${V}/${IG}`, `${V}/act_${ACT}`];
    for (const call of [...pub.calls, ...ads.calls]) {
      expect(call.init.method).toBe("GET");
      expect(call.url.origin).toBe("https://graph.facebook.com");
      expect(allowed).toContain(call.url.pathname);
      expect(call.url.toString()).not.toContain(TOKEN);
      expect(call.url.toString()).not.toContain(PAGE_TOKEN);
      expect(call.url.searchParams.has("access_token")).toBe(false);
    }
  });

  it("THE BUILD GATE: the registered requests are exactly these, and the source names no other verb", () => {
    expect(META_EXEC_REQUESTS).toEqual({
      permissions: { method: "GET", path: "/me/permissions" },
      page: { method: "GET", path: "/{page_id}" },
      ig_user: { method: "GET", path: "/{ig_user_id}" },
      ad_account: { method: "GET", path: "/act_{ad_account_id}" },
      // P3-20j, added deliberately: Facebook Login's token exchange and its two lists.
      token_exchange: { method: "POST", path: "/oauth/access_token" },
      my_pages: { method: "GET", path: "/me/accounts" },
      my_ad_accounts: { method: "GET", path: "/me/adaccounts" },
      // P3-21b, added deliberately: the publish path.
      page_feed: { method: "POST", path: "/{page_id}/feed" },
      page_photos: { method: "POST", path: "/{page_id}/photos" },
      page_reels: { method: "POST", path: "/{page_id}/video_reels" },
      reel_upload: { method: "POST", path: "/{video_id}", origin: "rupload" },
      ig_container: { method: "POST", path: "/{ig_user_id}/media" },
      ig_publish: { method: "POST", path: "/{ig_user_id}/media_publish" },
      ig_publishing_limit: { method: "GET", path: "/{ig_user_id}/content_publishing_limit" },
      ig_container_status: { method: "GET", path: "/{container_id}" },
      ig_media: { method: "GET", path: "/{ig_media_id}" },
      ig_media_list: { method: "GET", path: "/{ig_user_id}/media" },
      page_post: { method: "GET", path: "/{post_id}" },
      page_published_posts: { method: "GET", path: "/{page_id}/published_posts" },
      reel_status: { method: "GET", path: "/{video_id}" },
      // Review 2026-10-23 (Session D #5), added deliberately: the token's own app, for read-back.
      token_app: { method: "GET", path: "/app" },
      // P3-21c, added deliberately: undo is deletion.
      page_post_delete: { method: "DELETE", path: "/{post_id}" },
      ig_media_delete: { method: "DELETE", path: "/{ig_media_id}" },
      // P3-22b, added deliberately: the ad ops.
      campaign: { method: "GET", path: "/{campaign_id}" },
      campaign_update: { method: "POST", path: "/{campaign_id}" },
      campaign_create: { method: "POST", path: "/act_{ad_account_id}/campaigns" },
      // P3-23a, added deliberately: the per-post readback, GET only.
      page_post_insights: { method: "GET", path: "/{post_id}/insights" },
      ig_media_insights: { method: "GET", path: "/{ig_media_id}/insights" },
    });
    // Every non-GET, named: the token exchange, the publish POSTs, the two undo DELETEs.
    const nonGet = Object.entries(META_EXEC_REQUESTS)
      .filter(([, r]) => r.method !== "GET")
      .map(([k, r]) => `${r.method} ${k}`);
    expect(nonGet).toEqual([
      "POST token_exchange",
      "POST page_feed",
      "POST page_photos",
      "POST page_reels",
      "POST reel_upload",
      "POST ig_container",
      "POST ig_publish",
      "DELETE page_post_delete",
      "DELETE ig_media_delete",
      "POST campaign_update",
      "POST campaign_create",
    ]);

    const source = readFileSync(fileURLToPath(new URL("./meta.ts", import.meta.url)), "utf8");
    // Code only: comments may name a verb; code may not use one unregistered.
    const code = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
    expect(code.join("\n")).not.toMatch(/\b(PUT|PATCH)\b/);
    // POST and DELETE appear only in their registrations, the type, and the form-body check.
    expect(code.filter((l) => /\bPOST\b/.test(l))).toEqual([
      'token_exchange: { method: "POST", path: "/oauth/access_token" },',
      'page_feed: { method: "POST", path: "/{page_id}/feed" },',
      'page_photos: { method: "POST", path: "/{page_id}/photos" },',
      'page_reels: { method: "POST", path: "/{page_id}/video_reels" },',
      'reel_upload: { method: "POST", path: "/{video_id}", origin: "rupload" },',
      'ig_container: { method: "POST", path: "/{ig_user_id}/media" },',
      'ig_publish: { method: "POST", path: "/{ig_user_id}/media_publish" },',
      'campaign_update: { method: "POST", path: "/{campaign_id}" },',
      'campaign_create: { method: "POST", path: "/act_{ad_account_id}/campaigns" },',
      'method: "GET" | "POST" | "DELETE";',
      'const asBody = "bearer" in auth && method === "POST";',
    ]);
    expect(code.filter((l) => /\bDELETE\b/.test(l))).toEqual([
      'page_post_delete: { method: "DELETE", path: "/{post_id}" },',
      'ig_media_delete: { method: "DELETE", path: "/{ig_media_id}" },',
      'method: "GET" | "POST" | "DELETE";',
    ]);
    expect(source).not.toMatch(/access_token=/);
    // No native scheduling (P3-21b): a post Meta holds would go out after an emergency stop.
    expect(code.join("\n")).not.toMatch(/scheduled_publish_time|unpublished_content_type/);
    const methods = [...source.matchAll(/method:\s*([^,;\n}]+)/g)].map((m) => m[1]?.trim());
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect([
        '"GET"',
        '"POST"',
        '"DELETE"',
        '"GET" | "POST" | "DELETE"',
        'MetaRequestSpec["method"]',
        "init.method",
      ]).toContain(method);
    }
  });

  it("THE BUILD GATE (review D #6): no publisher outside executeProposal — the carousel seam is for tests only", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const self = join(root, "lib", "execution", "providers", "meta.ts");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && full !== self) {
          if (readFileSync(full, "utf8").includes("instagramPublishForTests")) offenders.push(full);
        }
      }
    };
    for (const dir of ["lib", "app", "components", "scripts", "db"]) walk(join(root, dir));
    expect(offenders).toEqual([]);
    // The execution object offers no publisher of its own beside the engine's provider.
    const exec = createMetaExecution({
      fetch: async () => ({ status: 500, json: async () => ({}) }),
    });
    expect(Object.keys(exec).sort()).toEqual(["ads", "login", "publish", "readback", "verifier"]);
    // The seam has no default transport: its fetch is a required argument.
    const source = readFileSync(self, "utf8");
    expect(source).toMatch(/export function instagramPublishForTests\(\s*fetch: MetaExecFetch,/);
  });

  it("THE BUILD GATE (rule 17): no publish call path can skip is_ai_generated or the caption disclosure", () => {
    // Every POST is either disclosure-checked, or carries no caption at all.
    const posts = Object.entries(META_EXEC_REQUESTS)
      .filter(([, r]) => r.method === "POST")
      .map(([k]) => k);
    const checked = new Set(["ig_container", ...Object.keys(DISCLOSED_TEXT_FIELD)]);
    // reel_upload sends the file, ig_publish a container id: neither carries text.
    const captionless = new Set(["token_exchange", "reel_upload", "ig_publish"]);
    // The ad writes publish nothing; their own check (adWriteViolation) bounds every field.
    const adWrites = new Set(Object.keys(AD_WRITE_FIELDS));
    for (const k of posts) {
      expect(checked.has(k) || captionless.has(k) || adWrites.has(k)).toBe(true);
    }
    expect(Object.keys(DISCLOSED_TEXT_FIELD).sort()).toEqual([
      "page_feed",
      "page_photos",
      "page_reels",
    ]);

    const source = readFileSync(fileURLToPath(new URL("./meta.ts", import.meta.url)), "utf8");
    // The check is the first thing the one request helper does, before anything is fetched.
    const helper = source.slice(source.indexOf("async function metaCall("));
    const check = helper.indexOf(
      "if (disclosureViolation(which, params) !== null) throw new UndisclosedPublishError(which);",
    );
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(helper.indexOf("ctx.fetch(url, init)"));
    // One function makes Instagram containers, and it sets is_ai_generated last.
    expect(source.match(/"ig_container",/g)).toHaveLength(1);
    const maker = source.slice(source.indexOf("async function igContainer("));
    expect(maker.slice(0, maker.indexOf("\n}\n"))).toContain(
      '{ ...params, is_ai_generated: "true" }',
    );
  });

  it("the disclosure check: passes a disclosed caption and a flagged container, refuses the rest", () => {
    const disclosed = "The soup is back.\n\nWritten with AI assistance.";
    expect(disclosureViolation("page_feed", { message: disclosed })).toBeNull();
    expect(disclosureViolation("page_feed", { message: "The soup is back." })).toBe("page_feed");
    expect(disclosureViolation("page_photos", { url: "u", message: disclosed })).toBeNull();
    expect(disclosureViolation("page_photos", { url: "u" })).toBe("page_photos");
    expect(
      disclosureViolation("page_reels", {
        upload_phase: "finish",
        description: "AI-assisted edit of real footage. No AI-generated imagery.",
      }),
    ).toBeNull();
    expect(disclosureViolation("page_reels", { upload_phase: "finish", description: "x" })).toBe(
      "page_reels",
    );
    expect(disclosureViolation("page_reels", { upload_phase: "start" })).toBeNull();
    expect(
      disclosureViolation("ig_container", { image_url: "u", is_ai_generated: "true" }),
    ).toBeNull();
    expect(disclosureViolation("ig_container", { image_url: "u" })).toBe("ig_container");
    expect(disclosureViolation("ig_container", { image_url: "u", is_ai_generated: "false" })).toBe(
      "ig_container",
    );
    expect(disclosureViolation("page", {})).toBeNull();
  });

  it("THE BUILD GATE (rule 18): no registered path under act_* names billing, funding or payment methods", () => {
    expect(auditMetaRequests()).toEqual([]);
    expect(
      auditMetaRequests({
        a: { method: "GET", path: "/act_{ad_account_id}/funding_source_details" },
        b: { method: "GET", path: "/act_{ad_account_id}/payment_methods" },
        c: { method: "GET", path: "/act_{ad_account_id}/billing_events" },
        d: { method: "GET", path: "/act_{ad_account_id}/campaigns" },
      }),
    ).toEqual([
      "GET /act_{ad_account_id}/funding_source_details",
      "GET /act_{ad_account_id}/payment_methods",
      "GET /act_{ad_account_id}/billing_events",
    ]);
  });
});

describe("P3-23a — the readback reads only, under the readback scopes only", () => {
  it("THE BUILD GATE: every readback request is a registered GET relying on declared readback scopes, never a write scope", () => {
    const spec = EXECUTION_SCOPE_REGISTRY.meta_publish;
    const readback = new Set<string>(spec.readback_scopes);
    const writes = new Set<string>(spec.write_scopes);
    for (const [request, scopes] of Object.entries(META_READBACK_REQUESTS)) {
      const registered = META_EXEC_REQUESTS[request as keyof typeof META_EXEC_REQUESTS];
      expect(registered?.method, request).toBe("GET");
      for (const scope of scopes) {
        expect(readback.has(scope), `${request} relies on ${scope}`).toBe(true);
        expect(writes.has(scope), `${request} relies on write scope ${scope}`).toBe(false);
      }
    }
    // The insight paths are exactly these two, and nothing else ends in /insights.
    expect(
      Object.entries(META_EXEC_REQUESTS)
        .filter(([, r]) => r.path.endsWith("/insights"))
        .map(([k]) => k)
        .sort(),
    ).toEqual(["ig_media_insights", "page_post_insights"]);
  });

  it("views-based metrics only: no *_unique metric and no impressions are ever asked for", () => {
    for (const metric of [...IG_POST_METRICS, ...FB_POST_METRICS]) {
      expect(metric).not.toMatch(/_unique$|impressions/);
    }
    expect([...IG_POST_METRICS]).toEqual(["views", "reach", "total_interactions"]);
    expect([...FB_POST_METRICS]).toEqual(["post_media_view", "post_reactions_by_type_total"]);
    // The failing case the check exists for.
    expect("post_impressions_unique").toMatch(/_unique$|impressions/);
  });

  it("parses both answer shapes; a metric Meta leaves out is null, never zero", () => {
    expect(
      parseIgInsights({
        data: [
          { name: "views", period: "lifetime", values: [{ value: 120 }] },
          { name: "reach", period: "lifetime", total_value: { value: 80 } },
        ],
      }),
    ).toEqual({ views: 120, reach: 80, interactions: null });
    expect(parseIgInsights({ data: [] })).toEqual({ views: null, reach: null, interactions: null });
    expect(
      parseFbPostInsights({
        data: [
          { name: "post_media_view", values: [{ value: 300 }] },
          { name: "post_reactions_by_type_total", values: [{ value: { like: 5, love: 2 } }] },
        ],
      }),
    ).toEqual({ views: 300, reach: null, interactions: 7 });
    expect(
      parseFbPostInsights({ data: [{ name: "post_media_view", values: [{ value: -1 }] }] }),
    ).toEqual({ views: null, reach: null, interactions: null });
  });
});

describe("P3-22b — what an ad write may carry", () => {
  it("THE BUILD GATE: DELETED and ARCHIVED appear nowhere in the code, and the only statuses sent are PAUSED and ACTIVE", () => {
    const source = readFileSync(fileURLToPath(new URL("./meta.ts", import.meta.url)), "utf8");
    const code = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
    // Both are permanent on Meta, so "delete campaign" is not an op.
    expect(code.join("\n")).not.toMatch(/DELETED|ARCHIVED/);
    expect([...AD_STATUSES]).toEqual(["PAUSED", "ACTIVE"]);
    // Every status literal the code sends is one of the two.
    const literals = [...code.join("\n").matchAll(/status: "([A-Z_]+)"/g)].map((m) => m[1]);
    expect(literals.length).toBeGreaterThan(0);
    for (const l of literals) expect(AD_STATUSES).toContain(l);
    // One function sends the dry run, and every ad write goes through it.
    expect(code.filter((l) => l.includes("execution_options: VALIDATE_ONLY"))).toHaveLength(1);
  });

  it("adWriteViolation: passes the writes SYB makes, refuses every other field and status", () => {
    const dry = { execution_options: VALIDATE_ONLY };
    expect(adWriteViolation("campaign_update", { status: "PAUSED" })).toBeNull();
    expect(adWriteViolation("campaign_update", { status: "ACTIVE", ...dry })).toBeNull();
    expect(adWriteViolation("campaign_update", { daily_budget: "1200" })).toBeNull();
    for (const status of ["DELE" + "TED", "ARCH" + "IVED", "paused", ""]) {
      expect(adWriteViolation("campaign_update", { status })).toMatch(/PAUSED or ACTIVE only/);
    }
    expect(adWriteViolation("campaign_update", { spend_cap: "100" })).toMatch(/"spend_cap"/);
    expect(adWriteViolation("campaign_update", { lifetime_budget: "100" })).toMatch(
      /"lifetime_budget"/,
    );
    expect(adWriteViolation("campaign_update", { daily_budget: "0" })).toMatch(/positive whole/);
    expect(adWriteViolation("campaign_update", { daily_budget: "12.5" })).toMatch(/positive whole/);
    expect(adWriteViolation("campaign_update", {})).toMatch(/status or a daily budget/);
    expect(
      adWriteViolation("campaign_update", { status: "PAUSED", execution_options: "[]" }),
    ).toMatch(/validate_only/);
    const create = {
      name: "Winter",
      objective: "OUTCOME_TRAFFIC",
      status: "PAUSED",
      special_ad_categories: "[]",
      buying_type: "AUCTION",
    };
    expect(adWriteViolation("campaign_create", create)).toBeNull();
    expect(adWriteViolation("campaign_create", { ...create, status: "ACTIVE" })).toMatch(
      /created PAUSED/,
    );
    expect(adWriteViolation("campaign_create", { ...create, buying_type: "RESERVED" })).toMatch(
      /AUCTION/,
    );
    expect(adWriteViolation("campaign_create", { ...create, objective: "LINK_CLICKS" })).toMatch(
      /objectives/,
    );
    expect(
      adWriteViolation("campaign_create", { ...create, special_ad_categories: '["CASINO"]' }),
    ).toMatch(/special_ad_categories/);
    expect(adWriteViolation("page", { status: "anything" })).toBeNull(); // not an ad write
  });

  it("an op the registry doesn't name never reaches Meta", async () => {
    const { exec, calls } = meta();
    const ctx = { profile_id: "p", account_id: "a" };
    await expect(exec.ads.execute("delete_campaign", {}, ctx)).rejects.toThrow(
      /not an ad change SYB makes/,
    );
    expect(calls).toHaveLength(0);
  });

  it("THE BUILD GATE (rule 18, re-proven): no registered op, path or ad field names billing, funding, payment methods or payment cycles", () => {
    const money = (v: string) => touchesMoneySurface(v) || /cycle|spend_cap/i.test(v);
    const ops = Object.values(EXECUTION_SCOPE_REGISTRY).flatMap((p) =>
      p.operations.map((o) => o.op),
    );
    expect(ops.filter(money)).toEqual([]);
    expect(
      Object.values(META_EXEC_REQUESTS)
        .map((r) => r.path)
        .filter(money),
    ).toEqual([]);
    expect(Object.values(AD_WRITE_FIELDS).flat().filter(money)).toEqual([]);
    // And the check bites: planted money surfaces are caught.
    for (const planted of [
      "/act_{ad_account_id}/adspaymentcycle",
      "/act_{ad_account_id}/funding_source_details",
      "/act_{ad_account_id}/payment_methods",
      "/act_{ad_account_id}/billing_events",
      "spend_cap",
      "set_payment_method",
    ]) {
      expect(money(planted)).toBe(true);
    }
  });

  it("both Meta providers write to a real platform, so the Session D gate covers them", () => {
    const { exec } = meta();
    expect(exec.publish.external).toBe(true);
    expect(exec.ads.external).toBe(true);
  });

  it("P3-22d: reads ads_api_access_tier from whichever usage header carries it", () => {
    const h = (o: Record<string, string>) => (n: string) => o[n] ?? null;
    expect(adsAccessTier(h({}))).toBeNull();
    expect(
      adsAccessTier(
        h({
          "x-business-use-case-usage": JSON.stringify({
            "1": [
              { type: "ads_management", call_count: 3, ads_api_access_tier: "standard_access" },
            ],
          }),
        }),
      ),
    ).toBe("standard_access");
    expect(
      adsAccessTier(
        h({
          "x-ad-account-usage": JSON.stringify({
            acc_id_util_pct: 9,
            ads_api_access_tier: "development_access",
          }),
        }),
      ),
    ).toBe("development_access");
    expect(
      adsAccessTier(
        h({
          "x-fb-ads-insights-throttle": JSON.stringify({ ads_api_access_tier: "standard_access" }),
        }),
      ),
    ).toBe("standard_access");
    // Only a short word is stored and shown.
    expect(
      adsAccessTier(
        h({ "x-ad-account-usage": JSON.stringify({ ads_api_access_tier: "<b>x</b>" }) }),
      ),
    ).toBeNull();
  });
});

/* ── connecting for real: the done-when's first two clauses, against the database ── */

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const accountIds = created.map((s) => s.account_id);
  const profileIds = created.map((s) => s.profile_id);
  if (accountIds.length > 0) {
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, profileIds));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, profileIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
});

describe("P3-20 done-when — a system-user token connects as an execute connection", () => {
  it("exactly the registered scopes connect; the secret is encrypted at rest and never returned", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const { exec } = meta({ permissions: granted(...PUBLISH_SCOPES) });
    const pub = await connectForExecution({
      accountId: s.account_id,
      provider: "meta_publish",
      secret: PUBLISH_SECRET,
      verify: exec.verifier("meta_publish"),
    });
    expect(pub).toMatchObject({
      purpose: "execute",
      status: "connected",
      provider: "meta_publish",
    });
    expect(pub.granted_scopes).toEqual([...PUBLISH_SCOPES]);
    expect(JSON.stringify(pub)).not.toContain(TOKEN);

    const [row] = await db.select().from(connections).where(eq(connections.id, pub.id));
    expect(row?.encrypted_secret).not.toBeNull();
    expect(row?.encrypted_secret).not.toContain(TOKEN);
    expect(decryptSecret(row?.encrypted_secret as string)).toBe(PUBLISH_SECRET);
  });

  it("a token with one scope too many is refused by name and nothing is stored", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const { exec } = meta({ permissions: granted("ads_management", "business_management") });
    await expect(
      connectForExecution({
        accountId: s.account_id,
        provider: "meta_ads",
        secret: ADS_SECRET,
        verify: exec.verifier("meta_ads"),
      }),
    ).rejects.toThrow(/"business_management"/);
    expect(
      await db.select().from(connections).where(eq(connections.account_id, s.account_id)),
    ).toHaveLength(0);
  });
});
