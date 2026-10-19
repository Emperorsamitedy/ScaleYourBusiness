// P3-20j — Facebook Login for pilot route 1, testers, against a recorded-shape Graph API.
//
// What these tests hold:
//
//   · THE STATE. Signed, ten minutes, single use, bound to the account:
//     a valid one passes; tampered, expired, foreign, missing-nonce and
//     reused-nonce ones are refused, each by its own reason.
//   · THE ASK. The scope parameter is exactly the registry's write +
//     readback scopes for the consent; a list with an extra scope is
//     refused by name; the dialog URL carries nothing else.
//   · THE FLOW. Phrase typed before any redirect; code exchanged and made
//     long-lived server-side; Pages (with Instagram) or ad accounts listed;
//     the pick handed to the same consentToExecution as a pasted token —
//     exact scopes, encrypted at rest, a consent row. A cancel, a failed
//     exchange, an extra scope, a wrong phrase and a missing pending
//     sign-in all refuse and store nothing.
//   · NO NETWORK. Every Graph call goes to the injected fake; the global
//     fetch is replaced by one that fails the test if anything calls it.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  decisionLog,
  fieldRecords,
  intakeEvents,
} from "../../db/schema";
import type { MetaResponse } from "../connectors/providers/meta-ads";
import { metaError, metaJson } from "../connectors/providers/meta-fake";
import { decryptSecret } from "../connectors/secrets";
import { metaLoginEnv } from "../env";
import { bootstrapIntake } from "../intake/service";
import { ExecutionConnectionError, expectedExecutionScopes } from "./connections";
import { consentLines, hashConsentPayload } from "./consent";
import type { MetaLoginConfig, MetaLoginState } from "./meta-login";
import {
  META_DIALOG_URL,
  META_LOGIN_COOKIE_PATH,
  META_LOGIN_TTL_MS,
  MetaLoginError,
  buildAuthorizeUrl,
  completeMetaCallback,
  connectionsReturnUrl,
  cookieSecure,
  finishMetaLogin,
  listMetaCandidates,
  loginCookieOptions,
  loginScopes,
  metaLoginConfig,
  openPending,
  phraseHash,
  sealPending,
  startMetaLogin,
  signLoginState,
  startedElsewhere,
  verifyLoginState,
} from "./meta-login";
import type { MetaExecFetch, MetaExecRequestInit } from "./providers/meta";
import { createMetaExecution } from "./providers/meta";

const APP_ID = "1234567890123";
const APP_SECRET = "fake-app-secret-for-tests-only";
const CODE = "AQFakeSignInCodeForTestsOnly";
const BAD_CODE = "AQFakeRejectedCode";
const SHORT = "EAAFakeShortLivedUserTokenForTests";
const LONG = "EAAFakeLongLivedUserTokenForTests";
const PAGE_TOKEN = "EAAFakeDerivedPageTokenForTests";
const PAGE = "1000000001";
const PAGE_NO_IG = "1000000002";
const IG = "17800000000000001";
const ACT = "2000000002";
const V = "/v26.0";

const CONFIG = metaLoginConfig(
  { app_id: APP_ID, app_secret: APP_SECRET, redirect_uri: null, app_url: "https://syb.test" },
  "http://ignored.example",
) as MetaLoginConfig;

const PUBLISH_SCOPES = expectedExecutionScopes("meta_publish");
const ADS_SCOPES = expectedExecutionScopes("meta_ads");

type Perm = { permission: string; status: string };
const granted = (...names: string[]): Perm[] => [
  ...names.map((permission) => ({ permission, status: "granted" })),
  { permission: "public_profile", status: "granted" },
];

interface Call {
  url: URL;
  init: MetaExecRequestInit;
  form: URLSearchParams | null;
}

