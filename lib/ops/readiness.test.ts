// Launch readiness (lib/ops/readiness.ts) — every check with a passing
// and a failing case, against a fake env and fake database facts, and the
// one rule that matters most: no secret's value, nor any piece of one,
// appears anywhere in what the panel is given to render.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReadinessEnv, ReadinessFacts, ReadinessItem, ReadinessStatus } from "./readiness";
import {
  GOOGLE_ADS_CALLBACK_PATH,
  PHONE_RECORDING_PATH,
  PHONE_STATUS_PATH,
  PHONE_VOICE_PATH,
  TIKTOK_ADS_CALLBACK_PATH,
  TIKTOK_POSTING_CALLBACK_PATH,
  appOrigin,
  fromDomain,
  launchReadiness,
  reportPrice,
  stripeMode,
  usdMicros,
} from "./readiness";

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
  EMAIL_FROM: "ScaleX <hello@syb.example>",
  CAMPAIGN_EMAIL_FROM: "ScaleX <hello@campaigns.syb.example>",
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
  it("follows Before you deploy main, then each feature with its own key, the gate after everything it holds", () => {
    const report = launchReadiness(GOOD, FACTS);
    expect(report.groups.map((g) => g.key)).toEqual([
      "email",
      "database",
      "core",
      "support",
      "campaigns",
      "meta",
      "video",
      "tiktok_posting",
      "google_ads",
      "tiktok_ads",
      "writes",
      "payments",
      "phone",
      "recording",
      "whatsapp",
      "languages",
      "hungary",
      "optional",
    ]);
    const names = report.groups.flatMap((g) => g.items.map((i) => i.name));
    expect(new Set(names).size, "every item name is unique").toBe(names.length);
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

  it("a feature nobody has started setting up is OFF, never MISSING: missing counts only what go-live needs", () => {
    const report = launchReadiness(GOOD, FACTS);
    for (const key of [
      "video",
      "tiktok_posting",
      "google_ads",
      "tiktok_ads",
      "phone",
      "recording",
      "whatsapp",
    ]) {
      const group = report.groups.find((g) => g.key === key)!;
      for (const i of group.items) expect(i.status, `${key}: ${i.name}`).not.toBe("missing");
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
    expect(status({ ...GOOD, EMAIL_FROM: "ScaleX <onboarding@resend.dev>" }, "EMAIL_FROM")).toBe(
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
});

describe("real writes", () => {
  it("the real-write gate: off is OFF and worded as the expected state; exactly on is CHECK", () => {
    const off = find(GOOD, "SESSION_D_REAL_WRITES");
    expect(off.status).toBe("off");
    expect(off.says).toContain("as it should be");
    expect(off.says).toContain("nothing reaches a real platform");
    expect(status({ ...GOOD, SESSION_D_REAL_WRITES: "true" }, "SESSION_D_REAL_WRITES")).toBe("off");
    expect(
      find({ ...GOOD, SESSION_D_REAL_WRITES: "true" }, "SESSION_D_REAL_WRITES").says,
    ).toContain("reads as off");
    expect(status({ ...GOOD, SESSION_D_REAL_WRITES: "on" }, "SESSION_D_REAL_WRITES")).toBe("check");
  });

  it("the gate names everything it switches: posts, ad changes, campaign emails, purchase orders", () => {
    for (const env of [GOOD, { ...GOOD, SESSION_D_REAL_WRITES: "on" }]) {
      const says = find(env, "SESSION_D_REAL_WRITES").says;
      for (const word of [
        "Meta and TikTok posts",
        "Google, TikTok and Meta ad changes",
        "campaign emails",
        "purchase orders",
      ]) {
        expect(says, word).toContain(word);
      }
    }
  });

  it("purchase-order emails follow po.ts sendingMode: real is READY; gate off is OFF; gate on without email is MISSING", () => {
    const name = "purchase-order emails";
    const real = find({ ...GOOD, SESSION_D_REAL_WRITES: "on" }, name);
    expect(real.status).toBe("ready");
    expect(real.says).toContain("syb.example");
    expect(find(GOOD, name).status).toBe("off");
    expect(find(GOOD, name).says).toContain("stand-in sender");
    expect(status({ ...GOOD, SESSION_D_REAL_WRITES: "on", RESEND_API_KEY: "" }, name)).toBe(
      "missing",
    );
    expect(
      status({ ...GOOD, SESSION_D_REAL_WRITES: "on", EMAIL_FROM: "onboarding@resend.dev" }, name),
    ).toBe("missing");
    expect(status({ ...GOOD, RESEND_API_KEY: "" }, name)).toBe("off");
  });

  it("the two-week clock is the team's call: always CHECK", () => {
    const clock = find(GOOD, "two-week unattended clock");
    expect(clock.status).toBe("check");
    expect(clock.says).toContain("team's call");
  });
});

/* ── the features added on 2026-11-08 ── */

const SID = `AC${"0f1e2d3c4b5a6978".repeat(2)}`;
const PHONE: ReadinessEnv = {
  ...GOOD,
  TWILIO_ACCOUNT_SID: SID,
  TWILIO_AUTH_TOKEN: "twilio-token",
  TWILIO_PHONE_NUMBER: "+447700900123",
};

describe("phone line (P6-02)", () => {
  it("all three set and well formed: READY, the number named, the webhooks to paste as CHECK", () => {
    for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"]) {
      expect(status(PHONE, k), k).toBe("ready");
    }
    expect(find(PHONE, "TWILIO_PHONE_NUMBER").says).toContain("+447700900123");
    const hooks = find(PHONE, "Twilio voice webhooks");
    expect(hooks.status).toBe("check");
    expect(hooks.paste).toEqual([
      "https://app.syb.example/api/phone/voice",
      "https://app.syb.example/api/phone/voice?step=status",
    ]);
  });

  it("none set is OFF; one set makes the others MISSING; a malformed one is MISSING and not echoed", () => {
    for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"]) {
      expect(status(GOOD, k), k).toBe("off");
      expect(find(GOOD, k).says).toContain("stays switched off");
    }
    expect(status(GOOD, "Twilio voice webhooks")).toBe("off");
    const one = { ...GOOD, TWILIO_PHONE_NUMBER: "+447700900123" };
    expect(status(one, "TWILIO_ACCOUNT_SID")).toBe("missing");
    expect(status(one, "TWILIO_AUTH_TOKEN")).toBe("missing");
    const bad = find({ ...PHONE, TWILIO_ACCOUNT_SID: "SKnotanaccount" }, "TWILIO_ACCOUNT_SID");
    expect(bad.status).toBe("missing");
    expect(bad.says).not.toContain("SKnotanaccount");
    const number = find({ ...PHONE, TWILIO_PHONE_NUMBER: "07700 900123" }, "TWILIO_PHONE_NUMBER");
    expect(number.status).toBe("missing");
    expect(number.says).not.toContain("07700");
    expect(status({ ...PHONE, TWILIO_AUTH_TOKEN: "has space" }, "TWILIO_AUTH_TOKEN")).toBe(
      "missing",
    );
  });

  it("without APP_URL there are no webhook URLs, and the item says to set APP_URL first", () => {
    const hooks = find({ ...PHONE, APP_URL: "" }, "Twilio voice webhooks");
    expect(hooks.status).toBe("missing");
    expect(hooks.says).toContain("Set APP_URL first");
  });
});

describe("call recording (P6-08)", () => {
  it("phone, Blob and CONNECTOR_KEY all set is READY, still off per business; the callback is shown", () => {
    const ready = find(PHONE, "recording needs");
    expect(ready.status).toBe("ready");
    expect(ready.says).toContain("starts off for every business");
    const cb = find(PHONE, "recording callback");
    expect(cb.status).toBe("ready");
    expect(cb.paste).toEqual(["https://app.syb.example/api/phone/recording"]);
  });

  it("names each missing need; with no phone line at all it is OFF", () => {
    const noBlob = find({ ...PHONE, BLOB_READ_WRITE_TOKEN: "" }, "recording needs");
    expect(noBlob.status).toBe("missing");
    expect(noBlob.says).toContain("BLOB_READ_WRITE_TOKEN");
    const noKey = find({ ...PHONE, CONNECTOR_KEY: "short" }, "recording needs");
    expect(noKey.says).toContain("CONNECTOR_KEY");
    const halfLine = find({ ...GOOD, TWILIO_PHONE_NUMBER: "+447700900123" }, "recording needs");
    expect(halfLine.says).toContain("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN");
    expect(status(GOOD, "recording needs")).toBe("off");
    expect(status(GOOD, "recording callback")).toBe("off");
  });

  it("PHONE_RECORDING_KEEP_DAYS: unset is the default 30; a valid number is shown; junk is CHECK and not echoed", () => {
    const unset = find(GOOD, "PHONE_RECORDING_KEEP_DAYS");
    expect(unset.status).toBe("ready");
    expect(unset.says).toContain("30 days, the default");
    expect(
      find({ ...GOOD, PHONE_RECORDING_KEEP_DAYS: "14" }, "PHONE_RECORDING_KEEP_DAYS").says,
    ).toContain("kept 14 days");
    for (const junk of ["0", "400", "two weeks"]) {
      const odd = find({ ...GOOD, PHONE_RECORDING_KEEP_DAYS: junk }, "PHONE_RECORDING_KEEP_DAYS");
      expect(odd.status, junk).toBe("check");
      expect(odd.says).toContain("30 days, the default");
      // "0" is in every sentence's "30"; the longer ones must not be echoed.
      if (junk.length > 1) expect(odd.says).not.toContain(junk);
    }
  });
});

const TEMPLATES = JSON.stringify({ en: `HX${"a1".repeat(16)}`, "de-DE": `HX${"b2".repeat(16)}` });
const WHATSAPP: ReadinessEnv = {
  ...PHONE,
  TWILIO_WHATSAPP_FROM: "+447700900456",
  TWILIO_WHATSAPP_SUMMARY_TEMPLATES: TEMPLATES,
};

describe("WhatsApp summary (P6-07)", () => {
  it("all set is READY: the sender named, the template languages named, Meta's approval to check", () => {
    expect(status(WHATSAPP, "Twilio account, shared with the phone line")).toBe("ready");
    expect(find(WHATSAPP, "TWILIO_WHATSAPP_FROM").says).toContain("+447700900456");
    const t = find(WHATSAPP, "TWILIO_WHATSAPP_SUMMARY_TEMPLATES");
    expect(t.status).toBe("ready");
    expect(t.says).toContain("en and de-DE");
    expect(t.says).toContain("Meta must approve");
    expect(t.says).not.toContain("HX");
  });

  it("nothing WhatsApp set is OFF; the account missing beside a sender is MISSING", () => {
    for (const n of [
      "Twilio account, shared with the phone line",
      "TWILIO_WHATSAPP_FROM",
      "TWILIO_WHATSAPP_SUMMARY_TEMPLATES",
    ]) {
      expect(status(PHONE, n), n).toBe("off");
    }
    const noAccount = { ...GOOD, TWILIO_WHATSAPP_FROM: "+447700900456" };
    const shared = find(noAccount, "Twilio account, shared with the phone line");
    expect(shared.status).toBe("missing");
    expect(shared.says).toContain("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN");
    expect(status(noAccount, "TWILIO_WHATSAPP_SUMMARY_TEMPLATES")).toBe("missing");
  });

  it("templates: not JSON, no en, or a non-HX id is MISSING, and never echoed", () => {
    for (const bad of [
      "not json",
      JSON.stringify({ "de-DE": `HX${"b2".repeat(16)}` }),
      JSON.stringify({ en: "HXshort" }),
    ]) {
      const t = find(
        { ...WHATSAPP, TWILIO_WHATSAPP_SUMMARY_TEMPLATES: bad },
        "TWILIO_WHATSAPP_SUMMARY_TEMPLATES",
      );
      expect(t.status, bad).toBe("missing");
      expect(t.says).not.toContain(bad);
    }
  });

  it("an unknown template key is counted, never named", () => {
    const odd = JSON.stringify({ en: `HX${"a1".repeat(16)}`, "sk-pasted": `HX${"c3".repeat(16)}` });
    const t = find(
      { ...WHATSAPP, TWILIO_WHATSAPP_SUMMARY_TEMPLATES: odd },
      "TWILIO_WHATSAPP_SUMMARY_TEMPLATES",
    );
    expect(t.says).toContain("1 other entry");
    expect(t.says).not.toContain("sk-pasted");
  });

  it("a malformed sender is MISSING and not echoed", () => {
    const f = find({ ...WHATSAPP, TWILIO_WHATSAPP_FROM: "whatsapp:+44" }, "TWILIO_WHATSAPP_FROM");
    expect(f.status).toBe("missing");
    expect(f.says).not.toContain("whatsapp:+44");
  });
});

const VIDEO: ReadinessEnv = {
  ...GOOD,
  MEDIA_PROVIDER: "higgsfield",
  HIGGSFIELD_API_KEY: "hf-id",
  HIGGSFIELD_API_SECRET: "hf-secret",
};

describe("AI video (P6-03)", () => {
  it("higgsfield with a key and Blob is READY; the limits shown as numbers", () => {
    expect(status(VIDEO, "MEDIA_PROVIDER")).toBe("ready");
    expect(status(VIDEO, "HIGGSFIELD_API_KEY + HIGGSFIELD_API_SECRET")).toBe("ready");
    expect(
      status(
        { ...VIDEO, HIGGSFIELD_API_SECRET: "", HIGGSFIELD_API_KEY: "id:secret" },
        "HIGGSFIELD_API_KEY + HIGGSFIELD_API_SECRET",
      ),
    ).toBe("ready");
    const limits = find(VIDEO, "HIGGSFIELD_MONTHLY_CAP_MINOR, MODEL, USD_MICROS_PER_SECOND");
    expect(limits.status).toBe("ready");
    expect(limits.says).toContain("$60.00 a month (the default)");
    expect(limits.says).toContain("$0.112 a second");
    expect(limits.says).toContain("about $1.68");
    expect(status(VIDEO, "BLOB_READ_WRITE_TOKEN, for video")).toBe("ready");
  });

  it("unset is OFF; a key without higgsfield, higgsfield without a key, or no Blob is MISSING", () => {
    expect(status(GOOD, "MEDIA_PROVIDER")).toBe("off");
    expect(status(GOOD, "HIGGSFIELD_API_KEY + HIGGSFIELD_API_SECRET")).toBe("off");
    expect(status(GOOD, "BLOB_READ_WRITE_TOKEN, for video")).toBe("off");
    expect(status({ ...VIDEO, MEDIA_PROVIDER: "" }, "MEDIA_PROVIDER")).toBe("missing");
    expect(
      status(
        { ...VIDEO, HIGGSFIELD_API_KEY: "", HIGGSFIELD_API_SECRET: "" },
        "HIGGSFIELD_API_KEY + HIGGSFIELD_API_SECRET",
      ),
    ).toBe("missing");
    const half = find(
      { ...VIDEO, HIGGSFIELD_API_SECRET: "" },
      "HIGGSFIELD_API_KEY + HIGGSFIELD_API_SECRET",
    );
    expect(half.status).toBe("missing");
    expect(half.says).toContain("HIGGSFIELD_API_SECRET");
    expect(
      status({ ...VIDEO, BLOB_READ_WRITE_TOKEN: "" }, "BLOB_READ_WRITE_TOKEN, for video"),
    ).toBe("missing");
  });

  it("fake is refused in production (MISSING) and only CHECK in development; vendor is MISSING", () => {
    expect(
      status({ ...VIDEO, MEDIA_PROVIDER: "fake", NODE_ENV: "production" }, "MEDIA_PROVIDER"),
    ).toBe("missing");
    expect(
      status({ ...VIDEO, MEDIA_PROVIDER: "fake", NODE_ENV: "development" }, "MEDIA_PROVIDER"),
    ).toBe("check");
    expect(status({ ...VIDEO, MEDIA_PROVIDER: "vendor" }, "MEDIA_PROVIDER")).toBe("missing");
  });

  it("an unusable cap, model or price is CHECK, the default applies, and the raw text isn't echoed", () => {
    const name = "HIGGSFIELD_MONTHLY_CAP_MINOR, MODEL, USD_MICROS_PER_SECOND";
    const odd = find(
      { ...VIDEO, HIGGSFIELD_MONTHLY_CAP_MINOR: "sixty", HIGGSFIELD_MODEL: "Not A Model" },
      name,
    );
    expect(odd.status).toBe("check");
    expect(odd.says).toContain("HIGGSFIELD_MONTHLY_CAP_MINOR and HIGGSFIELD_MODEL");
    expect(odd.says).not.toContain("sixty");
    expect(odd.says).not.toContain("Not A Model");
    expect(find({ ...VIDEO, HIGGSFIELD_MONTHLY_CAP_MINOR: "12000" }, name).says).toContain(
      "$120.00 a month,",
    );
  });
});

const ADS: ReadinessEnv = {
  ...GOOD,
  GOOGLE_ADS_ACCESS_LEVEL: "explorer",
  GOOGLE_ADS_CLIENT_ID: "ads-id",
  GOOGLE_ADS_CLIENT_SECRET: "ads-secret",
};

describe("Google Ads (P2-20 / P3-22)", () => {
  it("its own client and a level is READY; the callback to register is shown", () => {
    expect(status(ADS, "GOOGLE_ADS_ACCESS_LEVEL")).toBe("ready");
    expect(find(ADS, "GOOGLE_ADS_ACCESS_LEVEL").says).toContain("2,880");
    expect(find(ADS, "GOOGLE_ADS_CLIENT_ID + SECRET").says).toContain("its own OAuth client");
    const redirect = find(ADS, "GOOGLE_ADS_REDIRECT_URI");
    expect(redirect.status).toBe("ready");
    expect(redirect.paste).toEqual(["https://app.syb.example/api/connections/google-ads/callback"]);
    expect(status(ADS, "GOOGLE_ADS_DEVELOPER_TOKEN + LOGIN_CUSTOMER_ID")).toBe("ready");
  });

  it("the shared sign-in client counts, as googleAdsEnv reads it", () => {
    const shared = {
      ...GOOD,
      GOOGLE_ADS_ACCESS_LEVEL: "basic",
      GOOGLE_CLIENT_ID: "g",
      GOOGLE_CLIENT_SECRET: "s",
    };
    const c = find(shared, "GOOGLE_ADS_CLIENT_ID + SECRET");
    expect(c.status).toBe("ready");
    expect(c.says).toContain("Google sign-in client");
  });

  it("test access is CHECK: test accounts only", () => {
    const t = find({ ...ADS, GOOGLE_ADS_ACCESS_LEVEL: "test" }, "GOOGLE_ADS_ACCESS_LEVEL");
    expect(t.status).toBe("check");
    expect(t.says).toContain("test accounts only");
  });

  it("nothing set is OFF; a level without a client, half its own client or an unknown level is MISSING", () => {
    expect(status(GOOD, "GOOGLE_ADS_ACCESS_LEVEL")).toBe("off");
    expect(status(GOOD, "GOOGLE_ADS_CLIENT_ID + SECRET")).toBe("off");
    expect(status(GOOD, "GOOGLE_ADS_REDIRECT_URI")).toBe("off");
    expect(
      status({ ...GOOD, GOOGLE_ADS_ACCESS_LEVEL: "explorer" }, "GOOGLE_ADS_CLIENT_ID + SECRET"),
    ).toBe("missing");
    const half = find({ ...ADS, GOOGLE_ADS_CLIENT_SECRET: "" }, "GOOGLE_ADS_CLIENT_ID + SECRET");
    expect(half.status).toBe("missing");
    expect(half.says).toContain("GOOGLE_ADS_CLIENT_SECRET is missing");
    const odd = find({ ...ADS, GOOGLE_ADS_ACCESS_LEVEL: "premium" }, "GOOGLE_ADS_ACCESS_LEVEL");
    expect(odd.status).toBe("missing");
    expect(odd.says).not.toContain("premium");
    expect(status({ ...ADS, GOOGLE_ADS_ACCESS_LEVEL: "" }, "GOOGLE_ADS_ACCESS_LEVEL")).toBe(
      "missing",
    );
  });

  it("a redirect that isn't APP_URL + the callback is MISSING; a bad login customer id is CHECK", () => {
    expect(
      status(
        { ...ADS, GOOGLE_ADS_REDIRECT_URI: "https://elsewhere.example/cb" },
        "GOOGLE_ADS_REDIRECT_URI",
      ),
    ).toBe("missing");
    const extras = find(
      { ...ADS, GOOGLE_ADS_LOGIN_CUSTOMER_ID: "12345" },
      "GOOGLE_ADS_DEVELOPER_TOKEN + LOGIN_CUSTOMER_ID",
    );
    expect(extras.status).toBe("check");
    expect(extras.says).not.toContain("12345");
    expect(
      find(
        { ...ADS, GOOGLE_ADS_LOGIN_CUSTOMER_ID: "123-456-7890" },
        "GOOGLE_ADS_DEVELOPER_TOKEN + LOGIN_CUSTOMER_ID",
      ).says,
    ).toContain("manager account");
  });
});

const TIKTOK: ReadinessEnv = {
  ...GOOD,
  TIKTOK_CLIENT_KEY: "tt-key",
  TIKTOK_CLIENT_SECRET: "tt-secret",
  TIKTOK_REDIRECT_URI: "https://app.syb.example/api/connections/tiktok-posting/callback",
  TIKTOK_AUDIT_STATUS: "unaudited",
};

describe("TikTok posting", () => {
  it("both keys and the matching redirect is READY; unaudited is READY and says posts are private", () => {
    expect(status(TIKTOK, "TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET")).toBe("ready");
    expect(status(TIKTOK, "TIKTOK_REDIRECT_URI")).toBe("ready");
    const audit = find(TIKTOK, "TIKTOK_AUDIT_STATUS");
    expect(audit.status).toBe("ready");
    expect(audit.says).toContain("private");
  });

  it("neither key is OFF; one is MISSING and named; an unset redirect is CHECK; a wrong one MISSING", () => {
    expect(status(GOOD, "TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET")).toBe("off");
    expect(status(GOOD, "TIKTOK_REDIRECT_URI")).toBe("off");
    const half = find(
      { ...TIKTOK, TIKTOK_CLIENT_SECRET: "" },
      "TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET",
    );
    expect(half.status).toBe("missing");
    expect(half.says).toContain("Only TIKTOK_CLIENT_KEY is set");
    const unset = find({ ...TIKTOK, TIKTOK_REDIRECT_URI: "" }, "TIKTOK_REDIRECT_URI");
    expect(unset.status).toBe("check");
    expect(unset.paste).toEqual([
      "https://app.syb.example/api/connections/tiktok-posting/callback",
    ]);
    expect(
      status(
        { ...TIKTOK, TIKTOK_REDIRECT_URI: "https://elsewhere.example/cb" },
        "TIKTOK_REDIRECT_URI",
      ),
    ).toBe("missing");
  });

  it("audited is CHECK; anything else reads as unaudited", () => {
    expect(status({ ...TIKTOK, TIKTOK_AUDIT_STATUS: "audited" }, "TIKTOK_AUDIT_STATUS")).toBe(
      "check",
    );
    const odd = find({ ...TIKTOK, TIKTOK_AUDIT_STATUS: "yes" }, "TIKTOK_AUDIT_STATUS");
    expect(odd.status).toBe("ready");
    expect(odd.says).toContain("reads as unaudited");
  });
});

const TIKTOK_ADS: ReadinessEnv = {
  ...GOOD,
  TIKTOK_ADS_APP_ID: "tta-id",
  TIKTOK_ADS_SECRET: "tta-secret",
  TIKTOK_ADS_REDIRECT_URI: "https://app.syb.example/api/connections/tiktok/callback",
};

describe("TikTok Ads", () => {
  it("all three set is READY; the app review is CHECK, since it can't be seen from here", () => {
    expect(status(TIKTOK_ADS, "TIKTOK_ADS_APP_ID + TIKTOK_ADS_SECRET")).toBe("ready");
    expect(status(TIKTOK_ADS, "TIKTOK_ADS_REDIRECT_URI")).toBe("ready");
    const review = find(TIKTOK_ADS, "TikTok app review");
    expect(review.status).toBe("check");
    expect(review.says).toContain("2 to 3 business days");
  });

  it("none set is OFF; the redirect is never derived, so unset beside the keys is MISSING", () => {
    expect(status(GOOD, "TIKTOK_ADS_APP_ID + TIKTOK_ADS_SECRET")).toBe("off");
    expect(status(GOOD, "TIKTOK_ADS_REDIRECT_URI")).toBe("off");
    expect(status(GOOD, "TikTok app review")).toBe("off");
    const unset = find({ ...TIKTOK_ADS, TIKTOK_ADS_REDIRECT_URI: "" }, "TIKTOK_ADS_REDIRECT_URI");
    expect(unset.status).toBe("missing");
    expect(unset.paste).toEqual(["https://app.syb.example/api/connections/tiktok/callback"]);
    expect(
      status({ ...TIKTOK_ADS, TIKTOK_ADS_SECRET: "" }, "TIKTOK_ADS_APP_ID + TIKTOK_ADS_SECRET"),
    ).toBe("missing");
    expect(
      status(
        {
          ...GOOD,
          TIKTOK_ADS_REDIRECT_URI: "https://app.syb.example/api/connections/tiktok/callback",
        },
        "TIKTOK_ADS_APP_ID + TIKTOK_ADS_SECRET",
      ),
    ).toBe("missing");
  });
});

describe("languages", () => {
  it("empty is READY: every language live, each named", () => {
    const l = find(GOOD, "LANGUAGES_IN_REVIEW");
    expect(l.status).toBe("ready");
    expect(l.says).toContain("every language is live");
    expect(l.says).toContain("Magyar (hu-HU)");
  });

  it("languages sent back are CHECK and named; unknown entries and English are counted, never echoed", () => {
    const back = find({ ...GOOD, LANGUAGES_IN_REVIEW: "ru-RU, zh-Hans" }, "LANGUAGES_IN_REVIEW");
    expect(back.status).toBe("check");
    expect(back.says).toContain("Русский (ru-RU) and 简体中文 (zh-Hans) are sent back to review");
    const odd = find({ ...GOOD, LANGUAGES_IN_REVIEW: "en,klingon" }, "LANGUAGES_IN_REVIEW");
    expect(odd.status).toBe("check");
    expect(odd.says).toContain("2 entries aren't");
    expect(odd.says).toContain("English can't be");
    expect(odd.says).not.toContain("klingon");
  });
});

describe("the panel and the feature agree", () => {
  it("the callback paths are the features' own", async () => {
    // These modules open the database lazily; the pool needs a URL to be built, not a server.
    process.env.DATABASE_URL ??= "postgresql://unused@localhost:5432/unused";
    const line = await import("../phone/line");
    const gads = await import("../google-ads/login");
    const posting = await import("../execution/tiktok-posting");
    const ttAds = await import("../tiktok/login");
    expect(PHONE_VOICE_PATH).toBe(line.VOICE_PATH);
    expect(PHONE_STATUS_PATH).toBe(line.stepUrl("status"));
    expect(PHONE_RECORDING_PATH).toBe(line.RECORDING_PATH);
    expect(GOOGLE_ADS_CALLBACK_PATH).toBe(gads.GADS_CALLBACK_PATH);
    expect(TIKTOK_POSTING_CALLBACK_PATH).toBe(posting.TIKTOK_CALLBACK_PATH);
    expect(TIKTOK_ADS_CALLBACK_PATH).toBe(ttAds.TIKTOK_CALLBACK_PATH);
  });

  it("recording needs is recordingMissing() as production reads it", async () => {
    process.env.DATABASE_URL ??= "postgresql://unused@localhost:5432/unused";
    const { recordingMissing } = await import("../phone-recording/recordings");
    const keys = [
      "NODE_ENV",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_PHONE_NUMBER",
      "BLOB_READ_WRITE_TOKEN",
      "CONNECTOR_KEY",
    ] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const env of [
        PHONE,
        { ...PHONE, BLOB_READ_WRITE_TOKEN: "" },
        { ...PHONE, CONNECTOR_KEY: "short", TWILIO_PHONE_NUMBER: "" },
        { ...GOOD, TWILIO_PHONE_NUMBER: "+447700900123" },
      ]) {
        for (const k of keys) {
          const v = k === "NODE_ENV" ? "production" : env[k];
          if (v === undefined || v === "") delete process.env[k];
          else Object.assign(process.env, { [k]: v });
        }
        const feature = recordingMissing();
        const panel = find(env, "recording needs");
        expect(panel.status === "ready", JSON.stringify(feature)).toBe(feature.length === 0);
        for (const k of feature) expect(panel.says).toContain(k);
      }
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else Object.assign(process.env, { [k]: saved[k] });
      }
    }
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
    ).toContain("15 000 Ft"); // whole forints — the multi-market spec §A.2
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
    expect(fromDomain("ScaleX <Hello@Mail.Example.COM>")).toBe("mail.example.com");
    expect(fromDomain("hello@example.com")).toBe("example.com");
    expect(fromDomain("ScaleX")).toBeNull();
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

  it("usdMicros shows millionths of a dollar without a float", () => {
    expect(usdMicros(112_000)).toBe("$0.112");
    expect(usdMicros(1_680_000)).toBe("$1.68");
    expect(usdMicros(2_000_000)).toBe("$2.00");
    expect(usdMicros(5)).toBe("$0.000005");
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
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "HIGGSFIELD_API_KEY",
    "HIGGSFIELD_API_SECRET",
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "TIKTOK_CLIENT_KEY",
    "TIKTOK_CLIENT_SECRET",
    "TIKTOK_ADS_APP_ID",
    "TIKTOK_ADS_SECRET",
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
      EMAIL_FROM: "ScaleX <hello@syb.example>",
      CAMPAIGN_EMAIL_FROM: "ScaleX <hello@campaigns.syb.example>",
      SUPPORT_INBOUND_DOMAIN: "inbound.syb.example",
      // Non-secret settings holding a secret by mistake must not echo it either.
      INTERVIEWER_MODE: token("INTERVIEWERMODE"),
      META_ACCESS_LEVEL: token("METAACCESSLEVEL"),
      META_OAUTH_REDIRECT_URI: `https://evil.example/${token("METAOAUTHREDIRECT")}`,
      SESSION_D_REAL_WRITES: token("SESSIONDREALWRITES"),
      REPORT_PRICE_MINOR: token("REPORTPRICEMINOR"),
      REPORT_CURRENCY: token("REPORTCURRENCY"),
      TWILIO_PHONE_NUMBER: token("TWILIOPHONENUMBER"),
      TWILIO_WHATSAPP_FROM: token("TWILIOWHATSAPPFROM"),
      TWILIO_WHATSAPP_SUMMARY_TEMPLATES: JSON.stringify({ en: token("TWILIOTEMPLATES") }),
      PHONE_RECORDING_KEEP_DAYS: token("PHONERECORDINGKEEPDAYS"),
      MEDIA_PROVIDER: token("MEDIAPROVIDER"),
      HIGGSFIELD_MONTHLY_CAP_MINOR: token("HIGGSFIELDCAP"),
      HIGGSFIELD_MODEL: `kling/${token("HIGGSFIELDMODEL")}`,
      HIGGSFIELD_USD_MICROS_PER_SECOND: token("HIGGSFIELDPRICE"),
      GOOGLE_ADS_ACCESS_LEVEL: token("GOOGLEADSACCESSLEVEL"),
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: token("GOOGLEADSLOGIN"),
      GOOGLE_ADS_REDIRECT_URI: `https://evil.example/${token("GOOGLEADSREDIRECT")}`,
      TIKTOK_REDIRECT_URI: `https://evil.example/${token("TIKTOKREDIRECT")}`,
      TIKTOK_ADS_REDIRECT_URI: `https://evil.example/${token("TIKTOKADSREDIRECT")}`,
      TIKTOK_AUDIT_STATUS: token("TIKTOKAUDITSTATUS"),
      LANGUAGES_IN_REVIEW: `ru-RU,${token("LANGUAGESINREVIEW")}`,
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

  it("with the new features' secrets in shapes their checks accept, so the READY paths run too", () => {
    // A Twilio account id must be AC + 32 hex, a template id HX + 32 hex: a
    // digest's hex is the sentinel there, and no 6-character piece may show.
    const hex = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
    const sid = hex("TWILIO_ACCOUNT_SID");
    const tpl = hex("TEMPLATE");
    const env: Record<string, string> = {
      ...sentinelEnv(),
      TWILIO_ACCOUNT_SID: `AC${sid}`,
      TWILIO_PHONE_NUMBER: "+447700900123",
      TWILIO_WHATSAPP_FROM: "+447700900456",
      TWILIO_WHATSAPP_SUMMARY_TEMPLATES: JSON.stringify({
        en: `HX${tpl}`,
        [token("TEMPLATEKEY")]: `HX${tpl}`,
      }),
      MEDIA_PROVIDER: "higgsfield",
      HIGGSFIELD_API_KEY: `${token("HFID")}:${token("HFSECRET")}`,
      HIGGSFIELD_MODEL: "kling-video/v9/custom-secretish-model",
      GOOGLE_ADS_ACCESS_LEVEL: "explorer",
      LANGUAGES_IN_REVIEW: `ru-RU,${token("LANGUAGESINREVIEW")}`,
    };
    delete env.HIGGSFIELD_API_SECRET;
    const report = launchReadiness(env, FACTS);
    const out = JSON.stringify(report);
    const all = report.groups.flatMap((g) => g.items);
    expect(all.find((i) => i.name === "TWILIO_ACCOUNT_SID")!.status).toBe("ready");
    expect(all.find((i) => i.name === "TWILIO_WHATSAPP_SUMMARY_TEMPLATES")!.status).toBe("ready");
    expect(all.find((i) => i.name === "HIGGSFIELD_API_KEY + HIGGSFIELD_API_SECRET")!.status).toBe(
      "ready",
    );
    for (const w of windows(sid)) expect(out, `sid: "${w}"`).not.toContain(w);
    for (const w of windows(tpl)) expect(out, `template: "${w}"`).not.toContain(w);
    expect(out).not.toContain("custom-secretish-model");
    expect(out).not.toContain("SENTINEL");
    // The two numbers are the facts the panel is allowed to show.
    expect(out).toContain("+447700900123");
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
