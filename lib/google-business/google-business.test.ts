// I-45a — the Google Business Profile consent and the daily read, against
// the database and a recorded-shape fake of Google (./fake.ts). No network:
// global fetch is stubbed to fail, so anything that slipped past the fake
// would fail the test.
//
//   · the consent: a typed phrase, Google's grant holding exactly the one
//     scope, a refresh token, the access encrypted at rest, a decision-log
//     consent row (ids and a hash), undone with nothing at rest on refusal;
//   · revoke: the access deleted here at once;
//   · the read: reviews land as source "google", once, deduped against the
//     same review by email in either order, alerts only for the last week,
//     and a Google failure is recorded and survived.

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
  reviewSettings,
  reviews,
  watchActivity,
} from "../../db/schema";
import { ExecutionConnectionError } from "../execution/connections";
import { googleBusinessExecutor } from "../execution/providers/google-business";
import { bootstrapIntake } from "../intake/service";
import { ensureReviewSettings } from "../review-desk/settings";
import { fileReview } from "../reviews/store";
import { GBP_SCOPE } from "./client";
import {
  GOOGLE_REVIEWS_PHRASE,
  consentToGoogleReviews,
  googleConsentLines,
  hashGoogleConsent,
  revokeGoogleReviews,
} from "./consent";
import type { FakeReview } from "./fake";
import { fakeGoogle } from "./fake";
import {
  codeChallengeFor,
  codeVerifierFor,
  completeGoogleCallback,
  finishGoogleLogin,
  googleLoginConfig,
  signGoogleState,
  startGoogleLogin,
} from "./login";
import { phraseHash } from "../execution/meta-login";
import { GOOGLE_AUTH_LOST, GOOGLE_READ_LIMITS, runGoogleReviewReads } from "./read";

const ENV = {
  client_id: "test-client.apps.googleusercontent.com",
  client_secret: "test-secret",
  redirect_uri: null,
  app_url: "http://localhost:3000",
};
const CONFIG = googleLoginConfig(ENV, "http://localhost:3000");
const CLIENT = { client_id: ENV.client_id, client_secret: ENV.client_secret };
const NOW = new Date();
const DAY = 86_400_000;
const created: { account_id: string; profile_id: string }[] = [];

beforeAll(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length > 0) {
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
    await db.delete(reviews).where(inArray(reviews.profile_id, ids));
    await db.delete(reviewSettings).where(inArray(reviewSettings.profile_id, ids));
    await db.delete(watchActivity).where(inArray(watchActivity.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
});

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  await ensureReviewSettings(s.profile_id);
  return s;
}

const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

const LOCATION = {
  account: "accounts/111",
  location: "locations/222",
  title: "Lumen Hair Studio",
  maps_uri: "https://maps.google.com/maps?cid=1234",
};

/** Connect a business through the consent, against a fake that answers with exactly the scope. */
async function connected(s: { account_id: string; profile_id: string }, fakeOpts = {}) {
  const fake = fakeGoogle(fakeOpts);
  const { connection } = await consentToGoogleReviews({
    accountId: s.account_id,
    profileId: s.profile_id,
    userId: null,
    confirmation: GOOGLE_REVIEWS_PHRASE,
    refreshToken: "1//fake-refresh",
    location: LOCATION,
    client: CLIENT,
    fetchImpl: fake.fetch,
  });
  return connection;
}

/** A started sign-in's state and nonce, as the start step makes them. */
function started(s: { account_id: string; profile_id: string }, over = {}) {
  const nonce = `nonce-${crypto.randomUUID()}`;
  const state = signGoogleState({
    v: 1,
    account_id: s.account_id,
    profile_id: s.profile_id,
    nonce,
    phrase_hash: phraseHash(GOOGLE_REVIEWS_PHRASE),
    issued_at: NOW.getTime(),
    ...over,
  });
  return { nonce, state };
}

async function storedFor(accountId: string) {
  return db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.provider, "google_business_reviews"),
      ),
    );
}

/* ── starting ── */