function fakeGraph(options: { permissions?: Perm[] } = {}) {
  const calls: Call[] = [];
  const fetch: MetaExecFetch = async (url, init): Promise<MetaResponse> => {
    const form = init.body !== undefined ? new URLSearchParams(init.body) : null;
    const call = { url: new URL(url), init, form };
    calls.push(call);
    const path = call.url.pathname;

    if (init.method === "POST" && path === `${V}/oauth/access_token` && form !== null) {
      if (form.get("client_id") !== APP_ID || form.get("client_secret") !== APP_SECRET) {
        return metaError(101, "Error validating client secret.");
      }
      if (form.get("grant_type") === "fb_exchange_token") {
        return form.get("fb_exchange_token") === SHORT
          ? metaJson(200, { access_token: LONG, token_type: "bearer", expires_in: 5183944 })
          : metaError(190, "Invalid OAuth access token.");
      }
      if (form.get("code") === CODE && form.get("redirect_uri") === CONFIG.redirect_uri) {
        return metaJson(200, { access_token: SHORT, token_type: "bearer", expires_in: 3600 });
      }
      return metaError(100, "Invalid verification code format.");
    }
    if (init.method !== "GET") return metaError(100, "Unsupported request");

    const auth = init.headers["authorization"];
    if (auth !== `Bearer ${LONG}` && auth !== `Bearer ${PAGE_TOKEN}`) {
      return metaError(190, "Invalid OAuth access token - Cannot parse access token");
    }
    if (path === `${V}/me/accounts`) {
      return metaJson(200, {
        data: [
          {
            id: PAGE,
            name: "Ember & Oak",
            instagram_business_account: { id: IG, username: "emberandoak" },
          },
          { id: PAGE_NO_IG, name: "Ember & Oak Events" },
        ],
      });
    }
    if (path === `${V}/me/adaccounts`) {
      return metaJson(200, {
        data: [{ id: `act_${ACT}`, name: "Ember & Oak ads", account_status: 1 }],
      });
    }
    if (path === `${V}/me/permissions`) return metaJson(200, { data: options.permissions ?? [] });
    if (path === `${V}/${PAGE}` || path === `${V}/${PAGE_NO_IG}`) {
      return metaJson(200, {
        id: path.slice(V.length + 1),
        name: "Ember & Oak",
        access_token: PAGE_TOKEN,
      });
    }
    if (path === `${V}/${IG}`) return metaJson(200, { id: IG, username: "emberandoak" });
    if (path === `${V}/act_${ACT}`) {
      return metaJson(200, { id: `act_${ACT}`, name: "Ember & Oak ads", currency: "EUR" });
    }
    return metaError(100, "Unsupported get request.", 33);
  };
  return {
    calls,
    exec: createMetaExecution({ fetch, sleep: async () => {} }),
  };
}

/** No real network, anywhere in this file: the global fetch fails the test if touched. */
const realFetchUsed = vi.fn(async () => {
  throw new Error("a real fetch was attempted in a P3-20j test");
});
beforeAll(() => {
  vi.stubGlobal("fetch", realFetchUsed);
});

const created: { account_id: string; profile_id: string }[] = [];
async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

afterAll(async () => {
  expect(realFetchUsed).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  const accountIds = created.map((s) => s.account_id);
  const profileIds = created.map((s) => s.profile_id);
  if (accountIds.length > 0) {
    // The decision log is append-only (rule 7): its consent rows outlive the test.
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, profileIds));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, profileIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
});

const NOW = new Date("2026-10-18T10:00:00Z");

function aState(overrides: Partial<MetaLoginState> = {}): MetaLoginState {
  return {
    v: 1,
    account_id: "acct-1",
    profile_id: "prof-1",
    provider: "meta_publish",
    nonce: "nonce-abc",
    phrase_hash: phraseHash("allow publishing"),
    issued_at: NOW.getTime(),
    ...overrides,
  };
}

async function refusal(fn: () => unknown): Promise<MetaLoginError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MetaLoginError);
    return error as MetaLoginError;
  }
  throw new Error("expected a refusal");
}

/* ── pure ──────────────────────────────────────────────────────────── */

