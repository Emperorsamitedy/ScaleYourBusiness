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
// the prefix), APP_URL's origin, the domain of a From address, and a
// handful of enumerated settings (INTERVIEWER_MODE, META_ACCESS_LEVEL)
// shown only when they hold a value the code knows. Anything else that
// looks wrong is described, never echoed — a secret pasted into the wrong
// variable must not surface here either. readiness.test.ts fills every
// variable with a sentinel and searches the whole output for it.

import { parseKey } from "../connectors/secrets";
import { format, isIsoCurrency, money } from "../core/money";

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
}

export type ReadinessEnv = Readonly<Record<string, string | undefined>>;

/* ── the callback paths the providers are pointed at ── */

export const SUPPORT_INBOUND_PATH = "/api/support/inbound";
export const EMAIL_EVENTS_PATH = "/api/email/events";
export const META_CALLBACK_PATH = "/api/connections/meta/callback";
export const STRIPE_WEBHOOK_PATH = "/api/stripe/webhook";

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
                `I can't read an email address in the sender, so I can't tell which domain it uses. Write it as "Ledgerline <hello@your-domain>".`,
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
      `It's set but I can't read an email address in it. Write it as "Ledgerline <hello@campaigns.your-domain>".`,
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

  const gateRaw = env.SESSION_D_REAL_WRITES?.trim() ?? "";
  const gate =
    gateRaw === "on"
      ? item(
          "SESSION_D_REAL_WRITES",
          "check",
          "The real-write gate is ON: approved posts and ad changes really go out. That is right only once the two-week unattended clock has completed and its date is in TASKS-PHASE3.md.",
          LINKS.vercelEnv,
        )
      : item(
          "SESSION_D_REAL_WRITES",
          "off",
          gateRaw === ""
            ? "The real-write gate is off, as it should be: nothing is published to Meta until it is exactly on, after the two-week clock."
            : "The real-write gate is off, as it should be. It holds a value other than on, which reads as off.",
          LINKS.vercelEnv,
        );

  return {
    key: "campaigns",
    step: "Step 4",
    title: "Before any real campaign",
    items: [
      from,
      law,
      firsts,
      gate,
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

/** The whole checklist, in deploy order. Pure. */
export function launchReadiness(env: ReadinessEnv, facts: ReadinessFacts): ReadinessReport {
  const groups = [
    emailGroup(env),
    databaseGroup(facts),
    coreGroup(env),
    supportGroup(env),
    campaignGroup(env, facts),
    metaGroup(env),
    paymentsGroup(env),
    optionalGroup(env),
  ];
  const counts: Record<ReadinessStatus, number> = { ready: 0, missing: 0, check: 0, off: 0 };
  for (const g of groups) for (const i of g.items) counts[i.status] += 1;
  return { groups, counts, app_origin: appOrigin(env.APP_URL)?.origin ?? null };
}
