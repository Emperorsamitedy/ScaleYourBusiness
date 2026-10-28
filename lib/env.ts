// Fail-fast environment access. Import { env } from "@/lib/env" — never
// read process.env directly outside this file. Missing required variables
// throw at first access, not at the point of use three modules later.

type RequiredKey = "DATABASE_URL" | "ANTHROPIC_API_KEY" | "CONNECTOR_KEY" | "BLOB_READ_WRITE_TOKEN";

function read(key: RequiredKey): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new Error(
      `Missing required environment variable ${key} — copy .env.example to .env and fill it in`,
    );
  }
  return value;
}

// Lazy per-key access so code paths that never touch the Anthropic API
// (everything before Session L) don't demand the key at import time.
export const env: Record<RequiredKey, string> = {
  get DATABASE_URL() {
    return read("DATABASE_URL");
  },
  get ANTHROPIC_API_KEY() {
    return read("ANTHROPIC_API_KEY");
  },
  // Phase 2 (P2-03): the key that encrypts connection secrets at rest.
  // Demanded only when a connector is connected or synced.
  get CONNECTOR_KEY() {
    return read("CONNECTOR_KEY");
  },
  // Phase 3 Session D (P3-20c): the Vercel Blob store that holds rendered
  // media at a public URL for the platform to fetch. Demanded only when a
  // render is attached to a content item; tests use the in-memory store.
  get BLOB_READ_WRITE_TOKEN() {
    return read("BLOB_READ_WRITE_TOKEN");
  },
};

/**
 * P3-52: is a Vercel Blob token set? Uploads choose their path by it: the
 * browser uploads straight to Blob with a short-lived client token when it
 * is, and to the local disk store (development only) when it isn't.
 */
export function blobTokenSet(): boolean {
  return (process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "") !== "";
}

/**
 * P3-53: which media-generation provider is switched on. Anything but a
 * known id reads as "off" — the safe reading is the default, as with
 * SESSION_D_REAL_WRITES. "fake" is the in-repo provider for tests and dev
 * and is refused in production (it would publish placeholder art).
 * "vendor" names the unimplemented adapter slot: the real provider is not
 * chosen yet (build-sequence step 2, quotes pending).
 */
export type MediaProviderSetting = "off" | "fake" | "vendor";

export function mediaProviderSetting(): MediaProviderSetting {
  const raw = process.env.MEDIA_PROVIDER?.trim().toLowerCase() ?? "";
  if (raw === "fake") return process.env.NODE_ENV === "production" ? "off" : "fake";
  if (raw === "vendor") return "vendor";
  return "off";
}

export type MetaAccessLevel = "standard" | "advanced";

/**
 * P3-20i: what Meta has approved SYB for. Optional, and anything but
 * "advanced" reads as "standard" — the screen must never claim an access
 * level Meta hasn't granted, so the safe reading is the default.
 */
export function metaAccessLevel(): MetaAccessLevel {
  return process.env.META_ACCESS_LEVEL === "advanced" ? "advanced" : "standard";
}

/** APP_URL, the absolute origin for links and OAuth redirects. Null = derive from the request. */
export function appUrl(): string | null {
  return process.env.APP_URL?.trim() || null;
}

/** SYB's own Meta app for Facebook Login (P3-20j), as the environment holds it. */
export interface MetaLoginEnv {
  app_id: string;
  app_secret: string;
  /** META_OAUTH_REDIRECT_URI when set; otherwise derived from APP_URL or the request's origin. */
  redirect_uri: string | null;
  /** APP_URL when set: the origin the callback sends the owner back to. */
  app_url: string | null;
}

/**
 * P3-20j: Facebook Login is offered only when BOTH META_APP_ID and
 * META_APP_SECRET are set. Null otherwise — and every route of the flow
 * refuses rather than sending a half-configured request to Meta.
 */
