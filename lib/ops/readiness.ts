// Launch readiness — the deploy checklist on /ops, computed live.
//
// docs/SECURITY-AUDIT.md's "Before you deploy main" is a list a person
// works through by hand; this turns it into checks the panel can answer
// from the environment and a few database facts. Pure: it takes an env
// object and the facts lib/ops/readiness-facts.ts reads, and returns
// worded items. No external call, ever — a key is "present", never
// "working", and the items that can only be checked at the provider say
// CHECK rather than pretending.
//
// THE RULE: a secret's value never leaves this function, not even a
// prefix of it. An item may carry only presence, plus facts that are not
// secret: whether a Stripe key is a test or a live one (the word, never
// the prefix), APP_URL's origin, the domain of a From address, a phone
// number once it reads as E.164, a count of days or cents once it reads as
// a whole number, the languages SYB speaks, and a handful of enumerated
// settings (INTERVIEWER_MODE, META_ACCESS_LEVEL, MEDIA_PROVIDER,
// GOOGLE_ADS_ACCESS_LEVEL, TIKTOK_AUDIT_STATUS) shown only when they hold a
// value the code knows. Anything else that
// looks wrong is described, never echoed — a secret pasted into the wrong
// variable must not surface here either. readiness.test.ts fills every
// variable with a sentinel and searches the whole output for it.

import { parseKey } from "../connectors/secrets";
import { format, isIsoCurrency, money } from "../core/money";
import {
  HIGGSFIELD_DEFAULTS,
  PHONE_RECORDING_KEEP_DAYS_DEFAULT,
  TWILIO_KEYS,
  blobTokenSet,
  googleAdsAccessLevel,
  googleAdsClientSource,
  googleAdsEnv,
  googleAdsMissing,
  higgsfieldEnv,
  mediaProviderSetting,
  parseWhatsAppTemplates,
  phoneRecordingKeepDays,
  sessionDRealWritesOn,
  tiktokAdsMissing,
  tiktokAuditStatus,
  tiktokPostingEnv,
  twilioAccountMissing,
  twilioMissing,
  whatsappMissing,
} from "../env";
import { LANGUAGE_NAMES, LOCALES, isAppLocale, languagesInReview } from "../i18n/locales";
import { sendingMode } from "../purchasing/po";

export type ReadinessStatus = "ready" | "missing" | "check" | "off";

/** The word each status is shown as. */
export const STATUS_WORD: Readonly<Record<ReadinessStatus, string>> = {
  ready: "READY",
  missing: "MISSING",
  check: "CHECK",
  off: "OFF",
};

export interface ReadinessLink {
  label: string;
  href: string;
}

export interface ReadinessItem {
  /** The variable or fact, e.g. "RESEND_API_KEY" or "migrations". */
  name: string;
  status: ReadinessStatus;
  /** One plain sentence: what it is, and what to do. */
  says: string;
  /** Where the value comes from: a provider's dashboard page. */
  where: ReadinessLink | null;
  /** Where no dashboard page exists: where the value comes from, in words. */
  where_text?: string;
  /** How to make it, when it is made rather than fetched (a command). */
  how?: string;
  /** Non-secret values to paste somewhere, e.g. the webhook URLs. */
  paste?: string[];
}

export interface ReadinessGroup {
  key: string;
  /** The step in "Before you deploy main" this group belongs to, in words. */
  step: string;
  title: string;
  items: ReadinessItem[];
}

export interface ReadinessReport {
  groups: ReadinessGroup[];
  counts: Readonly<Record<ReadinessStatus, number>>;
  /** APP_URL's origin when it is a valid URL, for the page head. Not a secret. */
  app_origin: string | null;
}

/** What the database can say, read by lib/ops/readiness-facts.ts. Null = it couldn't be read. */
export interface ReadinessFacts {
  migrations: {
    applied: number;
    /** drizzle's created_at for the newest applied migration: the journal's `when`. */
    latest_applied_at: number | null;
    latest_applied_tag: string | null;
  } | null;
  /** The migration journal bundled with this build. */
  bundled_migrations: { count: number; latest_tag: string; latest_when: number };
  /** The bank marked current in bank_versions; null inside = none seeded. */
  bank: { seeded: string | null } | null;
  /** specs/question-bank-v1.json's bank_version, as bundled. */
  bundled_bank_version: string;
  law_review: { state: "missing" | "stale" | "current"; words: string } | null;
  first_campaigns_waiting: number | null;
  /** The multi-market spec's Hungary gates; absent when the database couldn't say. */
  hungary?: {
    /** NAV guide screenshots still missing, by file name. */
    nav_guide_missing: string[];
    /** Every per-tier usage quota confirmed by the owner (§B.4). */
    quotas_confirmed: boolean;
    /** Hungary's price book rows switched on. */
    prices_enabled: boolean;
    /** Hungary's compliance-matrix row, if any: signed off and unblocked for phone answering. */
    matrix: { exists: boolean; signed_off: boolean; phone_unblocked: boolean };
  } | null;
}

export type ReadinessEnv = Readonly<Record<string, string | undefined>>;

/* ── the callback paths the providers are pointed at ── */

export const SUPPORT_INBOUND_PATH = "/api/support/inbound";
export const EMAIL_EVENTS_PATH = "/api/email/events";
export const META_CALLBACK_PATH = "/api/connections/meta/callback";
export const STRIPE_WEBHOOK_PATH = "/api/stripe/webhook";
// The features' own constants live beside code that opens the database
// (lib/phone/line.ts, lib/google-ads/login.ts, lib/execution/tiktok-posting.ts,
// lib/tiktok/login.ts); readiness.test.ts checks these match them.
export const PHONE_VOICE_PATH = "/api/phone/voice";
export const PHONE_STATUS_PATH = "/api/phone/voice?step=status";
export const PHONE_RECORDING_PATH = "/api/phone/recording";
export const GOOGLE_ADS_CALLBACK_PATH = "/api/connections/google-ads/callback";
export const TIKTOK_POSTING_CALLBACK_PATH = "/api/connections/tiktok-posting/callback";
export const TIKTOK_ADS_CALLBACK_PATH = "/api/connections/tiktok/callback";

/** Resend's sandbox sender: delivers only to the Resend account's own owner. */
export const RESEND_DEFAULT_FROM = "onboarding@resend.dev";

const LINKS = {
  resendKeys: { label: "Resend → API keys", href: "https://resend.com/api-keys" },
  resendDomains: { label: "Resend → Domains", href: "https://resend.com/domains" },
  resendWebhooks: { label: "Resend → Webhooks", href: "https://resend.com/webhooks" },
  resendReceiving: { label: "Resend → Emails → Receiving", href: "https://resend.com/emails" },
  anthropic: { label: "Anthropic Console", href: "https://console.anthropic.com/" },
  vercelEnv: {
    label: "Vercel → project → Settings → Environment Variables",
    href: "https://vercel.com/dashboard",
  },
  vercelBlob: { label: "Vercel → Storage → Blob", href: "https://vercel.com/dashboard/stores" },
  meta: {
    label: "Meta for Developers → the SYB app",
    href: "https://developers.facebook.com/apps/",
  },
  stripeKeys: { label: "Stripe → API keys", href: "https://dashboard.stripe.com/apikeys" },
  stripeWebhooks: { label: "Stripe → Webhooks", href: "https://dashboard.stripe.com/webhooks" },
  google: {
    label: "Google Cloud → Credentials",
    href: "https://console.cloud.google.com/apis/credentials",
  },
  microsoft: { label: "Microsoft Entra → App registrations", href: "https://entra.microsoft.com" },
  apple: {
    label: "Apple Developer → Identifiers and Keys",
    href: "https://developer.apple.com/account/resources",
  },
  sentry: { label: "Sentry → project → Client Keys (DSN)", href: "https://sentry.io/" },
  twilio: { label: "Twilio Console → Account info", href: "https://console.twilio.com/" },
  twilioNumbers: {
    label: "Twilio → Phone Numbers → Active numbers → the number",
    href: "https://console.twilio.com/us1/develop/phone-numbers/manage/incoming",
  },
  twilioWhatsApp: {
    label: "Twilio → Messaging → Senders → WhatsApp senders",
    href: "https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders",
  },
  twilioContent: {
    label: "Twilio → Messaging → Content Template Builder",
    href: "https://console.twilio.com/us1/develop/sms/content-template-builder",
  },
  higgsfield: { label: "Higgsfield → API console", href: "https://higgsfield.ai/higgsfield-api" },
  googleAds: {
    label: "Google Cloud → Google Ads API → Overview",
    href: "https://console.cloud.google.com/google/ads-apis/overview",
  },
  tiktokDevelopers: {
    label: "TikTok for Developers → Manage apps → the SYB app",
    href: "https://developers.tiktok.com/",
  },
  tiktokBusiness: {
    label: "TikTok API for Business → My Apps → the app",
    href: "https://business-api.tiktok.com/portal",
  },
} satisfies Record<string, ReadinessLink>;

const MACHINE = "Your machine, with DATABASE_URL pointed at production";
const GENERATED = "You generate it";
const THIS_PAGE = "This page, in its own section";

const GENERATE_32 = `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`;

/* ── reading the env without ever repeating it ── */

function has(env: ReadinessEnv, key: string): boolean {
  return (env[key]?.trim() ?? "") !== "";
}

