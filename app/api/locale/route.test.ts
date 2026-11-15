// L-1 at the doors: the person's own language (/api/locale) and the
// business's language and currency (/api/locale/business), through the real
// access door against the real database — only next/headers' cookie jar is
// stood in. Plus where the choices land: the cookie, the users row, the
// profile, the account, the sign-in link and the new account it makes.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../../db";
import { accounts, businessProfiles, loginTokens, users } from "../../../db/schema";
import { AUTH_COOKIE, INTAKE_COOKIE, signProfileCookie } from "../../../lib/auth/access";
import type { Role } from "../../../lib/auth/roles";
import { hash, openSession, redeemLogin, requestLogin } from "../../../lib/auth/service";
import { CURRENCY_COOKIE, LANGUAGE_COOKIE } from "../../../lib/i18n/locales";
import { bootstrapIntake } from "../../../lib/intake/service";

// These hold the review gate itself. All six languages went live on
// 2026-11-08 (the owner's override), so the gate is tested the way the
// owner would use it: with LANGUAGES_IN_REVIEW sending them back.
const IN_REVIEW = "es-ES,de-DE,fr-FR,hu-HU,ru-RU,zh-Hans";
beforeAll(() => {
  process.env.LANGUAGES_IN_REVIEW = IN_REVIEW;
});
afterAll(() => {
  delete process.env.LANGUAGES_IN_REVIEW;
});

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) as string } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => jar.has(name),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers(),
}));

const { PUT: ownPUT } = await import("./route");
const { PUT: businessPUT } = await import("./business/route");
const { requestLocale, pickerContext } = await import("../../../lib/i18n/server");

