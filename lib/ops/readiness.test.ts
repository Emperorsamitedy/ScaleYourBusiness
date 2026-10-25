// Launch readiness (lib/ops/readiness.ts) — every check with a passing
// and a failing case, against a fake env and fake database facts, and the
// one rule that matters most: no secret's value, nor any piece of one,
// appears anywhere in what the panel is given to render.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReadinessEnv, ReadinessFacts, ReadinessItem, ReadinessStatus } from "./readiness";
import { appOrigin, fromDomain, launchReadiness, reportPrice, stripeMode } from "./readiness";

const KEY_32_BASE64 = Buffer.alloc(32, 7).toString("base64");

const FACTS: ReadinessFacts = {
  migrations: {
    applied: 57,
    latest_applied_at: 1_792_782_507_264,
    latest_applied_tag: "0056_watery_thena",
  },
  bundled_migrations: {
    count: 57,
    latest_tag: "0056_watery_thena",
    latest_when: 1_792_782_507_264,
  },
  bank: { seeded: "1.7.0" },
  bundled_bank_version: "1.7.0",
  law_review: {
    state: "current",
    words: "The email-law rules were reviewed against current law on 2026-10-20.",
  },
  first_campaigns_waiting: 0,
};

const GOOD: ReadinessEnv = {
  APP_URL: "https://app.syb.example",
  RESEND_API_KEY: "re_live_key",
  EMAIL_FROM: "SYB <hello@syb.example>",
  CAMPAIGN_EMAIL_FROM: "SYB <hello@campaigns.syb.example>",
  CONNECTOR_KEY: KEY_32_BASE64,
  CRON_SECRET: "cron",
  OPS_KEY: "ops",
  ANTHROPIC_API_KEY: "sk-ant-key",
  INTERVIEWER_MODE: "llm",
  RESEND_WEBHOOK_SECRET: "whsec_inbound",
  RESEND_EVENTS_WEBHOOK_SECRET: "whsec_events",
  SUPPORT_INBOUND_DOMAIN: "inbound.syb.example",
  META_APP_ID: "123",
  META_APP_SECRET: "meta-secret",
  META_OAUTH_REDIRECT_URI: "https://app.syb.example/api/connections/meta/callback",
  META_ACCESS_LEVEL: "standard",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x",
  STRIPE_SECRET_KEY: "sk_test_abc",
  STRIPE_WEBHOOK_SECRET: "whsec_stripe",
};

function find(env: ReadinessEnv, name: string, facts: ReadinessFacts = FACTS): ReadinessItem {
  for (const g of launchReadiness(env, facts).groups) {
    const hit = g.items.find((i) => i.name === name);
    if (hit) return hit;
  }
  throw new Error(`no item ${name}`);
}

const status = (env: ReadinessEnv, name: string, facts: ReadinessFacts = FACTS): ReadinessStatus =>
  find(env, name, facts).status;