export function metaLoginEnv(): MetaLoginEnv | null {
  const app_id = process.env.META_APP_ID?.trim() ?? "";
  const app_secret = process.env.META_APP_SECRET?.trim() ?? "";
  if (app_id === "" || app_secret === "") return null;
  return {
    app_id,
    app_secret,
    redirect_uri: process.env.META_OAUTH_REDIRECT_URI?.trim() || null,
    app_url: appUrl(),
  };
}

/**
 * P3-50: the user access token SYB reads Meta's Ad Library with — from a
 * developer account whose identity Meta has confirmed. Optional: null
 * means niche research is not set up, and the studio screen says exactly
 * that instead of failing. The token is only ever sent in an
 * Authorization header, never in a URL, and never stored.
 */
export function metaAdLibraryToken(): string | null {
  const token = process.env.META_AD_LIBRARY_TOKEN?.trim() ?? "";
  return token === "" || /\s/.test(token) ? null : token;
}

/**
 * P5-11: the Google API key the site audit asks PageSpeed Insights with.
 * Needed for page speed: Google's keyless quota is zero (every keyless call
 * answers 429), so null means speed isn't measured — the audit still walks
 * the path to buying, and /site says a free key is needed and
 * quota was used. Restrict the key to the PageSpeed Insights API only. It
 * is sent in the X-Goog-Api-Key header, never in a URL, and never stored.
 */
export function pagespeedApiKey(): string | null {
  const key = process.env.PAGESPEED_API_KEY?.trim() ?? "";
  return key === "" || /\s/.test(key) ? null : key;
}

/**
 * THE REAL-WRITE GATE (Session D, D2's done-when). The first real publish
 * waits for Phase 2's two-week unattended clock to complete
 * (TASKS-PHASE3.md, "The gate, amended"). Until SESSION_D_REAL_WRITES is
 * exactly "on", the engine refuses every op of a provider that writes to a
 * real platform — before anything is claimed or sent — and the proposal
 * stays approved. Anything but "on" reads as off: the safe reading is the
 * default, as with META_ACCESS_LEVEL.
 */
export function sessionDRealWritesOn(): boolean {
  return process.env.SESSION_D_REAL_WRITES?.trim() === "on";
}

/**
 * P4-09: the Resend webhook signing secret (whsec_…) for the inbound
 * support endpoint. Null = inbound email is not set up, and the endpoint
 * refuses every delivery rather than accept an unverified one.
 */
export function resendWebhookSecret(): string | null {
  return process.env.RESEND_WEBHOOK_SECRET?.trim() || null;
}

/**
 * P4-17: the signing secret (whsec_…) of a SECOND Resend webhook, pointed at
 * /api/email/events for email.delivered, email.bounced, email.complained and
 * email.suppressed. Its own secret, because Resend signs each webhook with
 * its own. Null = the endpoint refuses every delivery (503), and the
 * campaign readback says delivery isn't reported.
 */
export function resendEventsWebhookSecret(): string | null {
  return process.env.RESEND_EVENTS_WEBHOOK_SECRET?.trim() || null;
}

/**
 * P4-09: the domain Resend receives support mail on (its MX points at
 * Resend), e.g. "inbound.example.com" or "<id>.resend.app". Null = no
 * inbound address can be shown, and the owner's screen says so.
 */
export function supportInboundDomain(): string | null {
  const raw = process.env.SUPPORT_INBOUND_DOMAIN?.trim().toLowerCase() ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw) ? raw : null;
}

/**
 * Review 2026-10-23 (#5a): the From address campaigns send from — ideally a
 * sending subdomain of its own (e.g. "SYB <hello@campaigns.example.com>"),
 * so a complaint spike on campaigns can't throttle the address sign-in links
 * come from. Null = unset: campaigns share EMAIL_FROM with sign-in, and
 * /connections says so plainly.
 */
export function campaignEmailFrom(): string | null {
  return process.env.CAMPAIGN_EMAIL_FROM?.trim() || null;
}

/** RESEND_API_KEY, or null — every Resend call is honest about its absence. */
export function resendApiKey(): string | null {
  return process.env.RESEND_API_KEY?.trim() || null;
}