/** The domain of a From value ("Name <a@b.com>" or "a@b.com"), lowercased, or null. */
export function fromDomain(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  const address = (/<([^<>]+)>\s*$/.exec(value)?.[1] ?? value).trim().toLowerCase();
  const m = /^[^\s@<>]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/.exec(address);
  return m ? m[1]! : null;
}

function isResendDefault(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? "";
  return value.includes(RESEND_DEFAULT_FROM);
}

/** APP_URL as an origin, when it parses as http(s) with no path beyond "/". */
export function appOrigin(raw: string | undefined): { origin: string; https: boolean } | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // An origin carries no credentials; one that does is not echoed.
  if (url.username !== "" || url.password !== "") return null;
  return { origin: url.origin, https: url.protocol === "https:" };
}

/** "test" / "live" from a Stripe key's prefix — the word only, never the prefix itself. */
export function stripeMode(raw: string | undefined): "test" | "live" | "unknown" | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  if (/^(sk|rk)_test_/.test(value)) return "test";
  if (/^(sk|rk)_live_/.test(value)) return "live";
  return "unknown";
}

/** REPORT_PRICE_MINOR + REPORT_CURRENCY as stripe.ts reads them: integer minor units, ISO code. */
export function reportPrice(
  env: ReadinessEnv,
): { ok: true; amount_minor: number; currency: string; defaulted: boolean } | { ok: false } {
  const rawAmount = env.REPORT_PRICE_MINOR?.trim() ?? "";
  const rawCurrency = env.REPORT_CURRENCY?.trim() ?? "";
  const amountText = rawAmount === "" ? "4900" : rawAmount;
  if (!/^\d+$/.test(amountText)) return { ok: false };
  const amount = Number.parseInt(amountText, 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false };
  const currency = (rawCurrency === "" ? "eur" : rawCurrency).toUpperCase();
  if (!isIsoCurrency(currency)) return { ok: false };
  return {
    ok: true,
    amount_minor: amount,
    currency,
    defaulted: rawAmount === "" && rawCurrency === "",
  };
}

function connectorKeyOk(raw: string | undefined): boolean {
  try {
    parseKey(raw ?? "");
    return true;
  } catch {
    return false;
  }
}

const item = (
  name: string,
  status: ReadinessStatus,
  says: string,
  where: ReadinessLink | null,
  extra: Pick<ReadinessItem, "how" | "paste" | "where_text"> = {},
): ReadinessItem => ({ name, status, says, where, ...extra });

/* ── the groups, in the order of "Before you deploy main" ── */

function emailGroup(env: ReadinessEnv): ReadinessGroup {
  const app = appOrigin(env.APP_URL);
  const domain = fromDomain(env.EMAIL_FROM);
  return {
    key: "email",
    step: "Step 1 · and step 5",
    title: "Email first, or nobody can sign in",
    items: [
      has(env, "RESEND_API_KEY")
        ? item(
            "RESEND_API_KEY",
            "ready",
            "A Resend key is set, so sign-in links can be emailed.",
            LINKS.resendKeys,
          )
        : item(
            "RESEND_API_KEY",
            "missing",
            "I can't see a Resend key, so production can't email a sign-in link and nobody can sign in. Create one and paste it in.",
            LINKS.resendKeys,
          ),
      !has(env, "EMAIL_FROM")
        ? item(
            "EMAIL_FROM",
            "missing",
            `No sender is set, so mail goes from Resend's sandbox address, which only reaches the Resend account's owner. Set a From address on a domain verified in Resend.`,
            LINKS.resendDomains,
          )
        : isResendDefault(env.EMAIL_FROM)
          ? item(
              "EMAIL_FROM",
              "missing",
              "The sender is still Resend's sandbox address, which only reaches the Resend account's owner. Use an address on your own verified domain.",
              LINKS.resendDomains,
            )
          : domain === null
            ? item(
                "EMAIL_FROM",
                "missing",
                `I can't read an email address in the sender, so I can't tell which domain it uses. Write it as "SYB <hello@your-domain>".`,
                LINKS.resendDomains,
              )
            : item(
                "EMAIL_FROM",
                "ready",
                `Mail goes from ${domain}. I can't see from here whether Resend has verified it, so check that its Domains page says Verified.`,
                LINKS.resendDomains,
              ),
      app === null
        ? item(
            "APP_URL",
            "missing",
            has(env, "APP_URL")
              ? "APP_URL is set but isn't a plain http(s) origin I can read. Set it to the production origin, such as https://your-domain."
              : "APP_URL isn't set, so emailed sign-in and unsubscribe links fall back to whatever host the request came in on. Set it to the production origin.",
            LINKS.vercelEnv,
          )
        : app.https
          ? item("APP_URL", "ready", `Links in email point at ${app.origin}.`, LINKS.vercelEnv)
          : item(
              "APP_URL",
              "missing",
              `APP_URL is ${app.origin}, which isn't https. Sign-in and unsubscribe links must be https, so change it.`,
              LINKS.vercelEnv,
            ),
    ],
  };
}

function databaseGroup(facts: ReadinessFacts): ReadinessGroup {
  const bundled = facts.bundled_migrations;
  let migrations: ReadinessItem;
  if (facts.migrations === null) {
    migrations = item(
      "migrations",
      "check",
      "I couldn't read the migrations table, so I can't say which migrations ran. Check DATABASE_URL, then run db:migrate.",
      null,
      { how: "npm run db:migrate", where_text: MACHINE },
    );
  } else {
    const m = facts.migrations;
    const latest = m.latest_applied_tag ?? "none";
    if (m.latest_applied_at === bundled.latest_when && m.applied >= bundled.count) {
      migrations = item(
        "migrations",
        "ready",
        `All ${bundled.count} migrations this build carries have run; the newest is ${bundled.latest_tag}.`,
        null,
        { where_text: MACHINE },
      );
    } else if (m.latest_applied_at === null || m.latest_applied_at < bundled.latest_when) {
      migrations = item(
        "migrations",
        "missing",
        `${m.applied} of ${bundled.count} migrations have run (newest applied: ${latest}). Run db:migrate to bring the database to ${bundled.latest_tag}; first read the migration notes in docs/SECURITY-AUDIT.md (0055 can fail on duplicate stock proposals).`,
        null,
        { how: "npm run db:migrate", where_text: MACHINE },
      );
    } else {
      migrations = item(
        "migrations",
        "check",
        `The database has a migration newer than this build knows (${m.applied} applied, this build carries ${bundled.count}). Check that the deployed code is the build you meant.`,
        null,
        { where_text: MACHINE },
      );
    }
  }
  let bank: ReadinessItem;
  if (facts.bank === null) {
    bank = item(
      "question bank",
      "check",
      "I couldn't read which question bank is seeded. Check DATABASE_URL, then run db:seed.",
      null,
      { how: "npm run db:seed", where_text: MACHINE },
    );
  } else if (facts.bank.seeded === facts.bundled_bank_version) {
    bank = item(
      "question bank",
      "ready",
      `Bank ${facts.bundled_bank_version} is seeded and current, the same version this build carries.`,
      null,
      { where_text: MACHINE },
    );
  } else {
    bank = item(
      "question bank",
      "missing",
      facts.bank.seeded === null
        ? `No question bank is seeded. Run db:seed to load bank ${facts.bundled_bank_version}.`
        : `The seeded bank is ${facts.bank.seeded}, but this build carries ${facts.bundled_bank_version}. Run db:seed.`,
      null,
      { how: "npm run db:seed", where_text: MACHINE },
    );
  }
  return {
    key: "database",
    step: "Step 2",
    title: "Migrations and the question bank",
    items: [migrations, bank],
  };
}

