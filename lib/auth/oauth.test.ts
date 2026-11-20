// The SSO doors — each test states what it protects.
//
// The gate: an unconfigured provider is null, so the start route can
// only ever send an honest "not connected" back — no half-armed flow.
// The claims: an id_token without a usable, verified email is refused
// rather than minting an account on thin air. And signInWithEmail is
// one motion shared with the emailed link: same email → same account,
// however it was proven.

import "dotenv/config";
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { accounts, authSessions, businessProfiles, users } from "../../db/schema";
import {
  MICROSOFT_CONSUMER_TENANT,
  authorizeRedirect,
  configuredProviders,
  emailFromClaims,
  idTokenClaims,
  oauthProvider,
  verifiedEmailFromClaims,
} from "./oauth";
import { currentSession } from "./service";
import { signInWithEmail } from "./sign-in";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("oauthProvider — armed only by keys", () => {
  it("returns null for every provider when no keys exist", () => {
    for (const name of ["GOOGLE", "MICROSOFT", "APPLE"]) {
      vi.stubEnv(`${name}_CLIENT_ID`, "");
      vi.stubEnv(`${name}_CLIENT_SECRET`, "");
    }
    expect(oauthProvider("google")).toBeNull();
    expect(oauthProvider("microsoft")).toBeNull();
    expect(oauthProvider("apple")).toBeNull();
  });

  it("configuredProviders lists only the providers with keys, so no button can only fail", () => {
    for (const name of ["GOOGLE", "MICROSOFT", "APPLE"]) {
      vi.stubEnv(`${name}_CLIENT_ID`, "");
      vi.stubEnv(`${name}_CLIENT_SECRET`, "");
    }
    vi.stubEnv("APPLE_TEAM_ID", "");
    expect(configuredProviders()).toEqual([]);
    vi.stubEnv("MICROSOFT_CLIENT_ID", "cid");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "sec");
    expect(configuredProviders()).toEqual(["microsoft"]);
  });

  it("returns null for a provider that was never on the list", () => {
    expect(oauthProvider("facebook")).toBeNull();
  });

  it("arms google when both keys exist, with only identity scopes", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "cid-123");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "sec-456");
    const provider = oauthProvider("google");
    expect(provider).not.toBeNull();
    expect(provider!.scope).toBe("openid email");
    const url = new URL(
      authorizeRedirect(provider!, "https://app.example/api/auth/oauth/google/callback", "st8"),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("cid-123");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("apple needs all four keys and mints an ES256 client secret", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    vi.stubEnv("APPLE_CLIENT_ID", "com.syb.web");
    vi.stubEnv("APPLE_TEAM_ID", "TEAM123");
    vi.stubEnv("APPLE_KEY_ID", "KEY456");
    vi.stubEnv("APPLE_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const provider = oauthProvider("apple");
    expect(provider).not.toBeNull();
    expect(provider!.responseMode).toBe("form_post");
    const secret = provider!.clientSecret();
    const [header, payload, signature] = secret.split(".");
    expect(signature).toBeTruthy();
    expect(JSON.parse(Buffer.from(header!, "base64url").toString()).alg).toBe("ES256");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString()).iss).toBe("TEAM123");
  });
});

describe("id_token claims — no account on thin air", () => {
  const token = (claims: object) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

  it("reads the email out of a well-formed token", () => {
    const claims = idTokenClaims(token({ email: "owner@example.com", email_verified: true }));
    expect(emailFromClaims(claims, "Google")).toBe("owner@example.com");
  });

  it("refuses a token with no email", () => {
    expect(() => emailFromClaims(idTokenClaims(token({ sub: "123" })), "Google")).toThrow(
      /didn't share an email/,
    );
  });

  it("refuses an unverified email", () => {
    const claims = idTokenClaims(token({ email: "o@e.com", email_verified: false }));
    expect(() => emailFromClaims(claims, "Google")).toThrow(/unverified/);
  });
});

