// L-3d: the connections catalogue says in English exactly what the
// registries and the setup say — the scope guide, the connect forms, the
// write-access setup, the sign-in reasons and the notes — so moving the
// screen's words to messages/*.json changed no English, and every registry
// line has its words for the other languages. Then a few lines in German,
// French and Chinese, with figures and dates in their writing.

// lib/execution/engine and the Shopify provider read the environment as they load.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_FIELDS } from "../../lib/connectors/credentials";
import { SHOPIFY_DEFAULT_HISTORY_DAYS } from "../../lib/connectors/providers/shopify";
import { PROVIDER_IDS, SCOPE_GUIDE } from "../../lib/connectors/scopes";
import { realWritesOffSentence } from "../../lib/execution/engine";
import {
  EMAIL_DISCONNECT_NOTE,
  EMAIL_NOTHING_SENT,
  sharedSenderNote,
} from "../../lib/execution/email-consent";
import { CONNECTIONS_GENERIC, CONNECTIONS_REASONS } from "../../lib/execution/meta-login-reasons";
import { EXECUTION_SCOPE_REGISTRY } from "../../lib/execution/scopes";
import {
  ADS_ACCESS_TIER_NOTE,
  DISCONNECT_NOTE,
  EXECUTION_SETUP,
  FACEBOOK_LOGIN_OFF,
  NOTHING_SENT_YET,
  OFFERED_EXECUTION,
  ONE_CONSENT_PER_FACEBOOK_ACCOUNT,
  TESTER_NOTE,
  accessLevelCopy,
  accessTierWords,
} from "../../lib/execution/setup";
import { GOOGLE_GENERIC, GOOGLE_REASONS } from "../../lib/google-business/reasons";
import {
  GOOGLE_NEEDS,
  GOOGLE_NOTHING_WRITTEN,
  GOOGLE_REVOKE_NOTE,
} from "../../lib/google-business/words";
import type { AppLocale } from "../../lib/i18n/locales";
import { englishTr } from "../../lib/i18n/tr";
import type { Tr } from "../../lib/i18n/tr";
import { outcomeWords, skippedWords } from "./BankStatementSection";
import { gives, headline, lastRead } from "./patch";
import type { CnTr } from "./words";
import { GOOGLE_NEED_KEYS, SHOPIFY_DEFAULT_DAYS, givesText, guideKey, guideLine } from "./words";
import { accessWords, tierNote, tierWords } from "./write-words";

type Tree = { [key: string]: string | Tree };
const load = (l: AppLocale): Tree =>
  JSON.parse(readFileSync(join(process.cwd(), "messages", `${l}.json`), "utf8")) as Tree;

/** A CnTr over a namespace, as the screen's hook gives it, in any language. */
function cn(locale: AppLocale, namespace = "connections"): CnTr {
  const t = createTranslator({
    locale,
    messages: load(locale),
    namespace: namespace as "common",
  }) as unknown as CnTr & { rich: unknown; has: (k: string) => boolean };
  const tr = ((key: string, values?: Record<string, string | number>) =>
    (t as unknown as Tr)(key, values)) as CnTr;
  tr.has = (key) => t.has(key);
  tr.rich = () => null;
  return tr;
}

const en = cn("en");
const write = englishTr("connections.write");