function coreGroup(env: ReadinessEnv): ReadinessGroup {
  const mode = env.INTERVIEWER_MODE?.trim() ?? "";
  let interviewer: ReadinessItem;
  if (mode === "llm") {
    interviewer = item(
      "INTERVIEWER_MODE",
      "ready",
      "The interviewer is llm: Sonnet chooses each question, as production should.",
      LINKS.vercelEnv,
    );
  } else if (mode === "deterministic") {
    interviewer = item(
      "INTERVIEWER_MODE",
      "check",
      "The interviewer is deterministic: it asks the bank in order, which is for UI work and demos. Set it to llm for real intakes.",
      LINKS.vercelEnv,
    );
  } else {
    interviewer = item(
      "INTERVIEWER_MODE",
      "check",
      mode === ""
        ? "INTERVIEWER_MODE isn't set, so the interviewer runs deterministic. Set it to llm for real intakes."
        : "INTERVIEWER_MODE holds a value the code doesn't know, so the interviewer runs deterministic. Set it to llm.",
      LINKS.vercelEnv,
    );
  }

  // The suppression list is keyed from CONNECTOR_KEY alone (stableKey), so
  // COOKIE_SECRET can be set at any time; it only re-keys sign-in cookies.
  const cookie: ReadinessItem = has(env, "COOKIE_SECRET")
    ? item(
        "COOKIE_SECRET",
        "ready",
        "It's set, and the sign-in cookie and visitor keys are derived from it. Changing it later signs everyone out once; the suppression list doesn't depend on it.",
        null,
        { how: GENERATE_32, where_text: GENERATED },
      )
    : item(
        "COOKIE_SECRET",
        "off",
        "It's optional; without it the sign-in cookie and visitor keys come from CONNECTOR_KEY. You can set it any time: it signs everyone out once, and the suppression list doesn't depend on it.",
        null,
        { how: GENERATE_32, where_text: GENERATED },
      );

  return {
    key: "core",
    step: "Before step 3",
    title: "The keys everything else leans on",
    items: [
      !has(env, "CONNECTOR_KEY")
        ? item(
            "CONNECTOR_KEY",
            "missing",
            "It isn't set, so no connector can be connected and no connection secret can be read. Generate 32 random bytes and keep a copy safe; a lost key means every connection is authorised again.",
            null,
            { how: GENERATE_32, where_text: GENERATED },
          )
        : connectorKeyOk(env.CONNECTOR_KEY)
          ? item(
              "CONNECTOR_KEY",
              "ready",
              "It's set and decodes to 32 bytes, the length the cipher needs.",
              null,
              { where_text: GENERATED },
            )
          : item(
              "CONNECTOR_KEY",
              "missing",
              "It's set but doesn't decode to 32 bytes as base64 or hex, so the cipher would refuse it. Generate a new one before anything is connected.",
              null,
              { how: GENERATE_32, where_text: GENERATED },
            ),
      has(env, "CRON_SECRET")
        ? item(
            "CRON_SECRET",
            "ready",
            "It's set, so Vercel's scheduled runs (the weekly watch, the daily sync, due executions) can authenticate.",
            LINKS.vercelEnv,
          )
        : item(
            "CRON_SECRET",
            "missing",
            "It isn't set, so every scheduled run is refused and nothing syncs or executes on its own. Set any long random value; Vercel sends it automatically.",
            LINKS.vercelEnv,
            { how: GENERATE_32, where_text: GENERATED },
          ),
      has(env, "OPS_KEY")
        ? item(
            "OPS_KEY",
            "ready",
            "It's set; it is the key that opened this page.",
            LINKS.vercelEnv,
          )
        : item("OPS_KEY", "missing", "It isn't set, so /ops is switched off.", LINKS.vercelEnv, {
            how: GENERATE_32,
            where_text: GENERATED,
          }),
      has(env, "ANTHROPIC_API_KEY")
        ? item(
            "ANTHROPIC_API_KEY",
            "ready",
            "It's set, so the interviewer, the parser and the report can call the model.",
            LINKS.anthropic,
          )
        : item(
            "ANTHROPIC_API_KEY",
            "missing",
            "It isn't set, so the interviewer, the parser and the report can't run. Create a key in the Anthropic Console.",
            LINKS.anthropic,
          ),
      interviewer,
      cookie,
    ],
  };
}

function supportGroup(env: ReadinessEnv): ReadinessGroup {
  const app = appOrigin(env.APP_URL);
  const inboundUrl = app ? `${app.origin}${SUPPORT_INBOUND_PATH}` : null;
  const eventsUrl = app ? `${app.origin}${EMAIL_EVENTS_PATH}` : null;
  const domainRaw = env.SUPPORT_INBOUND_DOMAIN?.trim().toLowerCase() ?? "";
  const domainOk = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domainRaw);
  const bothSecrets = has(env, "RESEND_WEBHOOK_SECRET") && has(env, "RESEND_EVENTS_WEBHOOK_SECRET");
  const sameSecret =
    bothSecrets && env.RESEND_WEBHOOK_SECRET?.trim() === env.RESEND_EVENTS_WEBHOOK_SECRET?.trim();
  const noAppUrl = "Set APP_URL first; the URL to paste is built from it.";

  const webhook = (
    name: "RESEND_WEBHOOK_SECRET" | "RESEND_EVENTS_WEBHOOK_SECRET",
    url: string | null,
    events: string,
    what: string,
  ): ReadinessItem => {
    const paste = url ? [url, events] : [];
    if (!has(env, name)) {
      return item(
        name,
        "missing",
        `It isn't set, so ${what} refuses every delivery. Add a Resend webhook for ${events} and paste its signing secret here.${url ? "" : ` ${noAppUrl}`}`,
        LINKS.resendWebhooks,
        { paste },
      );
    }
    if (sameSecret) {
      return item(
        name,
        "check",
        "Both Resend webhook secrets are the same value, but each Resend webhook signs with its own. Paste each webhook's own secret.",
        LINKS.resendWebhooks,
        { paste },
      );
    }
    return item(
      name,
      "ready",
      `It's set. The webhook should point here, for ${events} only.`,
      LINKS.resendWebhooks,
      {
        paste,
      },
    );
  };

  return {
    key: "support",
    step: "Step 3",
    title: "Webhooks and the support inbox",
    items: [
      webhook("RESEND_WEBHOOK_SECRET", inboundUrl, "email.received", "the support inbox"),
      webhook(
        "RESEND_EVENTS_WEBHOOK_SECRET",
        eventsUrl,
        "email.delivered, email.bounced, email.complained, email.suppressed",
        "the campaign delivery endpoint",
      ),
      domainOk
        ? item(
            "SUPPORT_INBOUND_DOMAIN",
            "ready",
            `Each business's inbound address is s-<token>@${domainRaw}. Its MX record must point at Resend.`,
            LINKS.resendReceiving,
          )
        : item(
            "SUPPORT_INBOUND_DOMAIN",
            "missing",
            has(env, "SUPPORT_INBOUND_DOMAIN")
              ? "It's set but isn't a domain I can read, so no inbound address can be shown. Use the receiving domain alone, such as inbound.your-domain."
              : "It isn't set, so no business can be given an inbound address. Use a domain whose MX points at Resend, or the <id>.resend.app one from Emails → Receiving.",
            LINKS.resendReceiving,
          ),
      item(
        "open and click tracking",
        "check",
        "Turn both off on the sending domain in Resend, because click tracking rewrites unsubscribe links. I can't see that setting from here.",
        LINKS.resendDomains,
      ),
    ],
  };
}

function campaignGroup(env: ReadinessEnv, facts: ReadinessFacts): ReadinessGroup {
  const signInDomain = fromDomain(env.EMAIL_FROM);
  const campaignDomain = fromDomain(env.CAMPAIGN_EMAIL_FROM);
  let from: ReadinessItem;
  if (!has(env, "CAMPAIGN_EMAIL_FROM")) {
    from = item(
      "CAMPAIGN_EMAIL_FROM",
      "off",
      "It isn't set, so campaigns would share the sign-in sender. Before any real campaign, give campaigns their own verified subdomain, so complaints about a campaign can't hold up sign-in links.",
      LINKS.resendDomains,
    );
  } else if (campaignDomain === null) {
    from = item(
      "CAMPAIGN_EMAIL_FROM",
      "missing",
      `It's set but I can't read an email address in it. Write it as "SYB <hello@campaigns.your-domain>".`,
      LINKS.resendDomains,
    );
  } else if (campaignDomain === signInDomain) {
    from = item(
      "CAMPAIGN_EMAIL_FROM",
      "missing",
      `Campaigns and sign-in both send from ${campaignDomain}. Put campaigns on their own subdomain, such as campaigns.${campaignDomain}.`,
      LINKS.resendDomains,
    );
  } else {
    from = item(
      "CAMPAIGN_EMAIL_FROM",
      "ready",
      `Campaigns send from ${campaignDomain}, apart from sign-in${signInDomain ? ` (${signInDomain})` : ""}. Check it's verified in Resend too.`,
      LINKS.resendDomains,
    );
  }

  const review = facts.law_review;
  const law =
    review === null
      ? item(
          "email-law review",
          "check",
          "I couldn't read the law-review record. Check the database.",
          null,
          { where_text: THIS_PAGE },
        )
      : review.state === "current"
        ? item("email-law review", "ready", review.words, null, { where_text: THIS_PAGE })
        : item(
            "email-law review",
            "missing",
            `${review.words} Record it in the email-law review section of this page.`,
            null,
            { where_text: THIS_PAGE },
          );

  const waiting = facts.first_campaigns_waiting;
  const firsts =
    waiting === null
      ? item(
          "first-campaign reviews",
          "check",
          "I couldn't read which first campaigns are waiting.",
          null,
          { where_text: THIS_PAGE },
        )
      : waiting === 0
        ? item(
            "first-campaign reviews",
            "ready",
            "No account's first campaign is waiting for a person to read it.",
            null,
            { where_text: THIS_PAGE },
          )
        : item(
            "first-campaign reviews",
            "check",
            `${waiting} first ${waiting === 1 ? "campaign is" : "campaigns are"} waiting for a person to read ${waiting === 1 ? "it" : "them"} in the first-campaigns section of this page.`,
            null,
            { where_text: THIS_PAGE },
          );

  return {
    key: "campaigns",
    step: "Step 4",
    title: "Before any real campaign",
    // The real-write gate that holds campaign sends is its own group below.
    items: [from, law, firsts],
  };
}