describe("P3-20j — the signed state", () => {
  const ok = { nonceCookie: "nonce-abc", accountId: "acct-1", now: NOW };

  it("a state we signed, inside ten minutes, with its nonce cookie and account, verifies", () => {
    expect(verifyLoginState(signLoginState(aState()), ok)).toMatchObject({
      account_id: "acct-1",
      profile_id: "prof-1",
      provider: "meta_publish",
    });
    const nineMinutes = new Date(NOW.getTime() + 9 * 60 * 1000);
    expect(() =>
      verifyLoginState(signLoginState(aState()), { ...ok, now: nineMinutes }),
    ).not.toThrow();
  });

  it("THE ATTACK: a tampered payload or signature is refused", async () => {
    const token = signLoginState(aState());
    const [body, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify(aState({ account_id: "attacker-account" }))).toString(
      "base64url",
    );
    expect((await refusal(() => verifyLoginState(`${forged}.${sig}`, ok))).reason).toBe("tampered");
    const flipped = `${body}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;
    expect((await refusal(() => verifyLoginState(flipped, ok))).reason).toBe("tampered");
    expect((await refusal(() => verifyLoginState("not-a-state", ok))).reason).toBe("tampered");
    expect((await refusal(() => verifyLoginState(null, ok))).reason).toBe("missing_state");
  });

  it("an expired state (over ten minutes) or one issued in the future is refused", async () => {
    const late = new Date(NOW.getTime() + META_LOGIN_TTL_MS + 1);
    expect(
      (await refusal(() => verifyLoginState(signLoginState(aState()), { ...ok, now: late })))
        .reason,
    ).toBe("expired");
    const future = aState({ issued_at: NOW.getTime() + 5 * 60 * 1000 });
    expect((await refusal(() => verifyLoginState(signLoginState(future), ok))).reason).toBe(
      "expired",
    );
  });

  it("THE ATTACK: a state started by another account is refused for the account signed in", async () => {
    const e = await refusal(() =>
      verifyLoginState(signLoginState(aState()), { ...ok, accountId: "acct-2" }),
    );
    expect(e.reason).toBe("foreign");
    expect(e.status).toBe(403);
  });

  it("single use: no nonce cookie (cleared by the first callback) or another start's nonce is refused", async () => {
    const token = signLoginState(aState());
    expect(
      (await refusal(() => verifyLoginState(token, { ...ok, nonceCookie: null }))).reason,
    ).toBe("no_nonce");
    expect(
      (await refusal(() => verifyLoginState(token, { ...ok, nonceCookie: "a-later-nonce" })))
        .reason,
    ).toBe("nonce_mismatch");
  });

  it("a state carrying the hash of any other phrase is refused", async () => {
    const wrong = aState({ phrase_hash: phraseHash("yes") });
    expect((await refusal(() => verifyLoginState(signLoginState(wrong), ok))).reason).toBe(
      "phrase",
    );
  });
});

describe("P3-20j — the ask: exactly the registry's scopes", () => {
  it("the scope list is the registry's write + readback scopes, for each consent", () => {
    expect(loginScopes("meta_publish").split(",")).toEqual([...PUBLISH_SCOPES]);
    expect(loginScopes("meta_ads").split(",")).toEqual([...ADS_SCOPES]);
    expect(loginScopes("meta_ads")).toBe("ads_management");
  });

  it("a scope list with one scope too many, or too few, is refused by name", () => {
    expect(() => loginScopes("meta_publish", [...PUBLISH_SCOPES, "business_management"])).toThrow(
      /"business_management" which the consent does not name/,
    );
    expect(() => loginScopes("meta_ads", [])).toThrow(/missing "ads_management"/);
  });

  it("the dialog URL: Meta's v26.0 OAuth dialog, the code flow, the registry scopes, the state — nothing else", () => {
    const url = new URL(
      buildAuthorizeUrl({
        appId: APP_ID,
        redirectUri: CONFIG.redirect_uri,
        provider: "meta_publish",
        state: "signed-state",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(META_DIALOG_URL);
    expect(META_DIALOG_URL).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP_ID,
      redirect_uri: "https://syb.test/api/connections/meta/callback",
      response_type: "code",
      scope: [...PUBLISH_SCOPES].join(","),
      state: "signed-state",
    });
    expect(url.toString()).not.toContain(APP_SECRET);
  });
});

describe("P3-20j — configuration and cookies", () => {
  const saved = {
    id: process.env.META_APP_ID,
    secret: process.env.META_APP_SECRET,
    redirect: process.env.META_OAUTH_REDIRECT_URI,
  };
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  it("Facebook Login is armed only when BOTH the app id and the app secret are set", () => {
    try {
      process.env.META_APP_ID = APP_ID;
      delete process.env.META_APP_SECRET;
      expect(metaLoginEnv()).toBeNull();
      process.env.META_APP_SECRET = APP_SECRET;
      delete process.env.META_OAUTH_REDIRECT_URI;
      expect(metaLoginEnv()).toMatchObject({ app_id: APP_ID, redirect_uri: null });
      delete process.env.META_APP_ID;
      expect(metaLoginEnv()).toBeNull();
    } finally {
      restore("META_APP_ID", saved.id);
      restore("META_APP_SECRET", saved.secret);
      restore("META_OAUTH_REDIRECT_URI", saved.redirect);
    }
  });

  it("the redirect: META_OAUTH_REDIRECT_URI wins, else APP_URL, else the request's origin", () => {
    const base = { app_id: APP_ID, app_secret: APP_SECRET };
    expect(
      metaLoginConfig(
        { ...base, redirect_uri: "https://syb.example/cb", app_url: "https://syb.example" },
        "http://localhost:3000",
      )?.redirect_uri,
    ).toBe("https://syb.example/cb");
    expect(
      metaLoginConfig({ ...base, redirect_uri: null, app_url: "https://syb.example/" }, "x")
        ?.redirect_uri,
    ).toBe("https://syb.example/api/connections/meta/callback");
    expect(
      metaLoginConfig({ ...base, redirect_uri: null, app_url: null }, "http://localhost:3000")
        ?.redirect_uri,
    ).toBe("http://localhost:3000/api/connections/meta/callback");
    expect(metaLoginConfig(null, "http://localhost:3000")).toBeNull();
  });

  it("cookies: httpOnly, SameSite=Lax, scoped to the flow, ten minutes; Secure except on localhost", () => {
    expect(loginCookieOptions("https://syb.test")).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: META_LOGIN_COOKIE_PATH,
      maxAge: 600,
    });
    expect(cookieSecure("http://localhost:3000")).toBe(false);
    expect(cookieSecure("http://127.0.0.1:3000")).toBe(false);
    expect(cookieSecure("https://syb-kappa.vercel.app")).toBe(true);
  });

  it("the waiting token is sealed: no plaintext token, tamper-proof, bound to account, provider and ten minutes", async () => {
    const pending = {
      v: 1 as const,
      account_id: "acct-1",
      profile_id: "prof-1",
      provider: "meta_publish" as const,
      access_token: LONG,
      phrase_hash: phraseHash("allow publishing"),
      expires_at: NOW.getTime() + META_LOGIN_TTL_MS,
    };
    const sealed = sealPending(pending);
    expect(sealed).not.toContain(LONG);
    expect(Buffer.from(sealed, "base64url").toString("utf8")).not.toContain(LONG);
    const args = { accountId: "acct-1", provider: "meta_publish" as const, now: NOW };
    expect(openPending(sealed, args)).toEqual(pending);
    expect(
      (await refusal(() => openPending(sealed, { ...args, now: new Date(pending.expires_at + 1) })))
        .reason,
    ).toBe("no_pending");
    expect(
      (await refusal(() => openPending(sealed, { ...args, accountId: "acct-2" }))).reason,
    ).toBe("foreign");
    expect(
      (await refusal(() => openPending(sealed, { ...args, provider: "meta_ads" }))).reason,
    ).toBe("no_pending");
    expect((await refusal(() => openPending(`${sealed.slice(0, -4)}AAAA`, args))).reason).toBe(
      "no_pending",
    );
    expect((await refusal(() => openPending(null, args))).reason).toBe("no_pending");
  });

  it("THE ATTACK: a start another site set off (the phrase carried in its link) is refused; our own screen passes", () => {
    expect(startedElsewhere("cross-site")).toBe(true);
    expect(startedElsewhere("same-site")).toBe(true);
    expect(startedElsewhere("same-origin")).toBe(false);
    expect(startedElsewhere("none")).toBe(false);
    expect(startedElsewhere(null)).toBe(false);
  });

  it("the way back to /connections names the outcome, and a failure's sentence", () => {
    const url = new URL(
      connectionsReturnUrl("https://syb.test", {
        kind: "failed",
        provider: "meta_ads",
        message: "Nope.",
      }),
    );
    expect(url.pathname).toBe("/connections");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      meta: "error",
      provider: "meta_ads",
      message: "Nope.",
    });
  });
});

/* ── the flow, against the database ────────────────────────────────── */

async function startFor(
  s: { account_id: string; profile_id: string },
  provider: "meta_publish" | "meta_ads",
  confirmation: string,
) {
  return startMetaLogin({
    accountId: s.account_id,
    profileId: s.profile_id,
    provider,
    confirmation,
    config: CONFIG,
    now: NOW,
  });
}

const stateOf = (authorizeUrl: string) => new URL(authorizeUrl).searchParams.get("state");

async function consentRows(profileId: string) {
  return db
    .select()
    .from(decisionLog)
    .where(and(eq(decisionLog.profile_id, profileId), eq(decisionLog.kind, "consent")));
}

/** Every Graph call was the fake's, to graph.facebook.com/v26.0, a read or the token exchange, no token in a URL. */
function expectOnlyReadsAndTheExchange(calls: Call[]) {
  const allowed = new Set([
    `${V}/oauth/access_token`,
    `${V}/me/accounts`,
    `${V}/me/adaccounts`,
    `${V}/me/permissions`,
    `${V}/${PAGE}`,
    `${V}/${PAGE_NO_IG}`,
    `${V}/${IG}`,
    `${V}/act_${ACT}`,
  ]);
  for (const call of calls) {
    expect(call.url.origin).toBe("https://graph.facebook.com");
    expect(allowed).toContain(call.url.pathname);
    if (call.init.method === "POST") {
      expect(call.url.pathname).toBe(`${V}/oauth/access_token`);
      expect(call.url.search).toBe(""); // the secret and code travel in the body, never the URL
    } else {
      expect(call.init.method).toBe("GET");
    }
    for (const secret of [APP_SECRET, CODE, SHORT, LONG, PAGE_TOKEN]) {
      expect(call.url.toString()).not.toContain(secret);
    }
  }
}

describe("P3-20j — the flow, end to end against the fake Graph API", () => {
  it("publishing: phrase → Meta → code exchanged and made long-lived → Pages with Instagram → pick → connected with consent", async () => {
    const s = await fresh();
    const graph = fakeGraph({ permissions: granted(...PUBLISH_SCOPES) });

    const started = await startFor(s, "meta_publish", "  Allow Publishing ");
    expect(graph.calls).toHaveLength(0); // nothing sent to Meta before the owner goes there

    const outcome = await completeMetaCallback({
      accountId: s.account_id,
      query: { code: CODE, state: stateOf(started.authorize_url), error: null, error_reason: null },
      nonceCookie: started.nonce,
      config: CONFIG,
      exec: graph.exec,
      now: NOW,
    });
    expect(outcome).toMatchObject({ kind: "pick", provider: "meta_publish", count: 2 });
    if (outcome.kind !== "pick") throw new Error("expected a pick");
    expect(outcome.pending).not.toContain(LONG);
    // The code grant, then the long-lived swap, then the list.
    expect(
      graph.calls.map((c) => [c.init.method, c.url.pathname, c.form?.get("grant_type")]),
    ).toEqual([
      ["POST", `${V}/oauth/access_token`, null],
      ["POST", `${V}/oauth/access_token`, "fb_exchange_token"],
      ["GET", `${V}/me/accounts`, undefined],
    ]);

    const list = await listMetaCandidates({
      accountId: s.account_id,
      provider: "meta_publish",
      pendingCookie: outcome.pending,
      exec: graph.exec,
      now: NOW,
    });
    expect(list).toEqual({
      provider: "meta_publish",
      kind: "pages",
      candidates: [
        { id: PAGE, name: "Ember & Oak", instagram: { id: IG, username: "emberandoak" } },
        { id: PAGE_NO_IG, name: "Ember & Oak Events", instagram: null },
      ],
    });
    expect(JSON.stringify(list)).not.toContain(LONG); // what the browser sees

    const connection = await finishMetaLogin({
      accountId: s.account_id,
      profileId: s.profile_id,
      provider: "meta_publish",
      assetId: PAGE,
      pendingCookie: outcome.pending,
      exec: graph.exec,
      now: NOW,
    });
    expect(connection).toMatchObject({ provider: "meta_publish", purpose: "execute" });
    expect(connection.granted_scopes).toEqual([...PUBLISH_SCOPES]);
    expect(JSON.stringify(connection)).not.toContain(LONG);

    // Encrypted at rest; the Instagram id is Meta's answer, not the browser's.
    const [row] = await db.select().from(connections).where(eq(connections.id, connection.id));
    expect(row?.encrypted_secret).not.toContain(LONG);
    expect(JSON.parse(decryptSecret(row?.encrypted_secret as string))).toEqual({
      access_token: LONG,
      page_id: PAGE,
      ig_user_id: IG,
    });

    // The same consent row as the pasted route, over the phrase typed before the redirect.
    const rows = await consentRows(s.profile_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload_hash).toBe(
      hashConsentPayload({
        account_id: s.account_id,
        connection_id: connection.id,
        provider: "meta_publish",
        granted_scopes: PUBLISH_SCOPES,
        consent_lines: consentLines("meta_publish"),
        typed_confirmation: "allow publishing",
      }),
    );
    expectOnlyReadsAndTheExchange(graph.calls);

    // Connected now: a second start is refused before any redirect.
    expect((await refusal(() => startFor(s, "meta_publish", "allow publishing"))).reason).toBe(
      "already_connected",
    );
  });

  it("ad management: the ad accounts are listed and the picked one connects with exactly ads_management", async () => {
    const s = await fresh();
    const graph = fakeGraph({ permissions: granted("ads_management") });
    const started = await startFor(s, "meta_ads", "allow ad changes");
    expect(new URL(started.authorize_url).searchParams.get("scope")).toBe("ads_management");

    const outcome = await completeMetaCallback({
      accountId: s.account_id,
      query: { code: CODE, state: stateOf(started.authorize_url), error: null, error_reason: null },
      nonceCookie: started.nonce,
      config: CONFIG,
      exec: graph.exec,
      now: NOW,
    });
    if (outcome.kind !== "pick") throw new Error(`expected a pick, got ${outcome.kind}`);
    const list = await listMetaCandidates({
      accountId: s.account_id,
      provider: "meta_ads",
      pendingCookie: outcome.pending,
      exec: graph.exec,
      now: NOW,
    });
    expect(list.candidates).toEqual([{ id: ACT, name: "Ember & Oak ads", account_status: 1 }]);

    const connection = await finishMetaLogin({
      accountId: s.account_id,
      profileId: s.profile_id,
      provider: "meta_ads",
      assetId: ACT,
      pendingCookie: outcome.pending,
      exec: graph.exec,
      now: NOW,
    });
    expect(connection.granted_scopes).toEqual(["ads_management"]);
    const [row] = await db.select().from(connections).where(eq(connections.id, connection.id));
    expect(JSON.parse(decryptSecret(row?.encrypted_secret as string))).toEqual({
      access_token: LONG,
      ad_account_id: ACT,
    });
    expect(await consentRows(s.profile_id)).toHaveLength(1);
    expectOnlyReadsAndTheExchange(graph.calls);
  });

  it("the owner cancels on Meta's dialog: a plain message, nothing sent, nothing kept", async () => {
    const s = await fresh();
    const graph = fakeGraph();
    const started = await startFor(s, "meta_publish", "allow publishing");
    const outcome = await completeMetaCallback({
      accountId: s.account_id,
      query: {
        code: null,
        state: stateOf(started.authorize_url),
        error: "access_denied",
        error_reason: "user_denied",
      },
      nonceCookie: started.nonce,
      config: CONFIG,
      exec: graph.exec,
      now: NOW,
    });
    expect(outcome).toEqual({ kind: "cancelled", provider: "meta_publish" });
    expect(graph.calls).toHaveLength(0);
    expect(new URL(connectionsReturnUrl("https://syb.test", outcome)).search).toBe(
      "?meta=cancelled&provider=meta_publish",
    );
  });

  it("a code Meta refuses: the refusal in the owner's words (P3-24a), no token, no secret echoed", async () => {
    const s = await fresh();
    const graph = fakeGraph();
    const started = await startFor(s, "meta_publish", "allow publishing");
    const outcome = await completeMetaCallback({
      accountId: s.account_id,
      query: {
        code: BAD_CODE,
        state: stateOf(started.authorize_url),
        error: null,
        error_reason: null,
      },
      nonceCookie: started.nonce,
      config: CONFIG,
      exec: graph.exec,
      now: NOW,
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("expected a failure");
    expect(outcome.message).toBe(
      "Facebook sign-in didn't finish. Meta refused with code 100; nothing was published.",
    );
    for (const secret of [BAD_CODE, APP_SECRET]) expect(outcome.message).not.toContain(secret);
    expect(graph.calls).toHaveLength(1); // not retryable: one exchange, no swap, no list
  });

  it("THE ATTACK: a replayed callback (nonce cookie already cleared) or another account's state exchanges nothing", async () => {
    const a = await fresh();
    const b = await fresh();
    const graph = fakeGraph();
    const started = await startFor(a, "meta_publish", "allow publishing");
    const query = {
      code: CODE,
      state: stateOf(started.authorize_url),
      error: null,
      error_reason: null,
    };
    const replay = await completeMetaCallback({
      accountId: a.account_id,
      query,
      nonceCookie: null,
      config: CONFIG,
      exec: graph.exec,
      now: NOW,
    });
    expect(replay.kind).toBe("failed");
    const foreign = await completeMetaCallback({
      accountId: b.account_id,
      query,
      nonceCookie: started.nonce,
      config: CONFIG,
      exec: graph.exec,
      now: NOW,
    });
    expect(foreign).toMatchObject({ kind: "failed" });
    if (foreign.kind === "failed") expect(foreign.message).toMatch(/different SYB account/);
    expect(graph.calls).toHaveLength(0);
  });

  it("a token Meta granted one scope too many is refused by connectForExecution, by name, and nothing is stored", async () => {
    const s = await fresh();
    // Meta hands the app every permission the person ever granted it — here, ads too.
    const graph = fakeGraph({ permissions: granted(...PUBLISH_SCOPES, "ads_management") });
    const started = await startFor(s, "meta_publish", "allow publishing");
    const outcome = await completeMetaCallback({
      accountId: s.account_id,
      query: { code: CODE, state: stateOf(started.authorize_url), error: null, error_reason: null },
      nonceCookie: started.nonce,
      config: CONFIG,
      exec: graph.exec,
      now: NOW,
    });
    if (outcome.kind !== "pick") throw new Error("expected a pick");
    await expect(
      finishMetaLogin({
        accountId: s.account_id,
        profileId: s.profile_id,
        provider: "meta_publish",
        assetId: PAGE,
        pendingCookie: outcome.pending,
        exec: graph.exec,
        now: NOW,
      }),
    ).rejects.toThrow(/granted "ads_management" which the consent does not name/);
    expect(
      await db.select().from(connections).where(eq(connections.account_id, s.account_id)),
    ).toHaveLength(0);
    expect(await consentRows(s.profile_id)).toHaveLength(0);
  });

  it("the wrong phrase is refused before any redirect, and an unconfigured app refuses too", async () => {
    const s = await fresh();
    const wrong = await refusal(() => startFor(s, "meta_publish", "yes"));
    expect(wrong.reason).toBe("phrase");
    expect(wrong.message).toMatch(/Type "allow publishing" to confirm\. Nothing was sent to Meta/);
    expect((await refusal(() => startFor(s, "meta_ads", "allow publishing"))).reason).toBe(
      "phrase",
    );
    const off = await refusal(() =>
      startMetaLogin({
        accountId: s.account_id,
        profileId: s.profile_id,
        provider: "meta_publish",
        confirmation: "allow publishing",
        config: null,
      }),
    );
    expect(off.reason).toBe("unavailable");
    expect(off.status).toBe(503);
  });

  it("finish without a waiting sign-in is refused, and a pick that isn't on Meta's list is too", async () => {
    const s = await fresh();
    const graph = fakeGraph({ permissions: granted(...PUBLISH_SCOPES) });
    const none = await refusal(() =>
      finishMetaLogin({
        accountId: s.account_id,
        profileId: s.profile_id,
        provider: "meta_publish",
        assetId: PAGE,
        pendingCookie: null,
        exec: graph.exec,
        now: NOW,
      }),
    );
    expect(none.reason).toBe("no_pending");
    expect(none).toBeInstanceOf(ExecutionConnectionError);
    expect(graph.calls).toHaveLength(0);

    const started = await startFor(s, "meta_publish", "allow publishing");
    const outcome = await completeMetaCallback({
      accountId: s.account_id,
      query: { code: CODE, state: stateOf(started.authorize_url), error: null, error_reason: null },
      nonceCookie: started.nonce,
      config: CONFIG,
      exec: graph.exec,
      now: NOW,
    });
    if (outcome.kind !== "pick") throw new Error("expected a pick");
    const elsewhere = await refusal(() =>
      finishMetaLogin({
        accountId: s.account_id,
        profileId: s.profile_id,
        provider: "meta_publish",
        assetId: "9999999999",
        pendingCookie: outcome.pending,
        exec: graph.exec,
        now: NOW,
      }),
    );
    expect(elsewhere.reason).toBe("bad_pick");
    expect(
      await db.select().from(connections).where(eq(connections.account_id, s.account_id)),
    ).toHaveLength(0);
  });
});
