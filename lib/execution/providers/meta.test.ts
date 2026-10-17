// P3-20f/g — the Meta write connector, against a recorded-shape Graph API.
//
// What these tests hold:
//
//   · PROVEN BEFORE STORED. A token with exactly a consent's scopes
//     connects as an execute connection, encrypted, never returned; one
//     scope too many or too few is refused by name before any asset is
//     touched; the asset itself (Page, Instagram account, ad account) must
//     answer to the token.
//   · WHAT IT CAN SEND. Only the registered requests, GET only, the token
//     in a header and never in a URL; the source scan fails the build
//     otherwise. No registered path under act_* names a money surface.
//   · THE OPS ARE NAMED, NOT BUILT. Every op refuses by name until D2/D3.

import "dotenv/config";
import { readFileSync } from "node:fs";
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
import { bootstrapIntake } from "../../intake/service";
import {
  ExecutionConnectionError,
  connectForExecution,
  expectedExecutionScopes,
} from "../connections";
import type { MetaExecFetch, MetaExecRequestInit, MetaExecutionProviderId } from "./meta";
import {
  META_EXEC_MAX_ATTEMPTS,
  META_EXEC_REQUESTS,
  MetaOpNotBuiltError,
  auditMetaRequests,
  createMetaExecution,
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
    expect((error as Error).message).toMatch(/not accepted/);
    expect((error as Error).message).not.toContain("EAAwrongToken");
  });

  it("rate limiting retries to the cap, then fails", async () => {
    const { exec, calls } = meta({ respond: () => metaError(17, "User request limit reached") });
    await expect(exec.verifier("meta_ads")(ADS_SECRET)).rejects.toThrow(/still rate limited/);
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
    });
    const source = readFileSync(fileURLToPath(new URL("./meta.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(source).not.toMatch(/access_token=/);
    const methods = [...source.matchAll(/method:\s*([^,;\n}]+)/g)].map((m) => m[1]?.trim());
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(['"GET"', "init.method", "META_EXEC_REQUESTS[which].method"]).toContain(method);
    }
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

describe("P3-20g — the ops are named, not built", () => {
  it("every op refuses by name, and capturing an undo refuses rather than claiming irreversibility", async () => {
    const { exec, calls } = meta();
    const ctx = { profile_id: "p", account_id: "a" };
    await expect(exec.publish.execute("publish_page_post", {}, ctx)).rejects.toThrow(
      MetaOpNotBuiltError,
    );
    await expect(exec.publish.captureUndo("publish_ig_media", {}, ctx)).rejects.toThrow(/P3-21b/);
    await expect(exec.ads.execute("pause_campaign", {}, ctx)).rejects.toThrow(/P3-22b/);
    await expect(exec.ads.undo("set_daily_budget", {}, ctx)).rejects.toThrow(
      /nothing was sent to Meta/,
    );
    expect(calls).toHaveLength(0);
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