function metaGroup(env: ReadinessEnv): ReadinessGroup {
  const app = appOrigin(env.APP_URL);
  const expected = app ? `${app.origin}${META_CALLBACK_PATH}` : null;
  const id = has(env, "META_APP_ID");
  const secret = has(env, "META_APP_SECRET");
  const login =
    id && secret
      ? item(
          "META_APP_ID + META_APP_SECRET",
          "ready",
          "Both are set, so Sign in with Facebook works on /connections.",
          LINKS.meta,
        )
      : id || secret
        ? item(
            "META_APP_ID + META_APP_SECRET",
            "missing",
            `Only ${id ? "META_APP_ID" : "META_APP_SECRET"} is set; Facebook sign-in needs both, so it stays switched off.`,
            LINKS.meta,
          )
        : item(
            "META_APP_ID + META_APP_SECRET",
            "off",
            "Neither is set, so Sign in with Facebook stays switched off. Copy both from the app's Basic settings when Meta is next.",
            LINKS.meta,
          );

  let redirect: ReadinessItem;
  const redirectRaw = env.META_OAUTH_REDIRECT_URI?.trim() ?? "";
  const paste = expected ? [expected] : [];
  if (expected === null) {
    redirect = item(
      "META_OAUTH_REDIRECT_URI",
      "missing",
      "Set APP_URL first; the redirect must be APP_URL plus the callback path.",
      LINKS.meta,
    );
  } else if (redirectRaw === "") {
    redirect = item(
      "META_OAUTH_REDIRECT_URI",
      "check",
      "It isn't set, so it is derived from APP_URL. Set it to exactly this, and register the same in Facebook Login → Valid OAuth Redirect URIs.",
      LINKS.meta,
      { paste },
    );
  } else if (redirectRaw === expected) {
    redirect = item(
      "META_OAUTH_REDIRECT_URI",
      "ready",
      "It matches APP_URL plus the callback path. Register exactly this in Facebook Login → Valid OAuth Redirect URIs.",
      LINKS.meta,
      { paste },
    );
  } else {
    redirect = item(
      "META_OAUTH_REDIRECT_URI",
      "missing",
      "It doesn't match APP_URL plus the callback path, so Meta would send owners somewhere else. Set it to exactly this.",
      LINKS.meta,
      { paste },
    );
  }

  const level = env.META_ACCESS_LEVEL?.trim() ?? "";
  const access =
    level === "advanced"
      ? item(
          "META_ACCESS_LEVEL",
          "check",
          "It says advanced. That is right only once App Review, Business Verification and Tech Provider verification all exist.",
          LINKS.meta,
        )
      : item(
          "META_ACCESS_LEVEL",
          "ready",
          level === "standard"
            ? "It says standard, which is right until Meta grants Advanced Access: only the pilot routes are offered."
            : "It reads as standard, which is right until Meta grants Advanced Access. Set it to standard explicitly.",
          LINKS.meta,
        );

  return {
    key: "meta",
    step: "Session D",
    title: "Meta and media",
    items: [
      login,
      redirect,
      access,
      has(env, "BLOB_READ_WRITE_TOKEN")
        ? item(
            "BLOB_READ_WRITE_TOKEN",
            "ready",
            "It's set, so rendered clips and images can wait at a public URL for publishing.",
            LINKS.vercelBlob,
          )
        : item(
            "BLOB_READ_WRITE_TOKEN",
            "missing",
            "It isn't set, so attaching a render to a content item fails. Create a Blob store and paste its read-write token.",
            LINKS.vercelBlob,
          ),
    ],
  };
}

function paymentsGroup(env: ReadinessEnv): ReadinessGroup {
  const app = appOrigin(env.APP_URL);
  const mode = stripeMode(env.STRIPE_SECRET_KEY);
  const key =
    mode === null
      ? item(
          "STRIPE_SECRET_KEY",
          "off",
          "It isn't set, so the report gate is unarmed and reports are free. Use a test key until go-live.",
          LINKS.stripeKeys,
        )
      : mode === "unknown"
        ? item(
            "STRIPE_SECRET_KEY",
            "check",
            "It's set but doesn't look like a Stripe secret or restricted key, so I can't tell test from live. Paste the key from Stripe's API keys page.",
            LINKS.stripeKeys,
          )
        : item(
            "STRIPE_SECRET_KEY",
            "ready",
            mode === "live"
              ? "It's set, and it is a live key: real cards are charged."
              : "It's set, and it is a test key: no real card is charged.",
            LINKS.stripeKeys,
          );
  const hook = has(env, "STRIPE_WEBHOOK_SECRET")
    ? item(
        "STRIPE_WEBHOOK_SECRET",
        "ready",
        "It's set, so paid reports unlock when Stripe confirms the payment.",
        LINKS.stripeWebhooks,
        {
          paste: app ? [`${app.origin}${STRIPE_WEBHOOK_PATH}`] : [],
        },
      )
    : item(
        "STRIPE_WEBHOOK_SECRET",
        mode === null ? "off" : "missing",
        mode === null
          ? "It isn't set; it is needed once a Stripe key is."
          : "A Stripe key is set but its webhook secret isn't, so a paid report never unlocks. Add the endpoint and paste its signing secret.",
        LINKS.stripeWebhooks,
        { paste: app ? [`${app.origin}${STRIPE_WEBHOOK_PATH}`] : [] },
      );
  const price = reportPrice(env);
  const priceItem = price.ok
    ? item(
        "REPORT_PRICE_MINOR + REPORT_CURRENCY",
        "ready",
        `The report costs ${format(money(price.amount_minor, price.currency))}${price.defaulted ? ", the default" : ""}.`,
        LINKS.vercelEnv,
      )
    : item(
        "REPORT_PRICE_MINOR + REPORT_CURRENCY",
        "missing",
        "The price must be a positive whole number of minor units (4900 for €49.00) and a three-letter currency code. Checkout fails until it is.",
        LINKS.vercelEnv,
      );
  return {
    key: "payments",
    step: "Payments",
    title: "The report's payment gate",
    items: [key, hook, priceItem],
  };
}

function optionalGroup(env: ReadinessEnv): ReadinessGroup {
  const provider = (
    name: string,
    keys: string[],
    link: ReadinessLink,
    label: string,
  ): ReadinessItem => {
    const set = keys.filter((k) => has(env, k));
    if (set.length === keys.length) {
      return item(name, "ready", `${label} sign-in is on.`, link);
    }
    if (set.length === 0) {
      return item(name, "off", `${label} sign-in is off; the email link stays the way in.`, link);
    }
    const unset = keys.filter((k) => !has(env, k));
    return item(
      name,
      "missing",
      `${label} sign-in is half set up: ${unset.join(", ")} ${unset.length === 1 ? "is" : "are"} missing, so its button stays off.`,
      link,
    );
  };
  const server = has(env, "SENTRY_DSN");
  const client = has(env, "NEXT_PUBLIC_SENTRY_DSN");
  return {
    key: "optional",
    step: "Optional",
    title: "Social sign-in and error monitoring",
    items: [
      provider(
        "GOOGLE_CLIENT_ID + SECRET",
        ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
        LINKS.google,
        "Google",
      ),
      provider(
        "MICROSOFT_CLIENT_ID + SECRET",
        ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
        LINKS.microsoft,
        "Microsoft",
      ),
      provider(
        "APPLE_CLIENT_ID, TEAM_ID, KEY_ID, PRIVATE_KEY",
        ["APPLE_CLIENT_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"],
        LINKS.apple,
        "Apple",
      ),
      server && client
        ? item(
            "SENTRY_DSN + NEXT_PUBLIC_SENTRY_DSN",
            "ready",
            "Errors are reported to Sentry from the server and the browser.",
            LINKS.sentry,
          )
        : server || client
          ? item(
              "SENTRY_DSN + NEXT_PUBLIC_SENTRY_DSN",
              "check",
              `Only the ${server ? "server" : "browser"} DSN is set, so errors on the ${server ? "browser" : "server"} side go unreported.`,
              LINKS.sentry,
            )
          : item(
              "SENTRY_DSN + NEXT_PUBLIC_SENTRY_DSN",
              "off",
              "Error monitoring is off.",
              LINKS.sentry,
            ),
    ],
  };
}

/* ── Hungary, the launch market (the multi-market spec) ──
 *
 * What only the owner can supply before Hungary opens: counsel's sign-off
 * in the compliance matrix, SYB's NAV software identity (which waits on
 * counsel's answer about registration), the NAV guide's screenshots, the
 * per-tier quotas, and the Hungarian prices. Nothing here is a secret.
 */