describe("the scope guide, said from the catalogue", () => {
  it("repeats every registry line in English, word for word, for every provider", () => {
    expect(SHOPIFY_DEFAULT_DAYS).toBe(SHOPIFY_DEFAULT_HISTORY_DAYS);
    for (const id of PROVIDER_IDS) {
      SCOPE_GUIDE[id].forEach((g, i) => {
        const key = guideKey(id, i);
        expect(en.has(`${key}.why`), `${key}.why`).toBe(true);
        expect(guideLine(en, id, i, g), key).toEqual({ grant: g.grant, why: g.why });
        // A grant that is the scope's own code has no words to translate.
        expect(en.has(`${key}.grant`), `${key}.grant`).toBe(g.grant !== g.scope);
        expect(en(`${key}.gives`, { days: SHOPIFY_DEFAULT_DAYS }), key).toBe(gives([g]));
      });
      // …and no line the registry doesn't have.
      expect(en.has(guideKey(id, SCOPE_GUIDE[id].length)), id).toBe(false);
    }
  });

  it("names what a source gives as the registry does in English, and in the reader's words elsewhere", () => {
    for (const id of PROVIDER_IDS) {
      expect(givesText(en, id, SCOPE_GUIDE[id], "en")).toBe(gives(SCOPE_GUIDE[id]));
    }
    const de = givesText(cn("de-DE"), "shopify", SCOPE_GUIDE.shopify, "de-DE");
    expect(de).not.toBe(gives(SCOPE_GUIDE.shopify));
    expect(de).toContain("60");
    expect(de).not.toMatch(/Your orders/);
  });

  it("labels every connect form's field as the registry does, placeholders where they are words", () => {
    for (const id of PROVIDER_IDS) {
      for (const f of CREDENTIAL_FIELDS[id]) {
        const key = `field.${id}.${f.name}`;
        expect(en(`${key}.label`), key).toBe(f.label);
        if (en.has(`${key}.placeholder`)) expect(en(`${key}.placeholder`), key).toBe(f.placeholder);
      }
    }
  });
});

describe("write access, said from the catalogue", () => {
  const w = cn("en", "connections.write");

  it("repeats the setup's steps, fields, operations and names in English", () => {
    for (const id of OFFERED_EXECUTION) {
      const setup = EXECUTION_SETUP[id];
      const spec = EXECUTION_SCOPE_REGISTRY[id];
      expect(w(`label.${id}`), id).toBe(spec.label);
      setup?.own_app_steps.forEach((s, i) => expect(w(`ownAppSteps.${id}.s${i}`)).toBe(s));
      expect(w.has(`ownAppSteps.${id}.s${setup?.own_app_steps.length ?? 0}`)).toBe(false);
      for (const f of setup?.credential_fields ?? []) {
        expect(w(`field.${id}.${f.name}.label`)).toBe(f.label);
        expect(w(`field.${id}.${f.name}.placeholder`)).toBe(f.placeholder);
      }
      for (const o of spec.operations) expect(w(`op.${o.op}`), o.op).toBe(o.description);
    }
    expect(w("label.email_campaign")).toBe(EXECUTION_SCOPE_REGISTRY.email_campaign.label);
    expect(w("label.google_business_reviews")).toBe(
      EXECUTION_SCOPE_REGISTRY.google_business_reviews.label,
    );
  });

  it("says the access level, the tier and the notes as lib/execution/setup does", () => {
    for (const level of ["standard", "advanced"] as const) {
      for (const fb of [true, false]) {
        expect(accessWords(level, fb), `${level} ${fb}`).toEqual(accessLevelCopy(level, fb));
      }
    }
    for (const tier of [null, "development_access", "standard_access", "unknown_tier"]) {
      expect(tierWords(tier), String(tier)).toBe(accessTierWords(tier));
    }
    expect(tierNote()).toBe(ADS_ACCESS_TIER_NOTE);
    expect(write("facebook.testerNote")).toBe(TESTER_NOTE);
    expect(write("facebook.oneConsent")).toBe(ONE_CONSENT_PER_FACEBOOK_ACCOUNT);
    expect(write("facebookOff")).toBe(FACEBOOK_LOGIN_OFF);
    expect(write("nothingSent")).toBe(NOTHING_SENT_YET);
    expect(write("disconnectNote")).toBe(DISCONNECT_NOTE);
  });

  it("says every sign-in reason as the closed sets do, and their generic line", () => {
    for (const [code, line] of Object.entries(CONNECTIONS_REASONS)) {
      expect(write(`reason.${code}`), code).toBe(line);
    }
    expect(write("reason.generic")).toBe(CONNECTIONS_GENERIC);
    const google = englishTr("connections.google");
    for (const [code, line] of Object.entries(GOOGLE_REASONS)) {
      expect(google(`reason.${code}`), code).toBe(line);
    }
    expect(google("reason.generic")).toBe(GOOGLE_GENERIC);
  });

  it("says campaign email's and Google's notes as their modules do", () => {
    const email = englishTr("connections.email");
    expect(email("nothingSent")).toBe(EMAIL_NOTHING_SENT);
    expect(email("disconnectNote")).toBe(EMAIL_DISCONNECT_NOTE);
    expect(email("sharedSender")).toBe(sharedSenderNote(null));
    expect(email("label")).toBe(EXECUTION_SCOPE_REGISTRY.email_campaign.label);
    expect(email("realSendsOff", { label: email("label") })).toBe(
      realWritesOffSentence(EXECUTION_SCOPE_REGISTRY.email_campaign.label),
    );
    for (const o of EXECUTION_SCOPE_REGISTRY.email_campaign.operations) {
      expect(email(`op.${o.op}`)).toBe(o.description);
    }
    const google = englishTr("connections.google");
    expect(google("nothingWritten")).toBe(GOOGLE_NOTHING_WRITTEN);
    expect(google("revokeNote")).toBe(GOOGLE_REVOKE_NOTE);
    const needs = englishTr("reviews.google");
    GOOGLE_NEEDS.forEach((n, i) => expect(needs(`needs.${GOOGLE_NEED_KEYS[i] ?? ""}`)).toBe(n));
    expect(GOOGLE_NEED_KEYS.length).toBe(GOOGLE_NEEDS.length);
  });
});

