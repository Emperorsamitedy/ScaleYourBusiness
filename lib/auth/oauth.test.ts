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
import { accounts, authSessions, users } from "../../db/schema";
import { authorizeRedirect, emailFromClaims, idTokenClaims, oauthProvider } from "./oauth";
import { currentSession, signInWithEmail } from "./service";

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
    vi.stubEnv("APPLE_CLIENT_ID", "com.ledgerline.web");
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