function hungaryGroup(env: ReadinessEnv, facts: ReadinessFacts): ReadinessGroup {
  const h = facts.hungary ?? null;
  const MATRIX = { where_text: "/ops → country compliance matrix (below)" };
  const SETUP = { where_text: "SETUP.md, section 9" };
  const unknown = (name: string, where: { where_text: string }) =>
    item(
      name,
      "check",
      "The database couldn't be read for this, so it can't be checked now.",
      null,
      where,
    );
  const id = env.NAV_SOFTWARE_ID?.trim() ?? "";
  const navId =
    id === ""
      ? item(
          "NAV_SOFTWARE_ID",
          "off",
          "Empty, so SYB sends nothing to NAV. Set it once counsel confirms whether NAV needs the software registered.",
          null,
          { where_text: "SETUP.md, section 5; then Vercel → Environment Variables" },
        )
      : /^[0-9A-Z-]{18}$/.test(id) && has(env, "NAV_SOFTWARE_DEV_CONTACT")
        ? item("NAV_SOFTWARE_ID", "ready", "SYB's NAV software identity is set.", null, {
            where_text: "SETUP.md, section 5",
          })
        : item(
            "NAV_SOFTWARE_ID",
            "missing",
            "Set, but not usable: it must be exactly 18 characters (0-9, A-Z, -) and NAV_SOFTWARE_DEV_CONTACT must be set too.",
            null,
            { where_text: "SETUP.md, section 5" },
          );
  return {
    key: "hungary",
    step: "Hungary",
    title: "Hungary, the launch market",
    items: [
      h === null
        ? unknown("Compliance matrix: HU", MATRIX)
        : h.matrix.phone_unblocked
          ? item(
              "Compliance matrix: HU",
              "ready",
              "Hungary is signed off and unblocked for phone answering.",
              null,
              MATRIX,
            )
          : item(
              "Compliance matrix: HU",
              h.matrix.exists && h.matrix.signed_off ? "check" : "missing",
              h.matrix.exists
                ? "Hungary has a row but phone answering is still blocked. Unblock it in the matrix below once counsel has signed off."
                : "Hungary has no row, so phone answering is blocked there. Add it in the matrix below with counsel's sign-off date and reference.",
              null,
              MATRIX,
            ),
      navId,
      h === null
        ? unknown("NAV guide screenshots", SETUP)
        : h.nav_guide_missing.length === 0
          ? item(
              "NAV guide screenshots",
              "ready",
              "Every step of the NAV guide has its screenshot.",
              null,
              SETUP,
            )
          : item(
              "NAV guide screenshots",
              "missing",
              `The NAV guide stays off until its screenshots are in public/nav-guide/: ${andList(h.nav_guide_missing)} ${isAre(h.nav_guide_missing.length)} missing.`,
              null,
              { where_text: "public/nav-guide/README.md" },
            ),
      h === null
        ? unknown("Usage quotas", SETUP)
        : h.quotas_confirmed
          ? item("Usage quotas", "ready", "Every tier's usage quotas are confirmed.", null, SETUP)
          : item(
              "Usage quotas",
              "missing",
              "The per-tier quotas are placeholders until you confirm them; Hungary's prices can't be switched on before that.",
              null,
              SETUP,
            ),
      h === null
        ? unknown("Hungarian prices", SETUP)
        : h.prices_enabled
          ? item("Hungarian prices", "ready", "Hungary's price book is on.", null, SETUP)
          : item(
              "Hungarian prices",
              "off",
              "Hungary's price book is seeded and off. It can be switched on once the quotas are confirmed.",
              null,
              SETUP,
            ),
    ],
  };
}

/* ── the features added on 2026-11-08 ──
 *
 * Each reads its settings through the feature's own check in lib/env.ts,
 * handed this env, so the panel and the feature can't disagree. A feature
 * nobody has started setting up is OFF, never MISSING: the count of
 * missing settings is what go-live still needs, and an unchosen feature
 * needs nothing. Once any of its own keys is set, the rest are MISSING.
 */

const NO_APP_URL = "Set APP_URL first; the URL to paste is built from it.";

const isAre = (n: number) => (n === 1 ? "is" : "are");

/** "A", "A and B", "A, B and C". */
function andList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** An E.164 number, which is not a secret, once it reads as one; null otherwise. */
function e164(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  return /^\+[1-9][0-9]{6,14}$/.test(value) ? value : null;
}