describe("signInWithEmail — one motion, however the email was proven", () => {
  const email = `oauth-test-${crypto.randomUUID().slice(0, 8)}@example.com`;

  afterAll(async () => {
    const rows = await db.select().from(users).where(eq(users.email, email));
    for (const u of rows) {
      await db.delete(authSessions).where(eq(authSessions.user_id, u.id));
      await db
        .update(accounts)
        .set({ owner_user_id: null })
        .where(eq(accounts.owner_user_id, u.id));
      await db.delete(users).where(eq(users.id, u.id));
      // L8: the sign-in gave this account an empty business; it goes first.
      await db.delete(businessProfiles).where(eq(businessProfiles.account_id, u.account_id));
      await db.delete(accounts).where(eq(accounts.id, u.account_id));
    }
  });

  it("creates the account on first sign-in and reuses it on the second", async () => {
    const first = await signInWithEmail(email, null);
    expect(first.email).toBe(email);
    const resolved = await currentSession(first.session_token);
    expect(resolved?.account_id).toBe(first.account_id);

    const second = await signInWithEmail(email.toUpperCase(), null);
    expect(second.account_id).toBe(first.account_id);
    expect(second.session_token).not.toBe(first.session_token);
  });
});

describe("security review 2026-10-17 — an id_token's claims are checked before its email is trusted", () => {
  const google = { id: "google" as const, label: "Google", clientId: "g-client" };
  const microsoft = { id: "microsoft" as const, label: "Microsoft", clientId: "ms-client" };
  const ATTACKER_TENANT = "11111111-2222-3333-4444-555555555555";

  it("Google: our audience, Google's issuer, a verified email", () => {
    const ok = {
      aud: "g-client",
      iss: "https://accounts.google.com",
      email: "o@example.com",
      email_verified: true,
    };
    expect(verifiedEmailFromClaims(google, ok)).toBe("o@example.com");
    expect(() => verifiedEmailFromClaims(google, { ...ok, aud: "someone-elses-app" })).toThrow(
      /another app/,
    );
    expect(() => verifiedEmailFromClaims(google, { ...ok, iss: "https://evil.example" })).toThrow(
      /wrong issuer/,
    );
    // Missing is not verified: positively true, or no sign-in.
    const unstated = { aud: ok.aud, iss: ok.iss, email: ok.email };
    expect(() => verifiedEmailFromClaims(google, unstated)).toThrow(/not verified/);
  });

  it("THE ATTACK (nOAuth): an attacker's own Microsoft tenant claiming an owner's email is refused", () => {
    const forged = {
      aud: "ms-client",
      tid: ATTACKER_TENANT,
      iss: `https://login.microsoftonline.com/${ATTACKER_TENANT}/v2.0`,
      email: "owner@victim-shop.hu",
    };
    expect(() => verifiedEmailFromClaims(microsoft, forged)).toThrow(/isn't verified as its own/);
  });

  it("Microsoft: a personal account, or a work account carrying xms_edov, signs in", () => {
    const personal = {
      aud: "ms-client",
      tid: MICROSOFT_CONSUMER_TENANT,
      iss: `https://login.microsoftonline.com/${MICROSOFT_CONSUMER_TENANT}/v2.0`,
      email: "someone@outlook.com",
    };
    expect(verifiedEmailFromClaims(microsoft, personal)).toBe("someone@outlook.com");
    const work = {
      aud: "ms-client",
      tid: ATTACKER_TENANT,
      iss: `https://login.microsoftonline.com/${ATTACKER_TENANT}/v2.0`,
      email: "owner@their-own-domain.hu",
      xms_edov: true,
    };
    expect(verifiedEmailFromClaims(microsoft, work)).toBe("owner@their-own-domain.hu");
    // An issuer that doesn't match the tenant is refused.
    expect(() =>
      verifiedEmailFromClaims(microsoft, {
        ...work,
        iss: `https://login.microsoftonline.com/${MICROSOFT_CONSUMER_TENANT}/v2.0`,
      }),
    ).toThrow(/wrong issuer/);
  });
});