describe("launch readiness — the order and the counts", () => {
  it("follows Before you deploy main: email, database, core, support, campaigns, Meta, payments, optional", () => {
    const report = launchReadiness(GOOD, FACTS);
    expect(report.groups.map((g) => g.key)).toEqual([
      "email",
      "database",
      "core",
      "support",
      "campaigns",
      "meta",
      "payments",
      "optional",
    ]);
    const total = report.groups.reduce((n, g) => n + g.items.length, 0);
    expect(Object.values(report.counts).reduce((a, b) => a + b, 0)).toBe(total);
    expect(report.app_origin).toBe("https://app.syb.example");
  });

  it("every item says where its value comes from: a dashboard link, or words", () => {
    for (const env of [GOOD, {}]) {
      for (const g of launchReadiness(env, FACTS).groups) {
        for (const i of g.items) {
          expect(i.where !== null || (i.where_text ?? "") !== "", i.name).toBe(true);
          if (i.where) expect(i.where.href, i.name).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it("an empty env is MISSING where launch needs it, and never READY where it can't know", () => {
    const report = launchReadiness({}, FACTS);
    expect(report.counts.missing).toBeGreaterThan(10);
    for (const g of report.groups) {
      for (const i of g.items) {
        expect(["ready", "missing", "check", "off"]).toContain(i.status);
        expect(i.says.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("email", () => {
  it("RESEND_API_KEY: present is READY, absent is MISSING", () => {
    expect(status(GOOD, "RESEND_API_KEY")).toBe("ready");
    expect(status({ ...GOOD, RESEND_API_KEY: "  " }, "RESEND_API_KEY")).toBe("missing");
  });

  it("EMAIL_FROM: a real domain is READY and named; absent, the Resend default or unreadable is MISSING", () => {
    const ok = find(GOOD, "EMAIL_FROM");
    expect(ok.status).toBe("ready");
    expect(ok.says).toContain("syb.example");
    expect(status({ ...GOOD, EMAIL_FROM: undefined }, "EMAIL_FROM")).toBe("missing");
    expect(status({ ...GOOD, EMAIL_FROM: "SYB <onboarding@resend.dev>" }, "EMAIL_FROM")).toBe(
      "missing",
    );
    expect(status({ ...GOOD, EMAIL_FROM: "not an address" }, "EMAIL_FROM")).toBe("missing");
  });

  it("APP_URL: https is READY; http, junk or absent is MISSING", () => {
    expect(status(GOOD, "APP_URL")).toBe("ready");
    expect(status({ ...GOOD, APP_URL: "http://app.syb.example" }, "APP_URL")).toBe("missing");
    expect(status({ ...GOOD, APP_URL: "syb" }, "APP_URL")).toBe("missing");
    expect(status({ ...GOOD, APP_URL: undefined }, "APP_URL")).toBe("missing");
  });
});

describe("database", () => {
  it("migrations: all applied is READY; behind is MISSING with the counts; unreadable or ahead is CHECK", () => {
    expect(status(GOOD, "migrations")).toBe("ready");
    const behind = find(GOOD, "migrations", {
      ...FACTS,
      migrations: {
        applied: 55,
        latest_applied_at: 1_792_741_506_910,
        latest_applied_tag: "0055_gorgeous_shriek",
      },
    });
    expect(behind.status).toBe("missing");
    expect(behind.says).toContain("55 of 57");
    expect(behind.says).toContain("0055_gorgeous_shriek");
    expect(
      status(GOOD, "migrations", {
        ...FACTS,
        migrations: { applied: 0, latest_applied_at: null, latest_applied_tag: null },
      }),
    ).toBe("missing");
    expect(status(GOOD, "migrations", { ...FACTS, migrations: null })).toBe("check");
    expect(
      status(GOOD, "migrations", {
        ...FACTS,
        migrations: { applied: 58, latest_applied_at: 1_892_782_507_264, latest_applied_tag: null },
      }),
    ).toBe("check");
  });

  it("bank: the bundled version seeded is READY; another or none is MISSING; unreadable is CHECK", () => {
    expect(status(GOOD, "question bank")).toBe("ready");
    expect(status(GOOD, "question bank", { ...FACTS, bank: { seeded: "1.6.0" } })).toBe("missing");
    expect(status(GOOD, "question bank", { ...FACTS, bank: { seeded: null } })).toBe("missing");
    expect(status(GOOD, "question bank", { ...FACTS, bank: null })).toBe("check");
  });
});

describe("core", () => {
  it("CONNECTOR_KEY: 32 bytes is READY; absent or the wrong length is MISSING", () => {
    expect(status(GOOD, "CONNECTOR_KEY")).toBe("ready");
    expect(status({ ...GOOD, CONNECTOR_KEY: "a".repeat(64) }, "CONNECTOR_KEY")).toBe("ready");
    expect(status({ ...GOOD, CONNECTOR_KEY: "short" }, "CONNECTOR_KEY")).toBe("missing");
    expect(status({ ...GOOD, CONNECTOR_KEY: undefined }, "CONNECTOR_KEY")).toBe("missing");
  });

  it("CRON_SECRET, OPS_KEY and ANTHROPIC_API_KEY: present is READY, absent is MISSING", () => {
    for (const name of ["CRON_SECRET", "OPS_KEY", "ANTHROPIC_API_KEY"]) {
      expect(status(GOOD, name)).toBe("ready");
      expect(status({ ...GOOD, [name]: "" }, name)).toBe("missing");
    }
  });

  it("INTERVIEWER_MODE: llm is READY; deterministic, unset or unknown is CHECK, and an unknown value isn't echoed", () => {
    expect(status(GOOD, "INTERVIEWER_MODE")).toBe("ready");
    expect(status({ ...GOOD, INTERVIEWER_MODE: "deterministic" }, "INTERVIEWER_MODE")).toBe(
      "check",
    );
    expect(status({ ...GOOD, INTERVIEWER_MODE: undefined }, "INTERVIEWER_MODE")).toBe("check");
    const odd = find({ ...GOOD, INTERVIEWER_MODE: "sk-ant-pasted-here" }, "INTERVIEWER_MODE");
    expect(odd.status).toBe("check");
    expect(odd.says).not.toContain("sk-ant");
  });

  it("COOKIE_SECRET: set is READY; unset is OFF; either way safe to set, suppressions don't depend on it", () => {
    expect(status({ ...GOOD, COOKIE_SECRET: "c" }, "COOKIE_SECRET")).toBe("ready");
    const fresh = find(GOOD, "COOKIE_SECRET");
    expect(fresh.status).toBe("off");
    expect(fresh.says).toContain("set it any time");
    expect(fresh.says).toContain("doesn't depend on it");
  });
});

describe("support inbox", () => {
  it("webhook secrets: present is READY with the URL to paste; absent is MISSING; the same value twice is CHECK", () => {
    const inbound = find(GOOD, "RESEND_WEBHOOK_SECRET");
    expect(inbound.status).toBe("ready");
    expect(inbound.paste).toContain("https://app.syb.example/api/support/inbound");
    const events = find(GOOD, "RESEND_EVENTS_WEBHOOK_SECRET");
    expect(events.paste).toContain("https://app.syb.example/api/email/events");
    expect(status({ ...GOOD, RESEND_WEBHOOK_SECRET: "" }, "RESEND_WEBHOOK_SECRET")).toBe("missing");
    expect(
      status({ ...GOOD, RESEND_EVENTS_WEBHOOK_SECRET: "" }, "RESEND_EVENTS_WEBHOOK_SECRET"),
    ).toBe("missing");
    const same = { ...GOOD, RESEND_EVENTS_WEBHOOK_SECRET: "whsec_inbound" };
    expect(status(same, "RESEND_WEBHOOK_SECRET")).toBe("check");
    expect(status(same, "RESEND_EVENTS_WEBHOOK_SECRET")).toBe("check");
  });

  it("without APP_URL there is no URL to paste, and the item says to set APP_URL first", () => {
    const item = find(
      { ...GOOD, APP_URL: undefined, RESEND_WEBHOOK_SECRET: "" },
      "RESEND_WEBHOOK_SECRET",
    );
    expect(item.paste).toEqual([]);
    expect(item.says).toContain("Set APP_URL first");
  });

  it("SUPPORT_INBOUND_DOMAIN: a domain is READY and named; absent or junk is MISSING", () => {
    expect(find(GOOD, "SUPPORT_INBOUND_DOMAIN").says).toContain("inbound.syb.example");
    expect(status({ ...GOOD, SUPPORT_INBOUND_DOMAIN: "" }, "SUPPORT_INBOUND_DOMAIN")).toBe(
      "missing",
    );
    expect(
      status({ ...GOOD, SUPPORT_INBOUND_DOMAIN: "not a domain" }, "SUPPORT_INBOUND_DOMAIN"),
    ).toBe("missing");
  });

  it("open and click tracking is always CHECK: it can't be seen from here", () => {
    expect(status(GOOD, "open and click tracking")).toBe("check");
    expect(status({}, "open and click tracking")).toBe("check");
  });
});

describe("campaigns", () => {
  it("CAMPAIGN_EMAIL_FROM: its own subdomain is READY; unset is OFF; the sign-in domain or junk is MISSING", () => {
    expect(status(GOOD, "CAMPAIGN_EMAIL_FROM")).toBe("ready");
    expect(status({ ...GOOD, CAMPAIGN_EMAIL_FROM: "" }, "CAMPAIGN_EMAIL_FROM")).toBe("off");
    expect(
      status({ ...GOOD, CAMPAIGN_EMAIL_FROM: "News <news@syb.example>" }, "CAMPAIGN_EMAIL_FROM"),
    ).toBe("missing");
    expect(status({ ...GOOD, CAMPAIGN_EMAIL_FROM: "campaigns" }, "CAMPAIGN_EMAIL_FROM")).toBe(
      "missing",
    );
  });

  it("the law review: current is READY; missing or stale is MISSING; unreadable is CHECK", () => {
    expect(status(GOOD, "email-law review")).toBe("ready");
    expect(
      status(GOOD, "email-law review", {
        ...FACTS,
        law_review: { state: "missing", words: "Nobody has." },
      }),
    ).toBe("missing");
    expect(
      status(GOOD, "email-law review", {
        ...FACTS,
        law_review: { state: "stale", words: "It changed." },
      }),
    ).toBe("missing");
    expect(status(GOOD, "email-law review", { ...FACTS, law_review: null })).toBe("check");
  });

  it("first-campaign reviews: none waiting is READY; some waiting is CHECK", () => {
    expect(status(GOOD, "first-campaign reviews")).toBe("ready");
    expect(
      find(GOOD, "first-campaign reviews", { ...FACTS, first_campaigns_waiting: 2 }).says,
    ).toContain("2 first campaigns are waiting");
  });

  it("the real-write gate: off is OFF and worded as the expected state; exactly on is CHECK", () => {
    const off = find(GOOD, "SESSION_D_REAL_WRITES");
    expect(off.status).toBe("off");
    expect(off.says).toContain("as it should be");
    expect(status({ ...GOOD, SESSION_D_REAL_WRITES: "true" }, "SESSION_D_REAL_WRITES")).toBe("off");
    expect(status({ ...GOOD, SESSION_D_REAL_WRITES: "on" }, "SESSION_D_REAL_WRITES")).toBe("check");
  });

  it("the two-week clock is the team's call: always CHECK", () => {
    const clock = find(GOOD, "two-week unattended clock");
    expect(clock.status).toBe("check");
    expect(clock.says).toContain("team's call");
  });
});

describe("Meta", () => {
  it("app id and secret: both is READY; one is MISSING; neither is OFF", () => {
    const name = "META_APP_ID + META_APP_SECRET";
    expect(status(GOOD, name)).toBe("ready");
    expect(status({ ...GOOD, META_APP_SECRET: "" }, name)).toBe("missing");
    expect(status({ ...GOOD, META_APP_ID: "", META_APP_SECRET: "" }, name)).toBe("off");
  });

  it("the redirect: APP_URL + the callback is READY; another value is MISSING; unset is CHECK; no APP_URL is MISSING", () => {
    const name = "META_OAUTH_REDIRECT_URI";
    expect(status(GOOD, name)).toBe("ready");
    const wrong = find({ ...GOOD, META_OAUTH_REDIRECT_URI: "https://elsewhere.example/cb" }, name);
    expect(wrong.status).toBe("missing");
    expect(wrong.says).not.toContain("elsewhere");
    expect(wrong.paste).toEqual(["https://app.syb.example/api/connections/meta/callback"]);
    expect(status({ ...GOOD, META_OAUTH_REDIRECT_URI: "" }, name)).toBe("check");
    expect(status({ ...GOOD, APP_URL: "" }, name)).toBe("missing");
  });

  it("META_ACCESS_LEVEL: standard is READY; advanced is CHECK", () => {
    expect(status(GOOD, "META_ACCESS_LEVEL")).toBe("ready");
    expect(status({ ...GOOD, META_ACCESS_LEVEL: "advanced" }, "META_ACCESS_LEVEL")).toBe("check");
  });

  it("BLOB_READ_WRITE_TOKEN: present is READY, absent is MISSING", () => {
    expect(status(GOOD, "BLOB_READ_WRITE_TOKEN")).toBe("ready");
    expect(status({ ...GOOD, BLOB_READ_WRITE_TOKEN: "" }, "BLOB_READ_WRITE_TOKEN")).toBe("missing");
  });
});

describe("payments", () => {
  it("the Stripe key: says test or live as information; unset is OFF; an unknown shape is CHECK", () => {
    expect(find(GOOD, "STRIPE_SECRET_KEY").says).toContain("test key");
    const live = find({ ...GOOD, STRIPE_SECRET_KEY: "sk_live_abc" }, "STRIPE_SECRET_KEY");
    expect(live.status).toBe("ready");
    expect(live.says).toContain("live key");
    expect(status({ ...GOOD, STRIPE_SECRET_KEY: "" }, "STRIPE_SECRET_KEY")).toBe("off");
    expect(status({ ...GOOD, STRIPE_SECRET_KEY: "pk_test_abc" }, "STRIPE_SECRET_KEY")).toBe(
      "check",
    );
  });

  it("the webhook secret: present is READY; missing beside a key is MISSING; missing with no key is OFF", () => {
    expect(status(GOOD, "STRIPE_WEBHOOK_SECRET")).toBe("ready");
    expect(status({ ...GOOD, STRIPE_WEBHOOK_SECRET: "" }, "STRIPE_WEBHOOK_SECRET")).toBe("missing");
    expect(
      status(
        { ...GOOD, STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" },
        "STRIPE_WEBHOOK_SECRET",
      ),
    ).toBe("off");
  });

  it("the price: integer minor units and a currency is READY; a float or a bad code is MISSING", () => {
    const name = "REPORT_PRICE_MINOR + REPORT_CURRENCY";
    expect(find(GOOD, name).says).toContain("€49.00, the default");
    expect(
      find({ ...GOOD, REPORT_PRICE_MINOR: "1500000", REPORT_CURRENCY: "huf" }, name).says,
    ).toContain("15,000.00");
    expect(status({ ...GOOD, REPORT_PRICE_MINOR: "49.00" }, name)).toBe("missing");
    expect(status({ ...GOOD, REPORT_PRICE_MINOR: "0" }, name)).toBe("missing");
    expect(status({ ...GOOD, REPORT_CURRENCY: "euro" }, name)).toBe("missing");
  });
});

describe("optional", () => {
  it("each sign-in provider: all keys is READY, none is OFF, some is MISSING", () => {
    const name = "GOOGLE_CLIENT_ID + SECRET";
    expect(status({ ...GOOD, GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" }, name)).toBe(
      "ready",
    );
    expect(status(GOOD, name)).toBe("off");
    const half = find({ ...GOOD, GOOGLE_CLIENT_ID: "g" }, name);
    expect(half.status).toBe("missing");
    expect(half.says).toContain("GOOGLE_CLIENT_SECRET");
    const apple = "APPLE_CLIENT_ID, TEAM_ID, KEY_ID, PRIVATE_KEY";
    expect(status({ ...GOOD, APPLE_CLIENT_ID: "a", APPLE_TEAM_ID: "t" }, apple)).toBe("missing");
  });

  it("Sentry: both DSNs is READY, one is CHECK, none is OFF", () => {
    const name = "SENTRY_DSN + NEXT_PUBLIC_SENTRY_DSN";
    expect(status({ ...GOOD, SENTRY_DSN: "d", NEXT_PUBLIC_SENTRY_DSN: "d" }, name)).toBe("ready");
    expect(status({ ...GOOD, SENTRY_DSN: "d" }, name)).toBe("check");
    expect(status(GOOD, name)).toBe("off");
  });
});

describe("the pure readers", () => {
  it("fromDomain reads the address's domain, or null", () => {
    expect(fromDomain("SYB <Hello@Mail.Example.COM>")).toBe("mail.example.com");
    expect(fromDomain("hello@example.com")).toBe("example.com");
    expect(fromDomain("SYB")).toBeNull();
    expect(fromDomain(undefined)).toBeNull();
  });

  it("appOrigin keeps an origin and refuses credentials or other schemes", () => {
    expect(appOrigin("https://a.example/some/path")).toEqual({
      origin: "https://a.example",
      https: true,
    });
    expect(appOrigin("https://user:pw@a.example")).toBeNull();
    expect(appOrigin("ftp://a.example")).toBeNull();
  });

  it("stripeMode says the word, never the prefix", () => {
    expect(stripeMode("sk_test_x")).toBe("test");
    expect(stripeMode("rk_live_x")).toBe("live");
    expect(stripeMode("whatever")).toBe("unknown");
    expect(stripeMode("")).toBeNull();
  });

  it("reportPrice keeps money integer minor units and an ISO currency", () => {
    expect(reportPrice({})).toEqual({
      ok: true,
      amount_minor: 4900,
      currency: "EUR",
      defaulted: true,
    });
    expect(reportPrice({ REPORT_PRICE_MINOR: "12.5" })).toEqual({ ok: false });
    expect(reportPrice({ REPORT_CURRENCY: "zzz" })).toEqual({ ok: false });
  });
});

/* ── the rule: no secret value, nor any piece of one, in the output ── */

describe("no secret value appears anywhere in the readiness output", () => {
  // Every variable the checklist reads that holds a secret, each with a
  // unique sentinel after whatever prefix the provider uses. The prefix is
  // allowed to shape the WORD shown ("test"/"live"); the token never is.
  const SECRET_KEYS = [
    "RESEND_API_KEY",
    "CONNECTOR_KEY",
    "CRON_SECRET",
    "OPS_KEY",
    "ANTHROPIC_API_KEY",
    "COOKIE_SECRET",
    "RESEND_WEBHOOK_SECRET",
    "RESEND_EVENTS_WEBHOOK_SECRET",
    "META_APP_ID",
    "META_APP_SECRET",
    "BLOB_READ_WRITE_TOKEN",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "MICROSOFT_CLIENT_ID",
    "MICROSOFT_CLIENT_SECRET",
    "APPLE_CLIENT_ID",
    "APPLE_TEAM_ID",
    "APPLE_KEY_ID",
    "APPLE_PRIVATE_KEY",
    "SENTRY_DSN",
    "NEXT_PUBLIC_SENTRY_DSN",
    "SENTRY_TEST_KEY",
    "DATABASE_URL",
  ] as const;

  // A digest, not the key's name: a window of "cronsecret" would match the
  // ordinary word "secret" in a sentence and prove nothing.
  const token = (key: string) =>
    `Zq${createHash("sha256")
      .update(key)
      .digest("base64")
      .replace(/[^A-Za-z0-9]/g, "Q")
      .slice(0, 18)}SENTINELx9Q7`;
  const PREFIX: Partial<Record<(typeof SECRET_KEYS)[number], string>> = {
    STRIPE_SECRET_KEY: "sk_live_",
    STRIPE_WEBHOOK_SECRET: "whsec_",
    RESEND_WEBHOOK_SECRET: "whsec_",
    RESEND_EVENTS_WEBHOOK_SECRET: "whsec_",
    RESEND_API_KEY: "re_",
    ANTHROPIC_API_KEY: "sk-ant-",
    DATABASE_URL: "postgresql://syb:",
  };

  /** Every 6-character window of a token: "not even partially". */
  const windows = (s: string) => Array.from({ length: s.length - 5 }, (_, i) => s.slice(i, i + 6));

  function sentinelEnv(): Record<string, string> {
    const env: Record<string, string> = {
      APP_URL: "https://app.syb.example",
      EMAIL_FROM: "SYB <hello@syb.example>",
      CAMPAIGN_EMAIL_FROM: "SYB <hello@campaigns.syb.example>",
      SUPPORT_INBOUND_DOMAIN: "inbound.syb.example",
      // Non-secret settings holding a secret by mistake must not echo it either.
      INTERVIEWER_MODE: token("INTERVIEWERMODE"),
      META_ACCESS_LEVEL: token("METAACCESSLEVEL"),
      META_OAUTH_REDIRECT_URI: `https://evil.example/${token("METAOAUTHREDIRECT")}`,
      SESSION_D_REAL_WRITES: token("SESSIONDREALWRITES"),
      REPORT_PRICE_MINOR: token("REPORTPRICEMINOR"),
      REPORT_CURRENCY: token("REPORTCURRENCY"),
    };
    for (const key of SECRET_KEYS) env[key] = `${PREFIX[key] ?? ""}${token(key)}`;
    return env;
  }

  function assertClean(env: Record<string, string>, facts: ReadinessFacts) {
    const out = JSON.stringify(launchReadiness(env, facts));
    for (const [key, value] of Object.entries(env)) {
      // The non-secret facts the panel is allowed to show.
      if (["APP_URL", "EMAIL_FROM", "CAMPAIGN_EMAIL_FROM", "SUPPORT_INBOUND_DOMAIN"].includes(key))
        continue;
      expect(out, key).not.toContain(value);
      const sentinel = /Zq\w+SENTINELx9Q7/.exec(value)?.[0];
      expect(sentinel, key).toBeDefined();
      for (const w of windows(sentinel!)) expect(out, `${key}: "${w}"`).not.toContain(w);
    }
    // The prefix that tells test from live is shown as a word, never as itself.
    expect(out).not.toContain("sk_live_");
    expect(out).not.toContain("whsec_");
    expect(out).not.toContain("SENTINEL");
  }

  it("with every secret set, in every combination of database facts", () => {
    const env = sentinelEnv();
    assertClean(env, FACTS);
    assertClean(env, {
      ...FACTS,
      migrations: null,
      bank: null,
      law_review: null,
      first_campaigns_waiting: null,
    });
  });

  it("with the webhook secrets equal, a half-configured provider and a test-mode key", () => {
    const env = sentinelEnv();
    env.RESEND_EVENTS_WEBHOOK_SECRET = env.RESEND_WEBHOOK_SECRET!;
    delete env.GOOGLE_CLIENT_SECRET;
    delete env.APPLE_PRIVATE_KEY;
    delete env.NEXT_PUBLIC_SENTRY_DSN;
    env.STRIPE_SECRET_KEY = `sk_test_${token("STRIPESECRETKEY")}`;
    const out = JSON.stringify(launchReadiness(env, FACTS));
    expect(out).toContain("test key");
    expect(out).not.toContain("sk_test_");
    assertClean(env, FACTS);
  });

  it("the sentinel test itself bites: a leaked value would be found", () => {
    const env = sentinelEnv();
    const leaked = JSON.stringify({
      ...launchReadiness(env, FACTS),
      oops: env.CRON_SECRET!.slice(3, 12),
    });
    expect(windows(token("CRON_SECRET")).some((w) => leaked.includes(w))).toBe(true);
  });
});
