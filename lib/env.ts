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
 * The environment a reader reads. Every reader below defaults to
 * process.env; /ops hands its own (lib/ops/readiness.ts), so the panel and
 * the feature agree because they run the same check.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * P3-52: is a Vercel Blob token set? Uploads choose their path by it: the
 * browser uploads straight to Blob with a short-lived client token when it
 * is, and to the local disk store (development only) when it isn't.
 */
export function blobTokenSet(source: EnvSource = process.env): boolean {
  return (source.BLOB_READ_WRITE_TOKEN?.trim() ?? "") !== "";
}

/**
 * P3-53: which media-generation provider is switched on. Anything but a
 * known id reads as "off" — the safe reading is the default, as with
 * SESSION_D_REAL_WRITES. "fake" is the in-repo provider for tests and dev
 * and is refused in production (it would publish placeholder art).
 * "vendor" names the unimplemented adapter slot: the real provider is not
 * chosen yet (build-sequence step 2, quotes pending). "higgsfield" is
 * P6-03's real provider (Phase 6, the owner's choice on 2026-11-08): it
 * needs HIGGSFIELD_API_KEY, and says so when it is missing.
 */
export type MediaProviderSetting = "off" | "fake" | "vendor" | "higgsfield";

export function mediaProviderSetting(source: EnvSource = process.env): MediaProviderSetting {
  const raw = source.MEDIA_PROVIDER?.trim().toLowerCase() ?? "";
  if (raw === "fake") return source.NODE_ENV === "production" ? "off" : "fake";
  if (raw === "vendor") return "vendor";
  // P6-03: Higgsfield's API (its own prepaid USD balance, not the web plan).
  if (raw === "higgsfield") return "higgsfield";
  return "off";
}

/** P6-03: Higgsfield's API credentials and SYB's own limits on it, as the environment holds them. */
export interface HiggsfieldEnv {
  /** The key id and its secret — sent as `Authorization: Key <id>:<secret>`. Null when either is missing. */
  key: { id: string; secret: string } | null;
  /** Per business, per UTC calendar month, in US cents. */
  monthly_cap_minor: number;
  /** The model endpoint, e.g. "kling-video/v3.0/pro/text-to-video". */
  model: string;
  /** The published price per second of video, in millionths of a US dollar. */
  usd_micros_per_second: number;
}

/** P6-03 defaults: $60 a month; Kling 3.0 Pro, text to video; $0.112/s, the highest price Higgsfield has published for it. */
export const HIGGSFIELD_DEFAULTS = {
  monthly_cap_minor: 6000,
  model: "kling-video/v3.0/pro/text-to-video",
  usd_micros_per_second: 112_000,
} as const;

