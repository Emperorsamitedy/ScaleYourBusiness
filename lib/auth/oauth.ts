// OAuth sign-in — the SSO doors on /signup and /login.
//
// Standard authorization-code flow, no library: three providers, each
// armed only when its keys exist in the environment (the payment-gate
// precedent — the buttons are honest about an unconfigured provider).
// The flow proves the visitor owns an email address, exactly like the
// emailed link does, and then hands that proven email to the same
// `signInWithEmail` the link redemption uses. OAuth grants us NOTHING
// beyond identity: the only scopes ever requested are openid + email.
//
// The id_token is read, not signature-verified: it arrives directly
// from the provider's token endpoint over TLS in exchange for the
// code, so its origin is the transport's guarantee — the standard
// confidential-client shortcut.
//
// Apple's quirk: the client secret is not a string but an ES256-signed
// JWT minted from a private key, and its callback arrives as a
// cross-site form POST rather than a GET.

import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { AuthError } from "./service";

export type OAuthProviderId = "google" | "apple" | "microsoft";

/** Double-submit state cookie shared by the start and callback routes. */
export const STATE_COOKIE = "syb_oauth_state";

export interface OAuthProvider {
  id: OAuthProviderId;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientId: string;
  /** Resolved lazily — Apple's is minted per request. */
  clientSecret: () => string;
  /** Apple posts the callback; the others GET it. */
  responseMode: "query" | "form_post";
}

function appleClientSecret(): string {
  const teamId = process.env.APPLE_TEAM_ID ?? "";
  const keyId = process.env.APPLE_KEY_ID ?? "";
  const clientId = process.env.APPLE_CLIENT_ID ?? "";
  const pem = (process.env.APPLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "ES256", kid: keyId })}.${b64({
    iss: teamId,
    iat: now,
    exp: now + 300,
    aud: "https://appleid.apple.com",
    sub: clientId,
  })}`;
  const signature = cryptoSign("sha256", Buffer.from(unsigned), {
    key: createPrivateKey(pem),
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${signature.toString("base64url")}`;
}

/** The provider, or null while its keys don't exist. */
export function oauthProvider(id: string): OAuthProvider | null {
  if (id === "google" && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return {
      id,
      label: "Google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scope: "openid email",
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: () => process.env.GOOGLE_CLIENT_SECRET ?? "",
      responseMode: "query",
    };
  }
  if (
    id === "microsoft" &&
    process.env.MICROSOFT_CLIENT_ID &&
    process.env.MICROSOFT_CLIENT_SECRET
  ) {
    return {
      id,
      label: "Microsoft",
      authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scope: "openid email",
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET ?? "",
      responseMode: "query",
    };
  }
  if (
    id === "apple" &&
    process.env.APPLE_CLIENT_ID &&
    process.env.APPLE_TEAM_ID &&
    process.env.APPLE_KEY_ID &&
    process.env.APPLE_PRIVATE_KEY
  ) {
    return {
      id,
      label: "Apple",
      authorizeUrl: "https://appleid.apple.com/auth/authorize",
      tokenUrl: "https://appleid.apple.com/auth/token",
      scope: "openid email",
      clientId: process.env.APPLE_CLIENT_ID,
      clientSecret: appleClientSecret,
      responseMode: "form_post",
    };
  }
  return null;
}

export const KNOWN_PROVIDERS: readonly string[] = ["google", "apple", "microsoft"];

export function authorizeRedirect(
  provider: OAuthProvider,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", provider.scope);
  url.searchParams.set("state", state);
  if (provider.responseMode === "form_post") url.searchParams.set("response_mode", "form_post");
  return url.toString();
}

/** The middle of a JWT, decoded and nothing more. */
export function idTokenClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split(".")[1];
  if (!payload) throw new AuthError("the provider returned a malformed token", 502);
  return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
}

/** The proven email out of an id_token, or a refusal. */
export function emailFromClaims(claims: Record<string, unknown>, label: string): string {
  const email = typeof claims.email === "string" ? claims.email : null;
  if (!email || !email.includes("@")) {
    throw new AuthError(`${label} didn't share an email address — use the email link instead`, 502);
  }
  if (claims.email_verified === false || claims.email_verified === "false") {
    throw new AuthError(
      `${label} reports that address as unverified — use the email link instead`,
      403,
    );
  }
  return email;
}

/** Microsoft's tenant for personal accounts, whose email addresses Microsoft itself verifies. */
export const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

const truthy = (v: unknown) => v === true || v === "true";

/**
 * The id_token's claims checked BEFORE its email is trusted — the security
 * review of 2026-10-17. It arrives straight from the token endpoint over
 * TLS (the confidential code flow), so the claims, not a signature, are
 * what matter:
 *
 *   · aud must be our client id, and iss the provider's own issuer.
 *   · Google and Apple must say the email is verified, positively.
 *   · Microsoft: the multi-tenant `email` claim is set by whoever runs the
 *     tenant, so an attacker's own tenant could claim an owner's address
 *     and land on their account ("nOAuth"). It is trusted only for
 *     personal Microsoft accounts (Microsoft verifies those) or when the
 *     token carries `xms_edov` — the email domain owner verified claim,
 *     an optional claim to switch on in the app registration.
 */
export function verifiedEmailFromClaims(
  provider: Pick<OAuthProvider, "id" | "label" | "clientId">,
  claims: Record<string, unknown>,
): string {
  const refuse = (why: string) => {
    throw new AuthError(
      `${provider.label} sign-in couldn't be verified (${why}) — use the email link instead`,
      403,
    );
  };
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(provider.clientId) : aud === provider.clientId;
  if (!audOk) refuse("issued for another app");
  const iss = typeof claims.iss === "string" ? claims.iss : "";
  if (provider.id === "google") {
    if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com")
      refuse("wrong issuer");
    if (!truthy(claims.email_verified)) refuse("email not verified");
  } else if (provider.id === "apple") {
    if (iss !== "https://appleid.apple.com") refuse("wrong issuer");
    if (!truthy(claims.email_verified)) refuse("email not verified");
  } else if (provider.id === "microsoft") {
    const tid = typeof claims.tid === "string" ? claims.tid : "";
    if (!/^[0-9a-f-]{36}$/i.test(tid) || iss !== `https://login.microsoftonline.com/${tid}/v2.0`) {
      refuse("wrong issuer");
    }
    if (tid.toLowerCase() !== MICROSOFT_CONSUMER_TENANT && !truthy(claims.xms_edov)) {
      refuse("the organisation's email isn't verified as its own");
    }
  } else {
    refuse("unknown provider");
  }
  return emailFromClaims(claims, provider.label);
}

/** Exchange the code for the provider's proven email. */
export async function exchangeCodeForEmail(
  provider: OAuthProvider,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: provider.clientId,
      client_secret: provider.clientSecret(),
    }),
  });
  if (!res.ok) {
    console.error(
      JSON.stringify({
        event: "oauth_exchange_failed",
        provider: provider.id,
        status: res.status,
      }),
    );
    throw new AuthError(`${provider.label} sign-in failed — try again or use the email link`, 502);
  }
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) {
    throw new AuthError(`${provider.label} sign-in failed — try again or use the email link`, 502);
  }
  return verifiedEmailFromClaims(provider, idTokenClaims(tokens.id_token));
}