/** Millionths of a US dollar as dollars, for display only: 112000 → "$0.112". */
export function usdMicros(m: number): string {
  const cents = String(m % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `$${Math.floor(m / 1_000_000)}.${cents}`;
}

/**
 * A redirect the provider matches byte for byte. `derived` says what an
 * unset value means: "fine" (APP_URL plus the path is used, as Google Ads
 * does), "set it" (derived, but production should pin it, as Meta and
 * TikTok posting say), or "required" (never derived, as TikTok Ads).
 */
function redirectItem(
  env: ReadinessEnv,
  name: string,
  path: string,
  opts: {
    derived: "fine" | "set it" | "required";
    /** The feature is set up or being set up; otherwise the item is OFF. */
    chosen: boolean;
    registerAt: string;
    link: ReadinessLink;
  },
): ReadinessItem {
  const app = appOrigin(env.APP_URL);
  const expected = app ? `${app.origin}${path}` : null;
  const raw = env[name]?.trim() ?? "";
  const paste = expected ? [expected] : [];
  if (expected === null) {
    return item(
      name,
      opts.chosen ? "missing" : "off",
      "Set APP_URL first; the redirect must be APP_URL plus the callback path.",
      opts.link,
    );
  }
  if (raw === "") {
    if (!opts.chosen) {
      return item(
        name,
        "off",
        `It isn't set, and isn't needed until the rest of this is. When it is, it must be exactly this, registered in ${opts.registerAt}.`,
        opts.link,
        { paste },
      );
    }
    return opts.derived === "fine"
      ? item(
          name,
          "ready",
          `It isn't set, so the redirect is APP_URL plus the callback path. Register exactly this in ${opts.registerAt}.`,
          opts.link,
          { paste },
        )
      : opts.derived === "set it"
        ? item(
            name,
            "check",
            `It isn't set, so it is derived from APP_URL. Set it to exactly this, and register the same in ${opts.registerAt}.`,
            opts.link,
            { paste },
          )
        : item(
            name,
            "missing",
            `It isn't set, and it is never guessed: the provider matches it byte for byte. Set it to exactly this, and register the same in ${opts.registerAt}.`,
            opts.link,
            { paste },
          );
  }
  if (raw === expected) {
    return item(
      name,
      "ready",
      `It matches APP_URL plus the callback path. Register exactly this in ${opts.registerAt}.`,
      opts.link,
      { paste },
    );
  }
  return item(
    name,
    "missing",
    "It doesn't match APP_URL plus the callback path, so the provider would send owners somewhere else. Set it to exactly this.",
    opts.link,
    { paste },
  );
}

/**
 * A key pair the feature needs both of. `ready` is the feature's own
 * answer (lib/env.ts); the rest says which half is missing.
 */
function pairItem(
  env: ReadinessEnv,
  name: string,
  keys: readonly [string, string],
  words: { ready: string; needs: string; off: string },
  link: ReadinessLink,
  state: { ready: boolean; chosen: boolean },
): ReadinessItem {
  const [a, b] = [has(env, keys[0]), has(env, keys[1])];
  const chosen = state.chosen;
  if (state.ready) return item(name, "ready", words.ready, link);
  if (a || b) {
    return item(
      name,
      "missing",
      `Only ${a ? keys[0] : keys[1]} is set; ${words.needs} needs both, so it stays switched off.`,
      link,
    );
  }
  return item(
    name,
    chosen ? "missing" : "off",
    chosen ? `Neither is set; ${words.needs} needs both, so it stays switched off.` : words.off,
    link,
  );
}

function phoneGroup(env: ReadinessEnv): ReadinessGroup {
  const app = appOrigin(env.APP_URL);
  const missing = twilioMissing(env);
  const chosen = TWILIO_KEYS.some((k) => has(env, k));
  const off =
    "so the phone line stays switched off: /support says it isn't set up, and the webhook refuses every call.";
  const setting = (
    name: (typeof TWILIO_KEYS)[number],
    ready: string,
    wrong: string,
    link: ReadinessLink,
  ): ReadinessItem => {
    if (!missing.includes(name)) return item(name, "ready", ready, link);
    if (has(env, name)) return item(name, "missing", `${wrong} The line stays switched off.`, link);
    return item(name, chosen ? "missing" : "off", `It isn't set, ${off}`, link);
  };
  const number = e164(env.TWILIO_PHONE_NUMBER);
  const paste = app
    ? [`${app.origin}${PHONE_VOICE_PATH}`, `${app.origin}${PHONE_STATUS_PATH}`]
    : [];
  const webhooks = !chosen
    ? item(
        "Twilio voice webhooks",
        "off",
        "Once the three settings above are set, point the number's webhooks here.",
        LINKS.twilioNumbers,
        { paste },
      )
    : app === null
      ? item("Twilio voice webhooks", "missing", NO_APP_URL, LINKS.twilioNumbers)
      : item(
          "Twilio voice webhooks",
          "check",
          `In Twilio, set the number's "A call comes in" webhook to the first URL and its call status callback to the second, both HTTP POST. I can't see Twilio's settings from here.`,
          LINKS.twilioNumbers,
          { paste },
        );
  return {
    key: "phone",
    step: "Phone line · P6-02",
    title: "Answering the phone",
    items: [
      setting(
        "TWILIO_ACCOUNT_SID",
        "It's set and reads as a Twilio account id. Every webhook must name this account.",
        "It's set but isn't a Twilio account id (AC followed by 32 letters and digits).",
        LINKS.twilio,
      ),
      setting(
        "TWILIO_AUTH_TOKEN",
        "It's set. It checks the signature on every webhook, so keep it as secret as CONNECTOR_KEY.",
        "It's set but has a space in it, so it can't be the token. Paste it again from the Console.",
        LINKS.twilio,
      ),
      setting(
        "TWILIO_PHONE_NUMBER",
        `Callers dial ${number ?? "the number"}. One business per number; the owner turns the line on from /support.`,
        "It's set but isn't a number in international form (E.164, such as +447700900123).",
        LINKS.twilioNumbers,
      ),
      webhooks,
    ],
  };
}

function recordingGroup(env: ReadinessEnv): ReadinessGroup {
  // lib/phone-recording/recordings.ts recordingMissing(), as production reads
  // it: the phone line's settings, a media store (Blob, in production) and
  // CONNECTOR_KEY, which seals the audio. readiness.test.ts holds them equal.
  const needs: string[] = [
    ...twilioMissing(env),
    ...(blobTokenSet(env) ? [] : ["BLOB_READ_WRITE_TOKEN"]),
    ...(connectorKeyOk(env.CONNECTOR_KEY) ? [] : ["CONNECTOR_KEY"]),
  ];
  const lineChosen = TWILIO_KEYS.some((k) => has(env, k));
  const ready = needs.length === 0;
  const setup = ready
    ? item(
        "recording needs",
        "ready",
        "Everything recording needs is set: the phone line, media storage and CONNECTOR_KEY (the audio is sealed with a key made from it). Recording still starts off for every business until its owner switches it on in /support, and callers hear that the call is recorded first.",
        null,
        { where_text: "The phone line above, Vercel Blob, and CONNECTOR_KEY above" },
      )
    : lineChosen
      ? item(
          "recording needs",
          "missing",
          `Recording can't be switched on yet: ${andList(needs)} ${isAre(needs.length)} missing or not right. It stays off for every business, and /support says what is needed.`,
          null,
          { where_text: "The phone line above, Vercel Blob, and CONNECTOR_KEY above" },
        )
      : item(
          "recording needs",
          "off",
          "The phone line isn't set up, so call recording stays off for every business.",
          null,
          { where_text: "The phone line above, Vercel Blob, and CONNECTOR_KEY above" },
        );

  const days = phoneRecordingKeepDays(env);
  const rawDays = env.PHONE_RECORDING_KEEP_DAYS?.trim() ?? "";
  const honoured = /^[0-9]{1,3}$/.test(rawDays) && Number.parseInt(rawDays, 10) === days;
  const keep =
    rawDays === ""
      ? item(
          "PHONE_RECORDING_KEEP_DAYS",
          "ready",
          `It isn't set, so recordings are kept ${days} days, the default, then deleted by the daily run. Callers hear this number in the notice.`,
          LINKS.vercelEnv,
        )
      : honoured
        ? item(
            "PHONE_RECORDING_KEEP_DAYS",
            "ready",
            `Recordings are kept ${days} ${days === 1 ? "day" : "days"}, then deleted by the daily run. Callers hear this number in the notice.`,
            LINKS.vercelEnv,
          )
        : item(
            "PHONE_RECORDING_KEEP_DAYS",
            "check",
            `It holds something other than 1 to 365 whole days, so recordings are kept ${PHONE_RECORDING_KEEP_DAYS_DEFAULT} days, the default. Set a whole number of days, or empty it.`,
            LINKS.vercelEnv,
          );

  const app = appOrigin(env.APP_URL);
  const callbackWords =
    "Twilio posts each finished recording here, signed. SYB names it in every recorded call, so there is nothing to set in Twilio; it only has to be reachable.";
  const callback =
    app === null
      ? item(
          "recording callback",
          ready ? "missing" : "off",
          "Set APP_URL first; the callback is built from it.",
          null,
          { where_text: "SYB names it to Twilio in each recorded call" },
        )
      : item("recording callback", ready ? "ready" : "off", callbackWords, null, {
          where_text: "SYB names it to Twilio in each recorded call",
          paste: [`${app.origin}${PHONE_RECORDING_PATH}`],
        });

  return {
    key: "recording",
    step: "Call recording · P6-08",
    title: "Recording calls, off until each owner says yes",
    items: [setup, keep, callback],
  };
}

function whatsappGroup(env: ReadinessEnv): ReadinessGroup {
  const missing = whatsappMissing(env);
  const chosen = has(env, "TWILIO_WHATSAPP_FROM") || has(env, "TWILIO_WHATSAPP_SUMMARY_TEMPLATES");
  const offWords =
    "so WhatsApp summaries stay switched off: /watch says WhatsApp isn't set up, and nothing goes to WhatsApp.";

  const account = twilioAccountMissing(env);
  const shared = !chosen
    ? item(
        "Twilio account, shared with the phone line",
        "off",
        "WhatsApp isn't set up. When it is, it sends through the phone line's Twilio account (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN).",
        LINKS.twilio,
      )
    : account.length === 0
      ? item(
          "Twilio account, shared with the phone line",
          "ready",
          "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set; WhatsApp sends through the same Twilio account as the phone line.",
          LINKS.twilio,
        )
      : item(
          "Twilio account, shared with the phone line",
          "missing",
          `WhatsApp sends through the phone line's Twilio account, and ${andList(account)} ${isAre(account.length)} missing or not right (see "Answering the phone"), ${offWords}`,
          LINKS.twilio,
        );

  const fromNumber = e164(env.TWILIO_WHATSAPP_FROM);
  const from = !missing.includes("TWILIO_WHATSAPP_FROM")
    ? item(
        "TWILIO_WHATSAPP_FROM",
        "ready",
        `Summaries go from ${fromNumber ?? "the sender"} on WhatsApp. Each owner still gives their number and ticks the opt-in on /watch; nothing goes without that yes.`,
        LINKS.twilioWhatsApp,
      )
    : has(env, "TWILIO_WHATSAPP_FROM")
      ? item(
          "TWILIO_WHATSAPP_FROM",
          "missing",
          `It's set but isn't a number in international form (E.164, such as +447700900123), ${offWords}`,
          LINKS.twilioWhatsApp,
        )
      : item(
          "TWILIO_WHATSAPP_FROM",
          chosen ? "missing" : "off",
          `It isn't set, ${offWords} It is the WhatsApp-enabled sender on the Twilio account.`,
          LINKS.twilioWhatsApp,
        );

  const parsed = parseWhatsAppTemplates(env.TWILIO_WHATSAPP_SUMMARY_TEMPLATES);
  let templates: ReadinessItem;
  if (parsed !== null) {
    // Only the languages SYB speaks are named; any other key is counted, never shown.
    const known = LOCALES.filter((l) => l in parsed);
    const others = Object.keys(parsed).filter((k) => !isAppLocale(k)).length;
    const named = andList([
      ...known,
      ...(others > 0 ? [`${others} other ${others === 1 ? "entry" : "entries"}`] : []),
    ]);
    templates = item(
      "TWILIO_WHATSAPP_SUMMARY_TEMPLATES",
      "ready",
      `Templates are set for ${named}; a language without its own gets the English one. Meta must approve each before Twilio sends it, and I can't see that from here, so check each says Approved.`,
      LINKS.twilioContent,
    );
  } else if (has(env, "TWILIO_WHATSAPP_SUMMARY_TEMPLATES")) {
    templates = item(
      "TWILIO_WHATSAPP_SUMMARY_TEMPLATES",
      "missing",
      `It's set but isn't JSON I can use: it must map each language to an approved template id (HX followed by 32 characters), with an "en" entry, ${offWords}`,
      LINKS.twilioContent,
    );
  } else {
    templates = item(
      "TWILIO_WHATSAPP_SUMMARY_TEMPLATES",
      chosen ? "missing" : "off",
      `It isn't set, ${offWords} Submit the words in specs/whatsapp-summary-v1.md in Twilio's Content Template Builder for Meta's approval, then put each approved id here as JSON, such as {"en":"HX…"}.`,
      LINKS.twilioContent,
    );
  }

  return {
    key: "whatsapp",
    step: "WhatsApp · P6-07",
    title: "The weekly summary on WhatsApp",
    items: [shared, from, templates],
  };
}

function videoGroup(env: ReadinessEnv): ReadinessGroup {
  const setting = mediaProviderSetting(env);
  const raw = env.MEDIA_PROVIDER?.trim().toLowerCase() ?? "";
  const hf = higgsfieldEnv(env);
  const on = setting === "higgsfield";
  const keySet = has(env, "HIGGSFIELD_API_KEY") || has(env, "HIGGSFIELD_API_SECRET");
  const chosen = on || keySet;
  const offWords =
    "AI video stays switched off: /content says generation isn't set up, and nothing is proposed.";

  let provider: ReadinessItem;
  if (on) {
    provider = item(
      "MEDIA_PROVIDER",
      "ready",
      "It says higgsfield, so AI video goes through Higgsfield's API: three candidates per brief, picked in /studio, and only ever through an approved proposal with its cost.",
      LINKS.vercelEnv,
    );
  } else if (raw === "fake") {
    provider =
      setting === "fake"
        ? item(
            "MEDIA_PROVIDER",
            "check",
            "It says fake: placeholder art, for development. Production refuses it; set it to higgsfield there.",
            LINKS.vercelEnv,
          )
        : item(
            "MEDIA_PROVIDER",
            "missing",
            "It says fake, which production refuses because it would publish placeholder art, so generation is off. Set it to higgsfield.",
            LINKS.vercelEnv,
          );
  } else if (setting === "vendor") {
    provider = item(
      "MEDIA_PROVIDER",
      "missing",
      "It says vendor, a slot with no provider built behind it, so nothing can be generated. Set it to higgsfield.",
      LINKS.vercelEnv,
    );
  } else {
    const what =
      raw === "" || raw === "off"
        ? "It isn't higgsfield"
        : "It holds a value the code doesn't know";
    provider = keySet
      ? item(
          "MEDIA_PROVIDER",
          "missing",
          `${what}, so the Higgsfield key below goes unused and ${offWords} Set it to higgsfield.`,
          LINKS.vercelEnv,
        )
      : item(
          "MEDIA_PROVIDER",
          "off",
          `${what}, so ${offWords} Set it to higgsfield once the Higgsfield key is set.`,
          LINKS.vercelEnv,
        );
  }

  const keyName = "HIGGSFIELD_API_KEY + HIGGSFIELD_API_SECRET";
  let key: ReadinessItem;
  if (hf.key !== null) {
    key = item(
      keyName,
      "ready",
      "The key id and its secret are set. They spend Higgsfield's prepaid API balance, which is separate from any higgsfield.ai web plan.",
      LINKS.higgsfield,
    );
  } else if (has(env, "HIGGSFIELD_API_KEY")) {
    key = item(
      keyName,
      "missing",
      "Only HIGGSFIELD_API_KEY is set; it needs HIGGSFIELD_API_SECRET too, or the whole id:secret in HIGGSFIELD_API_KEY. Until then nothing is proposed.",
      LINKS.higgsfield,
    );
  } else if (has(env, "HIGGSFIELD_API_SECRET")) {
    key = item(
      keyName,
      "missing",
      "Only HIGGSFIELD_API_SECRET is set; HIGGSFIELD_API_KEY, the key id, is missing. Until then nothing is proposed.",
      LINKS.higgsfield,
    );
  } else if (on) {
    key = item(
      keyName,
      "missing",
      "MEDIA_PROVIDER says higgsfield, but no key is set, so the studio says so and nothing is proposed. Buy API credit and create a key in Higgsfield's API console.",
      LINKS.higgsfield,
    );
  } else {
    key = item(
      keyName,
      "off",
      "Neither is set. Buy Higgsfield API credit (separate from a web plan) and create a key when AI video is next.",
      LINKS.higgsfield,
    );
  }

  // The optional limits: shown as the numbers SYB will use, never as the raw text.
  const ignored: string[] = [];
  const capRaw = env.HIGGSFIELD_MONTHLY_CAP_MINOR?.trim() ?? "";
  if (capRaw !== "" && !(/^\d+$/.test(capRaw) && Number(capRaw) === hf.monthly_cap_minor)) {
    ignored.push("HIGGSFIELD_MONTHLY_CAP_MINOR");
  }
  const modelRaw = env.HIGGSFIELD_MODEL?.trim() ?? "";
  if (modelRaw !== "" && modelRaw !== hf.model) ignored.push("HIGGSFIELD_MODEL");
  const priceRaw = env.HIGGSFIELD_USD_MICROS_PER_SECOND?.trim() ?? "";
  if (
    priceRaw !== "" &&
    !(/^\d+$/.test(priceRaw) && Number(priceRaw) === hf.usd_micros_per_second)
  ) {
    ignored.push("HIGGSFIELD_USD_MICROS_PER_SECOND");
  }
  const cap = format(money(hf.monthly_cap_minor, "USD"));
  const model =
    hf.model === HIGGSFIELD_DEFAULTS.model
      ? `the default model, ${HIGGSFIELD_DEFAULTS.model}`
      : "the model set in HIGGSFIELD_MODEL";
  const summary = `Each business may spend up to ${cap} a month${capRaw === "" ? " (the default)" : ""}, on ${model} at ${usdMicros(hf.usd_micros_per_second)} a second; three 5-second candidates cost about ${usdMicros(15 * hf.usd_micros_per_second)}.`;
  const limitsName = "HIGGSFIELD_MONTHLY_CAP_MINOR, MODEL, USD_MICROS_PER_SECOND";
  const limits = !on
    ? item(limitsName, "off", `Optional, and used once AI video is on. ${summary}`, LINKS.vercelEnv)
    : ignored.length > 0
      ? item(
          limitsName,
          "check",
          `${andList(ignored)} ${ignored.length === 1 ? "holds a value that can't be used, so the default applies" : "hold values that can't be used, so the defaults apply"}. ${summary}`,
          LINKS.vercelEnv,
        )
      : item(limitsName, "ready", summary, LINKS.vercelEnv);

  const storageName = "BLOB_READ_WRITE_TOKEN, for video";
  const storage = blobTokenSet(env)
    ? item(
        storageName,
        chosen ? "ready" : "off",
        chosen
          ? "Media storage is set, so the chosen clip can wait at a public URL for publishing."
          : "Media storage is set; AI video will use it once it is on.",
        LINKS.vercelBlob,
      )
    : item(
        storageName,
        chosen ? "missing" : "off",
        chosen
          ? "Media storage isn't set, so a generated clip has nowhere to wait for publishing. Create a Blob store and paste its read-write token."
          : "Media storage isn't set either; AI video needs it once it is on.",
        LINKS.vercelBlob,
      );

  return {
    key: "video",
    step: "AI video · P6-03",
    title: "AI video through Higgsfield",
    items: [provider, key, limits, storage],
  };
}

const GOOGLE_ADS_OWN_KEYS = [
  "GOOGLE_ADS_ACCESS_LEVEL",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_REDIRECT_URI",
] as const;

function googleAdsGroup(env: ReadinessEnv): ReadinessGroup {
  const chosen = GOOGLE_ADS_OWN_KEYS.some((k) => has(env, k));
  const missing = googleAdsMissing(env);
  const gads = googleAdsEnv(env);
  const offWords =
    "so Google Ads stays switched off: the card on /connections names what is missing, and the daily read and every change refuse.";

  const level = googleAdsAccessLevel(env);
  let access: ReadinessItem;
  if (level === "test") {
    access = item(
      "GOOGLE_ADS_ACCESS_LEVEL",
      "check",
      "It says test: Google lets SYB reach test accounts only, so a real owner's ad account is refused. Apply for Explorer on the Google Ads API overview page, then change it here.",
      LINKS.googleAds,
    );
  } else if (level !== null) {
    const what = {
      explorer: "real ad accounts, up to 2,880 operations a day",
      basic: "up to 15,000 operations a day, after Google's review",
      standard: "no daily cap, after Google's audit",
    }[level];
    access = item(
      "GOOGLE_ADS_ACCESS_LEVEL",
      "ready",
      `It says ${level}: ${what}. Owners see this level on their card, so change it when Google does.`,
      LINKS.googleAds,
    );
  } else if (has(env, "GOOGLE_ADS_ACCESS_LEVEL")) {
    access = item(
      "GOOGLE_ADS_ACCESS_LEVEL",
      "missing",
      `It holds a value the code doesn't know, ${offWords} Set the level Google has granted: test, explorer, basic or standard.`,
      LINKS.googleAds,
    );
  } else {
    access = item(
      "GOOGLE_ADS_ACCESS_LEVEL",
      chosen ? "missing" : "off",
      `It isn't set, ${offWords} It is never guessed: set the level Google has granted the Cloud project (a new one starts at test).`,
      LINKS.googleAds,
    );
  }

  const clientName = "GOOGLE_ADS_CLIENT_ID + SECRET";
  const clientMissing = missing.filter((k) => k !== "GOOGLE_ADS_ACCESS_LEVEL");
  const own = googleAdsClientSource(env) === "own";
  const client =
    clientMissing.length === 0
      ? item(
          clientName,
          "ready",
          own
            ? "Google Ads has its own OAuth client, so adwords' verification can't hold up sign-in."
            : "Neither is set, so Google Ads uses the Google sign-in client (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET). Its consent screen needs the adwords scope.",
          LINKS.google,
        )
      : own
        ? item(
            clientName,
            "missing",
            `${andList(clientMissing)} ${isAre(clientMissing.length)} missing; with either of Google Ads' own client keys set, the sign-in client isn't used, ${offWords}`,
            LINKS.google,
          )
        : item(
            clientName,
            chosen ? "missing" : "off",
            `No OAuth client is set for it, ${offWords} Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET, or GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to reuse sign-in's.`,
            LINKS.google,
          );

  const redirect = redirectItem(env, "GOOGLE_ADS_REDIRECT_URI", GOOGLE_ADS_CALLBACK_PATH, {
    derived: "fine",
    chosen,
    registerAt: "the OAuth client's Authorized redirect URIs",
    link: LINKS.google,
  });

  const extrasName = "GOOGLE_ADS_DEVELOPER_TOKEN + LOGIN_CUSTOMER_ID";
  let extras: ReadinessItem;
  if (gads === null) {
    extras = item(
      extrasName,
      "off",
      "Optional, and read only once Google Ads is set up. Google retired developer tokens on 2026-09-09; a manager account id is needed only to read through one.",
      LINKS.googleAds,
    );
  } else {
    const issues: string[] = [];
    if (has(env, "GOOGLE_ADS_DEVELOPER_TOKEN") && gads.developer_token === null) {
      issues.push("GOOGLE_ADS_DEVELOPER_TOKEN has a space in it, so it isn't sent.");
    }
    if (has(env, "GOOGLE_ADS_LOGIN_CUSTOMER_ID") && gads.login_customer_id === null) {
      issues.push(
        "GOOGLE_ADS_LOGIN_CUSTOMER_ID isn't ten digits, so SYB reads each account directly.",
      );
    }
    extras =
      issues.length > 0
        ? item(extrasName, "check", issues.join(" "), LINKS.googleAds)
        : item(
            extrasName,
            "ready",
            `${gads.developer_token ? "A developer token is sent, though Google says it is ignored since 2026-09-09" : "No developer token, which Google no longer needs"}; SYB ${gads.login_customer_id ? "reads through a manager account" : "reads each account directly, the usual case"}.`,
            LINKS.googleAds,
          );
  }

  return {
    key: "google_ads",
    step: "Google Ads · P2-20 / P3-22",
    title: "Google Ads: read daily, changed only on approval",
    items: [access, client, redirect, extras],
  };
}

function tiktokPostingGroup(env: ReadinessEnv): ReadinessGroup {
  const chosen = ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REDIRECT_URI"].some((k) =>
    has(env, k),
  );
  // tiktokPostingEnv is what the TikTok card asks: non-null means both keys are set.
  const posting = tiktokPostingEnv(env) !== null;
  const pair = pairItem(
    env,
    "TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET",
    ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
    {
      ready:
        "Both are set, so the TikTok card on /connections offers sign-in. Real posts still wait for SESSION_D_REAL_WRITES.",
      needs: "TikTok sign-in",
      off: "Neither is set, so TikTok posting stays switched off: the card says it isn't set up yet. Copy both from the app's Credentials when TikTok is next.",
    },
    LINKS.tiktokDevelopers,
    { ready: posting, chosen },
  );
  const redirect = redirectItem(env, "TIKTOK_REDIRECT_URI", TIKTOK_POSTING_CALLBACK_PATH, {
    derived: "set it",
    chosen,
    registerAt: "Login Kit → Redirect URI",
    link: LINKS.tiktokDevelopers,
  });
  const audited = tiktokAuditStatus(env) === "audited";
  const raw = env.TIKTOK_AUDIT_STATUS?.trim() ?? "";
  const audit = audited
    ? item(
        "TIKTOK_AUDIT_STATUS",
        "check",
        "It says audited. That is right only once TikTok's Content Posting API audit has passed; until then TikTok refuses any post that isn't private.",
        LINKS.tiktokDevelopers,
      )
    : item(
        "TIKTOK_AUDIT_STATUS",
        "ready",
        raw === "unaudited"
          ? `It says unaudited, which is right until TikTok's audit passes: every post goes out private ("only me"), and the screen offers only that.`
          : `It reads as unaudited, which is right until TikTok's audit passes: every post goes out private ("only me"). Set it to unaudited explicitly.`,
        LINKS.tiktokDevelopers,
      );
  return {
    key: "tiktok_posting",
    step: "TikTok posting",
    title: "Posting to TikTok",
    items: [pair, redirect, audit],
  };
}