describe("I-45a — starting the sign-in", () => {
  it("asks Google for exactly business.manage, offline, with consent and PKCE (S256)", async () => {
    const s = await business();
    const { authorize_url, nonce } = await startGoogleLogin({
      accountId: s.account_id,
      profileId: s.profile_id,
      confirmation: " Allow Replies And Hours ",
      config: CONFIG,
    });
    const u = new URL(authorize_url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe(GBP_SCOPE);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(codeChallengeFor(codeVerifierFor(nonce)));
    expect(u.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/connections/google-business/callback",
    );
    // Not include_granted_scopes: sign-in's openid/email must not ride along.
    expect(u.searchParams.has("include_granted_scopes")).toBe(false);
  });

  it("refuses the wrong phrase, an unconfigured setup, or a live connection — nothing is sent", async () => {
    const s = await business();
    const base = { accountId: s.account_id, profileId: s.profile_id, config: CONFIG };
    await expect(startGoogleLogin({ ...base, confirmation: "yes" })).rejects.toMatchObject({
      reason: "phrase",
    });
    await expect(
      startGoogleLogin({ ...base, confirmation: GOOGLE_REVIEWS_PHRASE, config: null }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await connected(s);
    await expect(
      startGoogleLogin({ ...base, confirmation: GOOGLE_REVIEWS_PHRASE }),
    ).rejects.toMatchObject({ reason: "already_connected" });
  });
});

/* ── the callback and the consent ── */

describe("I-45a — the consent, recorded like Meta's", () => {
  it("one location: connects, encrypts the access, and writes one consent row of ids and a hash", async () => {
    const s = await business();
    const { nonce, state } = started(s);
    const fake = fakeGoogle();
    const out = await completeGoogleCallback({
      accountId: s.account_id,
      userId: null,
      query: { code: "4/fake-code", state, error: null },
      nonceCookie: nonce,
      config: CONFIG,
      fetchImpl: fake.fetch,
    });
    expect(out.kind).toBe("connected");
    const [row] = await storedFor(s.account_id);
    expect(row).toMatchObject({
      purpose: "execute",
      status: "connected",
      granted_scopes: [GBP_SCOPE],
    });
    // Encrypted at rest: neither token is readable in the row.
    expect(row?.encrypted_secret).not.toContain("fake-refresh");
    expect(JSON.stringify(row)).not.toContain("ya29");

    const logged = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, s.profile_id), eq(decisionLog.kind, "consent")));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      actor: "owner",
      ref_id: row?.id,
      payload_hash: hashGoogleConsent({
        account_id: s.account_id,
        connection_id: row?.id as string,
        granted_scopes: [GBP_SCOPE],
        consent_lines: googleConsentLines(),
        typed_confirmation: GOOGLE_REVIEWS_PHRASE,
        location: "accounts/111/locations/222",
      }),
    });
    const [settings] = await db
      .select()
      .from(reviewSettings)
      .where(eq(reviewSettings.profile_id, s.profile_id));
    expect(settings?.google_location_title).toBe("Lumen Hair Studio");
    // Google was sent a code exchange with the PKCE verifier, a refresh, and reads.
    expect(fake.requests.map((r) => r.method)).toEqual(["POST", "GET", "GET", "POST"]);
  });

  it("Google granting one scope more (sign-in's openid) is refused by name; nothing is stored", async () => {
    const s = await business();
    const { nonce, state } = started(s);
    const fake = fakeGoogle({ scope: `openid ${GBP_SCOPE}` });
    const out = await completeGoogleCallback({
      accountId: s.account_id,
      userId: null,
      query: { code: "4/fake-code", state, error: null },
      nonceCookie: nonce,
      config: CONFIG,
      fetchImpl: fake.fetch,
    });
    expect(out).toEqual({ kind: "failed", reason: "scope" });
    expect(await storedFor(s.account_id)).toEqual([]);
    // Refused before any read was made with it.
    expect(fake.requests.map((r) => r.method)).toEqual(["POST"]);
  });

  it("no refresh token, a missing nonce, a tampered or foreign state: nothing is connected", async () => {
    const s = await business();
    const other = await business();
    const call = (over: Partial<Parameters<typeof completeGoogleCallback>[0]>, fakeOpts = {}) => {
      const { nonce, state } = started(s);
      return completeGoogleCallback({
        accountId: s.account_id,
        userId: null,
        query: { code: "4/fake-code", state, error: null },
        nonceCookie: nonce,
        config: CONFIG,
        fetchImpl: fakeGoogle(fakeOpts).fetch,
        ...over,
      });
    };
    expect(await call({}, { refreshToken: false })).toEqual({
      kind: "failed",
      reason: "no_refresh",
    });
    expect(await call({ nonceCookie: null })).toEqual({ kind: "failed", reason: "start_again" });
    const { state } = started(s);
    expect(
      await call({ query: { code: "c", state: `${state.slice(0, -2)}xx`, error: null } }),
    ).toEqual({ kind: "failed", reason: "start_again" });
    expect(await call({ accountId: other.account_id })).toEqual({
      kind: "failed",
      reason: "foreign",
    });
    expect(await call({ query: { code: null, state: null, error: "access_denied" } })).toEqual({
      kind: "cancelled",
    });
    expect(await storedFor(s.account_id)).toEqual([]);
  });

  it("several locations: the owner picks, and only one of Google's own is accepted", async () => {
    const s = await business();
    const { nonce, state } = started(s);
    const fakeOpts = {
      locations: [
        { account: "accounts/111", id: "locations/222", title: "Lumen, Main St" },
        { account: "accounts/111", id: "locations/333", title: "Lumen, Quay" },
      ],
    };
    const out = await completeGoogleCallback({
      accountId: s.account_id,
      userId: null,
      query: { code: "4/fake-code", state, error: null },
      nonceCookie: nonce,
      config: CONFIG,
      fetchImpl: fakeGoogle(fakeOpts).fetch,
    });
    expect(out.kind).toBe("pick");
    const pending = out.kind === "pick" ? out.pending : "";
    expect(pending).not.toContain("fake-refresh");
    await expect(
      finishGoogleLogin({
        accountId: s.account_id,
        profileId: s.profile_id,
        userId: null,
        location: "accounts/111/locations/999",
        pendingCookie: pending,
        config: CONFIG,
        fetchImpl: fakeGoogle(fakeOpts).fetch,
      }),
    ).rejects.toThrow(/Pick one of the locations/);
    expect(await storedFor(s.account_id)).toEqual([]);
    const connection = await finishGoogleLogin({
      accountId: s.account_id,
      profileId: s.profile_id,
      userId: null,
      location: "accounts/111/locations/333",
      pendingCookie: pending,
      config: CONFIG,
      fetchImpl: fakeGoogle(fakeOpts).fetch,
    });
    expect(connection.provider).toBe("google_business_reviews");
    const [settings] = await db
      .select()
      .from(reviewSettings)
      .where(eq(reviewSettings.profile_id, s.profile_id));
    expect(settings?.google_location_title).toBe("Lumen, Quay");
  });

  it("the consent refuses the wrong phrase, another account's business, and a grant without the scope", async () => {
    const s = await business();
    const other = await business();
    const args = {
      accountId: s.account_id,
      profileId: s.profile_id,
      userId: null,
      confirmation: GOOGLE_REVIEWS_PHRASE,
      refreshToken: "1//fake-refresh",
      location: LOCATION,
      client: CLIENT,
      fetchImpl: fakeGoogle().fetch,
    };
    await expect(consentToGoogleReviews({ ...args, confirmation: "ok" })).rejects.toThrow(
      /type "allow replies and hours"/,
    );
    await expect(
      consentToGoogleReviews({ ...args, profileId: other.profile_id }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      consentToGoogleReviews({ ...args, fetchImpl: fakeGoogle({ scope: "openid" }).fetch }),
    ).rejects.toThrow(/missing "https:\/\/www.googleapis.com\/auth\/business.manage"/);
    expect(await storedFor(s.account_id)).toEqual([]);
  });
});