describe("the bank statement's lines", () => {
  const outcome = {
    from: "2026-10-01",
    through: "2026-10-30",
    days: 30,
    rows_read: 1,
    skipped: { date_unreadable: 2, balance_unreadable: 0, day_unclear: 1 },
    latest: { day: "2026-10-30", amount_minor: 842_055, currency: "EUR" },
  };

  it("keeps the English it always printed", () => {
    expect(skippedWords(outcome.skipped)).toBe(
      "Left out, never guessed: 2 with a date I couldn't read, 1 from a day whose rows disagree.",
    );
    expect(skippedWords({ date_unreadable: 0, balance_unreadable: 0, day_unclear: 0 })).toBeNull();
    expect(outcomeWords(outcome, englishTr("connections.bank"), "en")).toBe(
      "Read 1 row: a closing balance for each of 30 days, 1 Oct 2026 to 30 Oct 2026, ending at €8,420.55.",
    );
  });

  it("writes money and dates the reader's way, in the statement's own currency", () => {
    const de = outcomeWords(outcome, cn("de-DE", "connections.bank"), "de-DE");
    expect(de).toContain("8.420,55");
    expect(de).toContain("€");
    expect(de).toContain("Okt.");
  });
});

describe("the patch panel in another language", () => {
  it("counts in the reader's words, and names a write connection's labels in their list", () => {
    const de = cn("de-DE");
    const line = headline(
      [{ status: "connected" }, { status: "connected" }],
      [
        { status: "connected", label: "A" },
        { status: "connected", label: "B" },
      ],
      de,
      "de-DE",
    );
    expect(line).toContain("2");
    expect(line).toContain("A und B");
    expect(line).not.toMatch(/sources read/);
    const zh = headline([{ status: "connected" }], [], cn("zh-Hans"), "zh-Hans");
    expect(zh).not.toMatch(/ /);
  });

  it("writes the last read the reader's way", () => {
    const at = "2026-10-17T12:00:00Z";
    expect(lastRead("2026-10-09 12:00:00+00", Date.parse(at), "fr-FR")).toMatch(/9 oct\./);
    expect(lastRead("2026-10-09 12:00:00+00", Date.parse(at))).toBe("9 Oct");
  });
});