function tiktokAdsGroup(env: ReadinessEnv): ReadinessGroup {
  const missing = tiktokAdsMissing(env);
  const chosen = missing.length < 3;
  const pair = pairItem(
    env,
    "TIKTOK_ADS_APP_ID + TIKTOK_ADS_SECRET",
    ["TIKTOK_ADS_APP_ID", "TIKTOK_ADS_SECRET"],
    {
      ready: "Both are set, from the app's Basic Information.",
      needs: "TikTok Ads",
      off: "Neither is set, so TikTok Ads stays switched off: the card on /connections names what is missing, and every route refuses.",
    },
    LINKS.tiktokBusiness,
    {
      ready: !missing.includes("TIKTOK_ADS_APP_ID") && !missing.includes("TIKTOK_ADS_SECRET"),
      chosen,
    },
  );
  const redirect = redirectItem(env, "TIKTOK_ADS_REDIRECT_URI", TIKTOK_ADS_CALLBACK_PATH, {
    derived: "required",
    chosen,
    registerAt: "the app's advertiser redirect URL",
    link: LINKS.tiktokBusiness,
  });
  const review =
    missing.length === 0
      ? item(
          "TikTok app review",
          "check",
          "TikTok reviews the app (2–3 business days) before its sign-ins work, and I can't see from here whether it has. Its Scope of permission must be exactly the four in docs/DEPLOY.md; a token with one more or fewer is refused.",
          LINKS.tiktokBusiness,
        )
      : item(
          "TikTok app review",
          "off",
          "Once the three settings are set, submit the app for TikTok's review (2–3 business days); its sign-ins work only after it is approved.",
          LINKS.tiktokBusiness,
        );
  return {
    key: "tiktok_ads",
    step: "TikTok Ads",
    title: "TikTok Ads: spend read, changes only on approval",
    items: [pair, redirect, review],
  };
}