describe("I-45a — revoke", () => {
  it("deletes the access at once and stops the read; another account's id is not found", async () => {
    const s = await business();
    const other = await business();
    const connection = await connected(s);
    await expect(revokeGoogleReviews(other.account_id, connection.id)).rejects.toMatchObject({
      status: 404,
    });
    const revoked = await revokeGoogleReviews(s.account_id, connection.id);
    expect(revoked.status).toBe("disconnected");
    const [row] = await storedFor(s.account_id);
    expect(row?.encrypted_secret).toBeNull();
    await expect(revokeGoogleReviews(s.account_id, connection.id)).rejects.toBeInstanceOf(
      ExecutionConnectionError,
    );
  });
});

describe("I-45a lifted — the executor runs only its two ops", () => {
  it("refuses an op it doesn't have, before and at execution, and captures nothing for it", async () => {
    const ctx = { profile_id: "p", account_id: "a" };
    expect(await googleBusinessExecutor.preflight?.("edit_listing", {}, ctx)).toMatchObject({
      code: "refused",
    });
    await expect(googleBusinessExecutor.execute("edit_listing", {}, ctx)).rejects.toThrow(
      /not a change ScaleX makes on Google/,
    );
    expect(await googleBusinessExecutor.captureUndo("edit_listing", {}, ctx)).toBeNull();
  });
});