const put = (url: string, body: unknown) =>
  new NextRequest(`http://localhost:3000${url}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const mail = (tag: string) => `l1-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;

async function member(accountId: string, role: Role, email = mail(role)) {
  const [u] = await db
    .insert(users)
    .values({ account_id: accountId, email, display_name: "l1", role })
    .returning();
  if (!u) throw new Error("fixture user");
  const s = await openSession(u);
  return { user_id: u.id, email, token: s.session_token };
}

async function ownedBusiness() {
  const boot = await bootstrapIntake();
  const owner = await member(boot.account_id, "owner");
  await db
    .update(accounts)
    .set({ owner_user_id: owner.user_id })
    .where(eq(accounts.id, boot.account_id));
  return { ...boot, owner };
}

function signIn(token: string | null, profileId: string | null) {
  jar.clear();
  if (token) jar.set(AUTH_COOKIE, token);
  if (profileId) jar.set(INTAKE_COOKIE, signProfileCookie(profileId));
}

const languageOf = async (userId: string) =>
  (await db.select({ l: users.language }).from(users).where(eq(users.id, userId)))[0]?.l;

const accountOf = async (accountId: string) =>
  (await db.select().from(accounts).where(eq(accounts.id, accountId)))[0];

const profileLanguage = async (profileId: string) =>
  (
    await db
      .select({ l: businessProfiles.language })
      .from(businessProfiles)
      .where(eq(businessProfiles.id, profileId))
  )[0]?.l;

afterEach(() => {
  delete process.env.LANGUAGE_REVIEW_ACCOUNTS;
  jar.clear();
});

describe("PUT /api/locale — the person's own language", () => {
  it("keeps a visitor's choice in the cookie only, and offers English to everyone", async () => {
    signIn(null, null);
    const res = await ownPUT(put("/api/locale", { language: "en" }));
    expect(res.status).toBe(200);
    expect(res.cookies.get(LANGUAGE_COOKIE)?.value).toBe("en");
    expect(res.cookies.get(LANGUAGE_COOKIE)?.httpOnly).toBe(true);
  });

  it("refuses a language still in review to someone not on the allowlist (the gate)", async () => {
    signIn(null, null);
    const anon = await ownPUT(put("/api/locale", { language: "de-DE" }));
    expect(anon.status).toBe(422);
    expect((await anon.json()).code).toBe("language");
    expect(anon.cookies.get(LANGUAGE_COOKIE)).toBeUndefined();

    const biz = await ownedBusiness();
    signIn(biz.owner.token, biz.profile_id);
    process.env.LANGUAGE_REVIEW_ACCOUNTS =
      "someone-else@example.com, 00000000-0000-0000-0000-000000000000";
    expect((await ownPUT(put("/api/locale", { language: "de-DE" }))).status).toBe(422);
    expect(await languageOf(biz.owner.user_id)).toBeNull();
  });

  it("refuses a language ScaleX doesn't speak", async () => {
    signIn(null, null);
    for (const language of ["xx", "de", "en-US", 7, null]) {
      expect((await ownPUT(put("/api/locale", { language }))).status, String(language)).toBe(422);
    }
  });

  it("opens a review language to a named reviewer, by email or by account, and stores it on their row", async () => {
    const biz = await ownedBusiness();
    signIn(biz.owner.token, biz.profile_id);
    process.env.LANGUAGE_REVIEW_ACCOUNTS = ` ${biz.owner.email.toUpperCase()} `;
    const res = await ownPUT(put("/api/locale", { language: "ru-RU" }));
    expect(res.status).toBe(200);
    expect(res.cookies.get(LANGUAGE_COOKIE)?.value).toBe("ru-RU");
    expect(await languageOf(biz.owner.user_id)).toBe("ru-RU");

    process.env.LANGUAGE_REVIEW_ACCOUNTS = biz.account_id;
    expect((await ownPUT(put("/api/locale", { language: "zh-Hans" }))).status).toBe(200);
    expect(await languageOf(biz.owner.user_id)).toBe("zh-Hans");
    // The business's own language is not the person's: it stays as it was.
    expect(await profileLanguage(biz.profile_id)).toBe("en");
  });

  it("is anyone's own choice — a viewer changes their language", async () => {
    const biz = await ownedBusiness();
    const viewer = await member(biz.account_id, "viewer");
    signIn(viewer.token, biz.profile_id);
    process.env.LANGUAGE_REVIEW_ACCOUNTS = biz.account_id;
    expect((await ownPUT(put("/api/locale", { language: "hu-HU" }))).status).toBe(200);
    expect(await languageOf(viewer.user_id)).toBe("hu-HU");
    expect(await languageOf(biz.owner.user_id)).toBeNull();
  });
});

describe("PUT /api/locale/business — the business's language and currency", () => {
  it("lets the owner choose any ISO 4217 currency, and records that it was chosen", async () => {
    const biz = await ownedBusiness();
    signIn(biz.owner.token, biz.profile_id);
    const res = await businessPUT(put("/api/locale/business", { currency: "jpy" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ currency: "JPY", currency_chosen: true });
    const a = await accountOf(biz.account_id);
    expect(a?.reporting_currency).toBe("JPY");
    expect(a?.reporting_currency_chosen_at).not.toBeNull();
  });

  it("refuses what isn't an ISO 4217 code", async () => {
    const biz = await ownedBusiness();
    signIn(biz.owner.token, biz.profile_id);
    for (const currency of ["VAT", "EURO", "XAU", "", 12]) {
      const res = await businessPUT(put("/api/locale/business", { currency }));
      expect(res.status, String(currency)).toBe(422);
      expect((await res.json()).code).toBe("currency");
    }
    expect((await accountOf(biz.account_id))?.reporting_currency).toBe("HUF");
    expect((await businessPUT(put("/api/locale/business", {}))).status).toBe(400);
  });

  it("is an owner's: a manager and a viewer are refused, and nothing changes", async () => {
    const biz = await ownedBusiness();
    for (const role of ["manager", "viewer"] as const) {
      const m = await member(biz.account_id, role);
      signIn(m.token, biz.profile_id);
      const res = await businessPUT(put("/api/locale/business", { currency: "EUR" }));
      expect(res.status, role).toBe(403);
      expect((await res.json()).error).toBe(
        "Only an owner can change the business's language or currency.",
      );
    }
    expect((await accountOf(biz.account_id))?.reporting_currency).toBe("HUF");
  });

  it("never lets one business's session change another's", async () => {
    const a = await ownedBusiness();
    const b = await ownedBusiness();
    signIn(a.owner.token, b.profile_id); // A's session, B's signed cookie
    const res = await businessPUT(put("/api/locale/business", { currency: "USD" }));
    // No access to B: treated as a visitor with no business — the cookie only.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kept: "browser" });
    expect((await accountOf(b.account_id))?.reporting_currency).toBe("HUF");
    expect((await accountOf(a.account_id))?.reporting_currency).toBe("HUF");
  });

  it("sets the business's language for its customers, behind the same gate", async () => {
    const biz = await ownedBusiness();
    signIn(biz.owner.token, biz.profile_id);
    expect((await businessPUT(put("/api/locale/business", { language: "fr-FR" }))).status).toBe(
      422,
    );
    process.env.LANGUAGE_REVIEW_ACCOUNTS = biz.owner.email;
    expect((await businessPUT(put("/api/locale/business", { language: "fr-FR" }))).status).toBe(
      200,
    );
    expect(await profileLanguage(biz.profile_id)).toBe("fr-FR");
  });

  it("acts as the owner for an intake nobody owns yet, on that intake only", async () => {
    const boot = await bootstrapIntake();
    signIn(null, boot.profile_id);
    const res = await businessPUT(put("/api/locale/business", { language: "en", currency: "GBP" }));
    expect(res.status).toBe(200);
    expect((await accountOf(boot.account_id))?.reporting_currency).toBe("GBP");
  });

  it("keeps the currency in a cookie before there is any business (the sign-up screen)", async () => {
    signIn(null, null);
    const res = await businessPUT(put("/api/locale/business", { currency: "CHF" }));
    expect(res.status).toBe(200);
    expect(res.cookies.get(CURRENCY_COOKIE)?.value).toBe("CHF");
  });
});

describe("where the first step's choices land", () => {
  it("starts a new intake in the chosen language and currency", async () => {
    const boot = await bootstrapIntake({ language: "de-DE", currency: "EUR" });
    expect(await profileLanguage(boot.profile_id)).toBe("de-DE");
    const a = await accountOf(boot.account_id);
    expect(a?.reporting_currency).toBe("EUR");
    expect(a?.reporting_currency_chosen_at).not.toBeNull();
    // No choice: English, and the default currency the country may replace.
    const plain = await bootstrapIntake();
    expect(await profileLanguage(plain.profile_id)).toBe("en");
    expect((await accountOf(plain.account_id))?.reporting_currency_chosen_at).toBeNull();
    // A bad value is no choice, never stored.
    const bad = await bootstrapIntake({ currency: "VAT" });
    expect((await accountOf(bad.account_id))?.reporting_currency).toBe("HUF");
  });

  it("carries the language and currency on the sign-in link, into the account it creates", async () => {
    const email = mail("link");
    const login = await requestLogin(email, null, null, { language: "es-ES", currency: "MXN" });
    const [row] = await db
      .select()
      .from(loginTokens)
      .where(eq(loginTokens.token_hash, hash(login.token)));
    expect(row).toMatchObject({ language: "es-ES", currency: "MXN" });
    const session = await redeemLogin(login.token);
    expect(session.language).toBe("es-ES");
    expect(await languageOf(session.user_id)).toBe("es-ES");
    const a = await accountOf(session.account_id);
    expect(a?.reporting_currency).toBe("MXN");
    expect(a?.reporting_currency_chosen_at).not.toBeNull();
  });

  it("keeps a person's own earlier choice at their next sign-in", async () => {
    const email = mail("again");
    const first = await redeemLogin(
      (await requestLogin(email, null, null, { language: "hu-HU" })).token,
    );
    expect(first.language).toBe("hu-HU");
    const second = await redeemLogin(
      (await requestLogin(email, null, null, { language: "fr-FR", currency: "EUR" })).token,
    );
    expect(second.language).toBe("hu-HU");
    // An existing account's currency is never changed by a sign-in.
    expect((await accountOf(second.account_id))?.reporting_currency).toBe("HUF");
  });

  it("ignores choices that aren't real languages or currencies", async () => {
    const login = await requestLogin(mail("junk"), null, null, {
      language: "klingon",
      currency: "VAT",
    });
    const [row] = await db
      .select()
      .from(loginTokens)
      .where(eq(loginTokens.token_hash, hash(login.token)));
    expect(row).toMatchObject({ language: null, currency: null });
  });
});

describe("the language a request renders in", () => {
  it("is English with no cookie, and the cookie's live language", async () => {
    signIn(null, null);
    expect(await requestLocale()).toBe("en");
    jar.set(LANGUAGE_COOKIE, "en");
    expect(await requestLocale()).toBe("en");
    jar.set(LANGUAGE_COOKIE, "nonsense");
    expect(await requestLocale()).toBe("en");
  });

  it("shows a review language only to a signed-in reviewer — a hand-set cookie opens nothing", async () => {
    signIn(null, null);
    jar.set(LANGUAGE_COOKIE, "de-DE");
    expect(await requestLocale()).toBe("en");
    const biz = await ownedBusiness();
    signIn(biz.owner.token, biz.profile_id);
    jar.set(LANGUAGE_COOKIE, "de-DE");
    expect(await requestLocale()).toBe("en");
    process.env.LANGUAGE_REVIEW_ACCOUNTS = biz.account_id;
    expect(await requestLocale()).toBe("de-DE");
  });

  it("offers the picker only what the gate opens, and says who may set the business's choices", async () => {
    signIn(null, null);
    const visitor = await pickerContext();
    expect(visitor.data.languages.map((l) => l.code)).toEqual(["en"]);
    expect(visitor.data.canSetBusiness).toBe(true); // before there's a business, the visitor will own it
    expect(visitor.chosen).toBe(false);
    expect(visitor.data.currencies.some((c) => c.code === "EUR" && c.name.length > 0)).toBe(true);

    const biz = await ownedBusiness();
    const viewer = await member(biz.account_id, "viewer");
    signIn(viewer.token, biz.profile_id);
    process.env.LANGUAGE_REVIEW_ACCOUNTS = biz.account_id;
    const ctx = await pickerContext();
    expect(ctx.data.languages.map((l) => l.code)).toEqual([
      "en",
      "es-ES",
      "de-DE",
      "fr-FR",
      "hu-HU",
      "ru-RU",
      "zh-Hans",
    ]);
    expect(ctx.data.languages.filter((l) => l.checking).length).toBe(6);
    expect(ctx.data.canSetBusiness).toBe(false);
    expect(ctx.business).toMatchObject({ language: "en", currency: "HUF", currency_chosen: false });
    // A default currency isn't a choice: the first step asks for one.
    expect(ctx.data.currency).toBeNull();
  });
});