function writesGroup(env: ReadinessEnv): ReadinessGroup {
  const on = sessionDRealWritesOn(env);
  const raw = env.SESSION_D_REAL_WRITES?.trim() ?? "";
  const gate = on
    ? item(
        "SESSION_D_REAL_WRITES",
        "check",
        "The real-write gate is ON: approved Meta and TikTok posts really go out, approved Google, TikTok and Meta ad changes really run, campaign emails really send, and approved purchase orders are really emailed to suppliers. That is right only once the two-week unattended clock has completed and its date is in TASKS-PHASE3.md.",
        LINKS.vercelEnv,
      )
    : item(
        "SESSION_D_REAL_WRITES",
        "off",
        `The real-write gate is off, as it should be: nothing reaches a real platform. Approved Meta and TikTok posts, Google, TikTok and Meta ad changes, and campaign emails are held, still approved, with the reason shown; approved purchase orders run against a stand-in sender and are marked not sent.${raw === "" ? " It switches on only when it is exactly on, after the two-week clock." : " It holds a value other than on, which reads as off."}`,
        LINKS.vercelEnv,
      );

  // lib/purchasing/po.ts sendingMode: the same reading the order sender makes.
  const mode = sendingMode(env);
  const domain = fromDomain(env.EMAIL_FROM);
  let orders: ReadinessItem;
  if (mode.mode === "real") {
    orders = item(
      "purchase-order emails",
      "ready",
      `Approved purchase orders are emailed to suppliers from ${domain ?? "the sign-in sender"}, in the business's name.`,
      LINKS.resendDomains,
    );
  } else if (!mode.reasons.includes("email_not_set_up")) {
    orders = item(
      "purchase-order emails",
      "off",
      "Email is set up, but the gate is off, so approved orders run against a stand-in sender: nothing reaches a supplier, and the screen says it wasn't sent.",
      LINKS.resendDomains,
    );
  } else if (on) {
    orders = item(
      "purchase-order emails",
      "missing",
      "The gate is on, but SYB's email isn't set up for orders (RESEND_API_KEY and a From address on your own domain, not Resend's sandbox), so approved orders aren't sent.",
      LINKS.resendDomains,
    );
  } else {
    orders = item(
      "purchase-order emails",
      "off",
      "The gate is off and email isn't set up for orders yet (RESEND_API_KEY and a From address on your own domain), so approved orders run against a stand-in sender and nothing reaches a supplier.",
      LINKS.resendDomains,
    );
  }

  return {
    key: "writes",
    step: "Session D",
    title: "Real writes: the one switch",
    items: [
      gate,
      orders,
      item(
        "two-week unattended clock",
        "check",
        "Nothing in the database records the two-week unattended clock, so whether it has completed is the team's call. Record the date in TASKS-PHASE3.md before switching the gate on.",
        null,
        { where_text: "TASKS-PHASE3.md, by the team" },
      ),
    ],
  };
}

function languagesGroup(env: ReadinessEnv): ReadinessGroup {
  const raw = env.LANGUAGES_IN_REVIEW;
  const back = languagesInReview(raw);
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  // Never echoed: an entry that isn't a language SYB speaks could be anything.
  const ignored = entries.filter((e) => !(back as readonly string[]).includes(e));
  const english = ignored.includes("en");
  const name = (l: (typeof LOCALES)[number]) => `${LANGUAGE_NAMES[l]} (${l})`;
  const ignoredWords =
    ignored.length === 0
      ? ""
      : ` ${ignored.length} ${ignored.length === 1 ? "entry isn't" : "entries aren't"} a language SYB can send back${english ? " (English can't be: every catalogue is checked against it)" : ""}, so ${ignored.length === 1 ? "it is" : "they are"} ignored; codes are written like ru-RU or zh-Hans.`;
  let status: ReadinessItem;
  if (back.length > 0) {
    status = item(
      "LANGUAGES_IN_REVIEW",
      "check",
      `${andList(back.map(name))} ${isAre(back.length)} sent back to review: only the people named in LANGUAGE_REVIEW_ACCOUNTS see ${back.length === 1 ? "it" : "them"}, and everyone else sees English. Empty it once the native reviewer is done.${ignoredWords}`,
      LINKS.vercelEnv,
    );
  } else if (ignored.length > 0) {
    status = item(
      "LANGUAGES_IN_REVIEW",
      "check",
      `Every language is live.${ignoredWords}`,
      LINKS.vercelEnv,
    );
  } else {
    status = item(
      "LANGUAGES_IN_REVIEW",
      "ready",
      `It's empty, so every language is live: ${andList(LOCALES.map(name))}. Native review follows; to send one back, list its code here.`,
      LINKS.vercelEnv,
    );
  }
  return {
    key: "languages",
    step: "Languages",
    title: "Which languages customers see",
    items: [status],
  };
}

/** The whole checklist, in deploy order. Pure. */
export function launchReadiness(env: ReadinessEnv, facts: ReadinessFacts): ReadinessReport {
  const groups = [
    emailGroup(env),
    databaseGroup(facts),
    coreGroup(env),
    supportGroup(env),
    campaignGroup(env, facts),
    metaGroup(env),
    videoGroup(env),
    tiktokPostingGroup(env),
    googleAdsGroup(env),
    tiktokAdsGroup(env),
    writesGroup(env),
    paymentsGroup(env),
    phoneGroup(env),
    recordingGroup(env),
    whatsappGroup(env),
    languagesGroup(env),
    hungaryGroup(env, facts),
    optionalGroup(env),
  ];
  const counts: Record<ReadinessStatus, number> = { ready: 0, missing: 0, check: 0, off: 0 };
  for (const g of groups) for (const i of g.items) counts[i.status] += 1;
  return { groups, counts, app_origin: appOrigin(env.APP_URL)?.origin ?? null };
}