/* ── the read ── */

const fresh2star: FakeReview = {
  id: "r-new2",
  stars: "TWO",
  reviewer: "Aoife M.",
  comment: "Waited 40 minutes past my appointment and nobody said sorry. I won't be back.",
  createTime: iso(2 * 3_600_000),
};
const old5star: FakeReview = {
  id: "r-old5",
  stars: "FIVE",
  reviewer: null,
  comment: null,
  createTime: iso(30 * DAY),
};
const old1star: FakeReview = {
  id: "r-old1",
  stars: "ONE",
  reviewer: "Ben",
  comment: "Rude at the desk.",
  createTime: iso(40 * DAY),
};
const ancient: FakeReview = {
  id: "r-ancient",
  stars: "ONE",
  reviewer: "Cara",
  comment: "Years ago.",
  createTime: iso((GOOGLE_READ_LIMITS.max_age_days + 5) * DAY),
};

const REVIEWS_KEY = "accounts/111/locations/222";

async function reviewsOf(profileId: string) {
  return db.select().from(reviews).where(eq(reviews.profile_id, profileId));
}

async function alertsOf(profileId: string) {
  return db
    .select()
    .from(watchActivity)
    .where(and(eq(watchActivity.profile_id, profileId), eq(watchActivity.kind, "review_alert")));
}