function positiveInt(raw: string | undefined, fallback: number): number {
  const s = raw?.trim() ?? "";
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/**
 * The key comes as HIGGSFIELD_API_KEY (the key id) plus
 * HIGGSFIELD_API_SECRET, or as one HIGGSFIELD_API_KEY of "id:secret" —
 * the console shows the key whole once, at creation.
 */
export function higgsfieldEnv(source: EnvSource = process.env): HiggsfieldEnv {
  const rawKey = source.HIGGSFIELD_API_KEY?.trim() ?? "";
  const rawSecret = source.HIGGSFIELD_API_SECRET?.trim() ?? "";
  let key: HiggsfieldEnv["key"] = null;
  if (rawKey !== "" && rawSecret !== "") key = { id: rawKey, secret: rawSecret };
  else if (rawKey.includes(":")) {
    const at = rawKey.indexOf(":");
    const id = rawKey.slice(0, at).trim();
    const secret = rawKey.slice(at + 1).trim();
    if (id !== "" && secret !== "") key = { id, secret };
  }
  const model = source.HIGGSFIELD_MODEL?.trim() ?? "";
  return {
    key,
    monthly_cap_minor: positiveInt(
      source.HIGGSFIELD_MONTHLY_CAP_MINOR,
      HIGGSFIELD_DEFAULTS.monthly_cap_minor,
    ),
    // Only an endpoint id's characters: it becomes part of a URL path on Higgsfield's host.
    model: /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)+$/.test(model)
      ? model
      : HIGGSFIELD_DEFAULTS.model,
    usd_micros_per_second: positiveInt(
      source.HIGGSFIELD_USD_MICROS_PER_SECOND,
      HIGGSFIELD_DEFAULTS.usd_micros_per_second,
    ),
  };
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
export function appUrl(source: EnvSource = process.env): string | null {
  return source.APP_URL?.trim() || null;
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

/** SYB's Google OAuth client for reading Business Profile reviews (I-45a). */
export interface GoogleBusinessEnv {
  client_id: string;
  client_secret: string;
  /** GOOGLE_BUSINESS_REDIRECT_URI when set; otherwise derived from APP_URL or the request's origin. */
  redirect_uri: string | null;
  app_url: string | null;
}

/**
 * I-45a: Google Business Profile reviews are offered only when the Google
 * OAuth client is set (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, the same
 * client Google sign-in uses) AND GOOGLE_BUSINESS_API_APPROVED is "true":
 * Google gates the Business Profile APIs behind its own access request (the
 * default quota is zero), so a client id alone would send owners into a
 * consent that ends in Google's refusal. Null otherwise — the connect
 * button then says it isn't set up yet, and the read beat skips.
 */
export function googleBusinessEnv(): GoogleBusinessEnv | null {
  const client_id = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const client_secret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const approved = process.env.GOOGLE_BUSINESS_API_APPROVED?.trim().toLowerCase() === "true";
  if (client_id === "" || client_secret === "" || !approved) return null;
  return {
    client_id,
    client_secret,
    redirect_uri: process.env.GOOGLE_BUSINESS_REDIRECT_URI?.trim() || null,
    app_url: appUrl(),
  };
}

/** SYB's own TikTok For Business developer app (TikTok Ads, 2026-11-08). */
export interface TikTokAdsEnv {
  app_id: string;
  secret: string;
  /** TIKTOK_ADS_REDIRECT_URI — the advertiser redirect URL registered on the app. */
  redirect_uri: string;
  app_url: string | null;
}

/** The three settings TikTok Ads needs, in the order the owner's steps name them. */
export const TIKTOK_ADS_KEYS = [
  "TIKTOK_ADS_APP_ID",
  "TIKTOK_ADS_SECRET",
  "TIKTOK_ADS_REDIRECT_URI",
] as const;

/** Which of the three are missing: what the /connections card names, exactly. */
export function tiktokAdsMissing(
  source: EnvSource = process.env,
): (typeof TIKTOK_ADS_KEYS)[number][] {
  return TIKTOK_ADS_KEYS.filter((k) => (source[k]?.trim() ?? "") === "");
}

/**
 * TikTok Ads is offered only when all three are set. TikTok matches the
 * redirect against the URLs registered on the app, so it is never derived
 * from the request: a guessed one would end at TikTok's refusal. Null
 * otherwise — the card names what is missing and every route refuses.
 */
export function tiktokAdsEnv(): TikTokAdsEnv | null {
  if (tiktokAdsMissing().length > 0) return null;
  return {
    app_id: (process.env.TIKTOK_ADS_APP_ID ?? "").trim(),
    secret: (process.env.TIKTOK_ADS_SECRET ?? "").trim(),
    redirect_uri: (process.env.TIKTOK_ADS_REDIRECT_URI ?? "").trim(),
    app_url: appUrl(),
  };
}

/** SYB's own TikTok app for posting (Login Kit + Content Posting API), as the environment holds it. */
export interface TikTokPostingEnv {
  client_key: string;
  client_secret: string;
  /** TIKTOK_REDIRECT_URI when set; otherwise derived from APP_URL or the request's origin. */
  redirect_uri: string | null;
  app_url: string | null;
}

/**
 * TikTok posting (2026-11-08) is offered only when BOTH TIKTOK_CLIENT_KEY and
 * TIKTOK_CLIENT_SECRET are set. Null otherwise: the card says it isn't set
 * up yet, and every route of the sign-in refuses rather than sending a
 * half-configured request to TikTok.
 */
export function tiktokPostingEnv(source: EnvSource = process.env): TikTokPostingEnv | null {
  const client_key = source.TIKTOK_CLIENT_KEY?.trim() ?? "";
  const client_secret = source.TIKTOK_CLIENT_SECRET?.trim() ?? "";
  if (client_key === "" || client_secret === "") return null;
  return {
    client_key,
    client_secret,
    redirect_uri: source.TIKTOK_REDIRECT_URI?.trim() || null,
    app_url: appUrl(source),
  };
}

export type TikTokAuditStatus = "unaudited" | "audited";

/**
 * Whether TikTok's audit of SYB's app has passed. Until it has, TikTok
 * restricts everything an app posts to private viewing (SELF_ONLY, "only
 * me") and refuses anything else at init. Anything but "audited" reads as
 * unaudited — the screen must never offer a privacy TikTok will refuse, so
 * the safe reading is the default, as with META_ACCESS_LEVEL.
 */
export function tiktokAuditStatus(source: EnvSource = process.env): TikTokAuditStatus {
  return source.TIKTOK_AUDIT_STATUS?.trim() === "audited" ? "audited" : "unaudited";
}

/**
 * P2-20 / P3-22: Google's API access levels for the Google Ads API, as
 * Google names them (access-levels page, read 2026-11-08). The level belongs
 * to the Google Cloud project that owns the OAuth client.
 *
 *   test      test accounts only — a real ad account is refused by Google
 *   explorer  production accounts too, 2,880 operations a day
 *   basic     15,000 operations a day, after Google's review
 *   standard  no daily cap, after Google's audit
 */
export const GOOGLE_ADS_ACCESS_LEVELS = ["test", "explorer", "basic", "standard"] as const;
export type GoogleAdsAccessLevel = (typeof GOOGLE_ADS_ACCESS_LEVELS)[number];

/** SYB's Google OAuth client and API setup for Google Ads (P2-20 / P3-22). */
export interface GoogleAdsEnv {
  client_id: string;
  client_secret: string;
  /** What Google has approved SYB's Cloud project for, stated by the operator. */
  access_level: GoogleAdsAccessLevel;
  /**
   * GOOGLE_ADS_DEVELOPER_TOKEN, sent as the developer-token header when set.
   * Google's developer-token page (read 2026-11-08) says tokens were retired
   * on 2026-09-09 and a token sent is ignored; kept optional for an older
   * project that still holds one.
   */
  developer_token: string | null;
  /** GOOGLE_ADS_LOGIN_CUSTOMER_ID: a manager account SYB reads through, ten digits; null = direct. */
  login_customer_id: string | null;
  /** GOOGLE_ADS_REDIRECT_URI when set; otherwise derived from APP_URL or the request's origin. */
  redirect_uri: string | null;
  app_url: string | null;
}

/** The environment keys Google Ads cannot run without, as the connection card names them. */
export type GoogleAdsMissingKey =
  "GOOGLE_ADS_CLIENT_ID" | "GOOGLE_ADS_CLIENT_SECRET" | "GOOGLE_ADS_ACCESS_LEVEL";

/**
 * Which OAuth client Google Ads uses: its own when either GOOGLE_ADS_CLIENT_*
 * key is set; otherwise the Google client sign-in and Business Profile
 * already use (one Cloud project, one consent screen to verify).
 */
export function googleAdsClientSource(source: EnvSource = process.env): "own" | "shared" {
  const own_id = source.GOOGLE_ADS_CLIENT_ID?.trim() ?? "";
  const own_secret = source.GOOGLE_ADS_CLIENT_SECRET?.trim() ?? "";
  return own_id !== "" || own_secret !== "" ? "own" : "shared";
}

function googleAdsClient(source: EnvSource): { client_id: string; client_secret: string } {
  if (googleAdsClientSource(source) === "own") {
    return {
      client_id: source.GOOGLE_ADS_CLIENT_ID?.trim() ?? "",
      client_secret: source.GOOGLE_ADS_CLIENT_SECRET?.trim() ?? "",
    };
  }
  return {
    client_id: source.GOOGLE_CLIENT_ID?.trim() ?? "",
    client_secret: source.GOOGLE_CLIENT_SECRET?.trim() ?? "",
  };
}

/** GOOGLE_ADS_ACCESS_LEVEL as one of Google's levels, or null when unset or unknown. */
export function googleAdsAccessLevel(source: EnvSource = process.env): GoogleAdsAccessLevel | null {
  const raw = source.GOOGLE_ADS_ACCESS_LEVEL?.trim().toLowerCase() ?? "";
  return (GOOGLE_ADS_ACCESS_LEVELS as readonly string[]).includes(raw)
    ? (raw as GoogleAdsAccessLevel)
    : null;
}

/** P2-20: what is still missing before Google Ads can be offered, by key name. Empty = ready. */
export function googleAdsMissing(source: EnvSource = process.env): GoogleAdsMissingKey[] {
  const client = googleAdsClient(source);
  const missing: GoogleAdsMissingKey[] = [];
  if (client.client_id === "") missing.push("GOOGLE_ADS_CLIENT_ID");
  if (client.client_secret === "") missing.push("GOOGLE_ADS_CLIENT_SECRET");
  if (googleAdsAccessLevel(source) === null) missing.push("GOOGLE_ADS_ACCESS_LEVEL");
  return missing;
}

/**
 * P2-20 / P3-22: Google Ads is offered only with an OAuth client (its own,
 * or the shared GOOGLE_CLIENT_ID/SECRET) AND a stated access level — the
 * access level is what the connection card tells the owner, so it is never
 * guessed. Null otherwise: the card names what is missing, and the daily
 * read and every Google Ads change refuse.
 */
export function googleAdsEnv(source: EnvSource = process.env): GoogleAdsEnv | null {
  const client = googleAdsClient(source);
  const access_level = googleAdsAccessLevel(source);
  if (client.client_id === "" || client.client_secret === "" || access_level === null) return null;
  const token = source.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() ?? "";
  const login = (source.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim() ?? "").replace(/-/g, "");
  return {
    ...client,
    access_level,
    developer_token: token === "" || /\s/.test(token) ? null : token,
    login_customer_id: /^\d{10}$/.test(login) ? login : null,
    redirect_uri: source.GOOGLE_ADS_REDIRECT_URI?.trim() || null,
    app_url: appUrl(source),
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
export function sessionDRealWritesOn(source: EnvSource = process.env): boolean {
  return source.SESSION_D_REAL_WRITES?.trim() === "on";
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

/** P6-02: the Twilio account the phone line answers through. */
export interface TwilioEnv {
  /** "AC" + 32 hex. Every webhook names it; one that names another account is refused. */
  accountSid: string;
  /** Signs every webhook (X-Twilio-Signature). Never logged, never sent anywhere. */
  authToken: string;
  /** The number callers dial, E.164 — the one the owner's line claims. */
  phoneNumber: string;
}

export const TWILIO_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
] as const;

/** P6-08: how long a call recording is kept unless the owner sets otherwise. */
export const PHONE_RECORDING_KEEP_DAYS_DEFAULT = 30;
/** The longest PHONE_RECORDING_KEEP_DAYS honoured: a year. Anything longer reads as the default. */
export const PHONE_RECORDING_KEEP_DAYS_MAX = 365;

/**
 * P6-08: PHONE_RECORDING_KEEP_DAYS — whole days, 1 to 365; anything else
 * (unset, junk, zero, longer than a year) is the default of 30. The caller
 * hears this number in the recording notice, and the owner reads it.
 */
export function phoneRecordingKeepDays(source: EnvSource = process.env): number {
  const raw = source.PHONE_RECORDING_KEEP_DAYS?.trim() ?? "";
  if (!/^[0-9]{1,3}$/.test(raw)) return PHONE_RECORDING_KEEP_DAYS_DEFAULT;
  const days = Number.parseInt(raw, 10);
  return days >= 1 && days <= PHONE_RECORDING_KEEP_DAYS_MAX
    ? days
    : PHONE_RECORDING_KEEP_DAYS_DEFAULT;
}

/** P6-02/P6-07: the shared Twilio account keys that are missing or malformed. */
export function twilioAccountMissing(
  source: EnvSource = process.env,
): ("TWILIO_ACCOUNT_SID" | "TWILIO_AUTH_TOKEN")[] {
  const sid = source.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const token = source.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const missing: ("TWILIO_ACCOUNT_SID" | "TWILIO_AUTH_TOKEN")[] = [];
  if (!/^AC[0-9a-f]{32}$/i.test(sid)) missing.push("TWILIO_ACCOUNT_SID");
  if (token === "" || /\s/.test(token)) missing.push("TWILIO_AUTH_TOKEN");
  return missing;
}

/** The Twilio settings that are missing or malformed, by name — empty when the line can run. */
export function twilioMissing(source: EnvSource = process.env): (typeof TWILIO_KEYS)[number][] {
  const number = source.TWILIO_PHONE_NUMBER?.trim() ?? "";
  const missing: (typeof TWILIO_KEYS)[number][] = [...twilioAccountMissing(source)];
  if (!/^\+[1-9][0-9]{6,14}$/.test(number)) missing.push("TWILIO_PHONE_NUMBER");
  return missing;
}

/**
 * P6-02: all three Twilio settings, or null. Null means the phone line is
 * not set up: the webhook refuses every request (it can't check a
 * signature without the token), and /support says which settings are needed.
 */
export function twilioEnv(): TwilioEnv | null {
  if (twilioMissing().length > 0) return null;
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID!.trim(),
    authToken: process.env.TWILIO_AUTH_TOKEN!.trim(),
    phoneNumber: process.env.TWILIO_PHONE_NUMBER!.trim(),
  };
}

/**
 * P6-07: the weekly summary on WhatsApp, through the same Twilio account as
 * the phone line (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN, read above).
 */
export interface WhatsAppEnv {
  accountSid: string;
  /** HTTP Basic password for the Messages API. Never logged, never sent anywhere else. */
  authToken: string;
  /** The WhatsApp-enabled sender, E.164 ("+447700900123"); sent as "whatsapp:+…". */
  from: string;
  /** Locale → the approved template's ContentSid ("HX" + 32 hex). Always has "en". */
  templates: Readonly<Record<string, string>>;
}

export const WHATSAPP_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_FROM",
  "TWILIO_WHATSAPP_SUMMARY_TEMPLATES",
] as const;

/** Pure: TWILIO_WHATSAPP_SUMMARY_TEMPLATES read — null unless a JSON object of HX sids with "en". */
export function parseWhatsAppTemplates(raw: string | undefined): Record<string, string> | null {
  if (!raw || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: Record<string, string> = {};
  for (const [locale, sid] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof sid !== "string" || !/^HX[0-9a-f]{32}$/i.test(sid.trim())) return null;
    out[locale] = sid.trim();
  }
  return typeof out.en === "string" ? out : null;
}

/** The WhatsApp settings that are missing or malformed, by name — empty when the summary can go. */
export function whatsappMissing(source: EnvSource = process.env): (typeof WHATSAPP_KEYS)[number][] {
  const missing: (typeof WHATSAPP_KEYS)[number][] = [...twilioAccountMissing(source)];
  const from = source.TWILIO_WHATSAPP_FROM?.trim() ?? "";
  if (!/^\+[1-9][0-9]{6,14}$/.test(from)) missing.push("TWILIO_WHATSAPP_FROM");
  if (!parseWhatsAppTemplates(source.TWILIO_WHATSAPP_SUMMARY_TEMPLATES)) {
    missing.push("TWILIO_WHATSAPP_SUMMARY_TEMPLATES");
  }
  return missing;
}

/** P6-07: all four WhatsApp settings, or null: not set up, and /watch names what's needed. */
export function whatsappEnv(): WhatsAppEnv | null {
  if (whatsappMissing().length > 0) return null;
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID!.trim(),
    authToken: process.env.TWILIO_AUTH_TOKEN!.trim(),
    from: process.env.TWILIO_WHATSAPP_FROM!.trim(),
    templates: parseWhatsAppTemplates(process.env.TWILIO_WHATSAPP_SUMMARY_TEMPLATES)!,
  };
}

/** RESEND_API_KEY, or null — every Resend call is honest about its absence. */
export function resendApiKey(): string | null {
  return process.env.RESEND_API_KEY?.trim() || null;
}

/** Idea 53: SYB's own VAPID key pair and contact, as the environment holds them. */
export interface VapidEnv {
  /** base64url, 65-byte uncompressed P-256 point: the browser's applicationServerKey. */
  publicKey: string;
  /** base64url, 32 bytes. Never logged, never sent anywhere. */
  privateKey: string;
  /** mailto: or https: — the contact a push service sees (RFC 8292 §2.1). */
  subject: string;
}

/**
 * Idea 53 (I-53.3): phone alerts are offered only when ALL THREE of
 * VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are set. Null
 * otherwise, and the "Phone alerts" card says the server can't send them
 * yet. `npm run vapid:generate` prints a pair; the owner pastes it into
 * Vercel. Whether the pair is valid is checked in lib/push/config.ts.
 */
export function vapidEnv(): VapidEnv | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = process.env.VAPID_SUBJECT?.trim() ?? "";
  if (publicKey === "" || privateKey === "" || subject === "") return null;
  return { publicKey, privateKey, subject };
}

/**
 * Idea 53: which push service phone alerts go through. "fake" records what
 * would be sent, in memory and in the log, and touches no network: for
 * tests, development and the demo. It is refused in production, where
 * anything but a real send would be a silent lie. Anything else is "real".
 */
export function pushServiceSetting(): "real" | "fake" {
  const raw = process.env.PUSH_SERVICE?.trim().toLowerCase() ?? "";
  return raw === "fake" && process.env.NODE_ENV !== "production" ? "fake" : "real";
}