describe("I-45a — the daily read", () => {
  it("files Google's reviews once, as source google; alerts only for the last week; skips the year-old", async () => {
    const s = await business();
    await connected(s);
    const fake = fakeGoogle({
      reviews: { [REVIEWS_KEY]: [fresh2star, old5star, old1star, ancient] },
    });
    const run = await runGoogleReviewReads({
      env: CLIENT,
      accountIds: [s.account_id],
      fetchImpl: fake.fetch,
      now: NOW,
    });
    expect(run).toMatchObject({ configured: true, ok: 1, failed: 0, filed: 3, alerted: 1 });
    const rows = await reviewsOf(s.profile_id);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({ platform: "google", source: "google", read_by: "api" });
      expect(r.provider_id).toMatch(/^gbp:[0-9a-f-]{36}:accounts\/111\/locations\/222\/reviews\//);
      expect(r.link).toBe("https://maps.google.com/maps?cid=1234");
    }
    const twoStar = rows.find((r) => r.stars === 2);
    expect(twoStar).toMatchObject({ reviewer: "Aoife M.", worth_knowing: true });
    expect(twoStar?.alerted_at).not.toBeNull();
    // The month-old 1-star is worth knowing, but quiet: old news.
    const oneStar = rows.find((r) => r.stars === 1);
    expect(oneStar).toMatchObject({ worth_knowing: true, alerted_at: null });
    expect(rows.find((r) => r.stars === 5)?.reviewer).toBeNull();
    expect(await alertsOf(s.profile_id)).toHaveLength(1);

    // Only GETs to Google's read endpoints, and the token refresh.
    expect(new Set(fake.requests.map((r) => r.method))).toEqual(new Set(["GET", "POST"]));
    for (const r of fake.requests.filter((x) => x.method === "POST")) {
      expect(r.url).toBe("https://oauth2.googleapis.com/token");
    }

    // A second read files nothing, and raises nothing.
    const again = await runGoogleReviewReads({
      env: CLIENT,
      accountIds: [s.account_id],
      fetchImpl: fakeGoogle({ reviews: { [REVIEWS_KEY]: [fresh2star, old5star, old1star] } }).fetch,
      now: NOW,
    });
    expect(again).toMatchObject({ filed: 0, alerted: 0 });
    expect(await reviewsOf(s.profile_id)).toHaveLength(3);
    const [settings] = await db
      .select()
      .from(reviewSettings)
      .where(eq(reviewSettings.profile_id, s.profile_id));
    expect(settings?.google_read_outcome).toBe("ok");
  });

  it("the same review by email first, then from Google, is listed once — and the other way round", async () => {
    // Email first: the notification may cut the words short.
    const a = await business();
    await connected(a);
    await fileReview({
      profile_id: a.profile_id,
      account_id: a.account_id,
      platform: "google",
      source: "email",
      read_by: "parser",
      stars: 2,
      reviewer: "Aoife M.",
      text: "Waited 40 minutes past my appointment and nobody said sorry…",
      link: "https://www.google.com/maps/reviews",
      reviewed_at: iso(3_600_000),
      received_at: iso(3_600_000),
      provider_id: `resend-${crypto.randomUUID()}`,
      fallback_id: null,
      sender_auth: "verified",
    });
    await runGoogleReviewReads({
      env: CLIENT,
      accountIds: [a.account_id],
      fetchImpl: fakeGoogle({ reviews: { [REVIEWS_KEY]: [fresh2star] } }).fetch,
      now: NOW,
    });
    const aRows = await reviewsOf(a.profile_id);
    expect(aRows).toHaveLength(1);
    expect(aRows[0]?.source).toBe("email");

    // Google first, then the email.
    const b = await business();
    await connected(b);
    await runGoogleReviewReads({
      env: CLIENT,
      accountIds: [b.account_id],
      fetchImpl: fakeGoogle({ reviews: { [REVIEWS_KEY]: [fresh2star] } }).fetch,
      now: NOW,
    });
    const late = await fileReview({
      profile_id: b.profile_id,
      account_id: b.account_id,
      platform: "google",
      source: "email",
      read_by: "parser",
      stars: 2,
      reviewer: "Aoife M.",
      text: fresh2star.comment,
      link: null,
      reviewed_at: NOW.toISOString(),
      received_at: NOW.toISOString(),
      provider_id: `resend-${crypto.randomUUID()}`,
      fallback_id: null,
      sender_auth: "verified",
    });
    expect(late.kind).toBe("duplicate");
    expect(await reviewsOf(b.profile_id)).toHaveLength(1);
    // One alert each: the duplicate raised nothing.
    expect(await alertsOf(b.profile_id)).toHaveLength(1);
  });

  it("a different review with the same stars is not folded in", async () => {
    const s = await business();
    await connected(s);
    await fileReview({
      profile_id: s.profile_id,
      account_id: s.account_id,
      platform: "google",
      source: "email",
      read_by: "parser",
      stars: 2,
      reviewer: "Dev",
      text: "The colour faded within a week and the stylist was rushed.",
      link: null,
      reviewed_at: iso(3_600_000),
      received_at: iso(3_600_000),
      provider_id: `resend-${crypto.randomUUID()}`,
      fallback_id: null,
      sender_auth: "verified",
    });
    await runGoogleReviewReads({
      env: CLIENT,
      accountIds: [s.account_id],
      fetchImpl: fakeGoogle({ reviews: { [REVIEWS_KEY]: [fresh2star] } }).fetch,
      now: NOW,
    });
    expect(await reviewsOf(s.profile_id)).toHaveLength(2);
  });

  it("a Google failure is recorded and survived: the next business is still read", async () => {
    const broken = await business();
    await connected(broken);
    const fine = await business();
    await connected(fine);
    // Google answers 403 for every reviews read: both fail, neither throws.
    const failing = await runGoogleReviewReads({
      env: CLIENT,
      accountIds: [broken.account_id, fine.account_id],
      fetchImpl: fakeGoogle({ reviewsStatus: 403 }).fetch,
      now: NOW,
    });
    expect(failing.failed).toBe(2);
    expect(failing.ok).toBe(0);
    const [bs] = await db
      .select()
      .from(reviewSettings)
      .where(eq(reviewSettings.profile_id, broken.profile_id));
    expect(bs?.google_read_outcome).toBe("permission");

    // Revoked at Google: the connection is marked failed with a fixed sentence, and skipped after.
    const revoked = await runGoogleReviewReads({
      env: CLIENT,
      accountIds: [broken.account_id, fine.account_id],
      fetchImpl: fakeGoogle({ revoked: true }).fetch,
      now: NOW,
    });
    expect(revoked.failed).toBe(2);
    const [row] = await storedFor(broken.account_id);
    expect(row).toMatchObject({ status: "failed", last_error: GOOGLE_AUTH_LOST });
    const afterwards = await runGoogleReviewReads({
      env: CLIENT,
      accountIds: [broken.account_id],
      fetchImpl: fakeGoogle({ reviews: { [REVIEWS_KEY]: [fresh2star] } }).fetch,
      now: NOW,
    });
    expect(afterwards.filed).toBe(0);
    expect(await reviewsOf(broken.profile_id)).toEqual([]);
  });

  it("without the Google setup, the read does nothing and sends nothing", async () => {
    const fake = fakeGoogle();
    expect(await runGoogleReviewReads({ env: null, fetchImpl: fake.fetch })).toEqual({
      configured: false,
      businesses: 0,
      ok: 0,
      failed: 0,
      filed: 0,
      alerted: 0,
    });
    expect(fake.requests).toEqual([]);
  });
});
