// L-4a of TASKS-LANGUAGES.md: the sentences SYB builds from data, in every
// language. English is held to the code's own words (byte for byte); a few
// sentences are checked in German, Russian (its plural forms) and Chinese.
// (lib/anomaly/detect and lib/connectors/activity import the database
// client; nothing here queries it.)

import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvalNote,
  changeLines,
  durationWord,
  effectSpan,
  sendingWords,
} from "../../components/proposals/queue-model";
import {
  arithmeticWords,
  factRow,
  proposalRows,
  rateArithmetic,
} from "../../components/trust/ledger";
import { CREATES_PAUSED_NOTE } from "../ads/ad-words";
import { describeRun } from "../anomaly/detect";
import { thresholdTexts } from "../anomaly/thresholds";
import { authErrorWords } from "../auth/error-words";
import { ROLE_ACTION_KEYS, englishRefusal, refusalFor } from "../auth/role-actions";
import { languageOf, requireRole } from "../auth/roles";
import type { AuthedSession } from "../auth/service";
import { activityDetail } from "../connectors/activity";
import { quietLine } from "../connectors/materiality";
import { computeEconomics } from "../economics/unit-economics";
import { econText } from "../economics/words";
import { trackView } from "../forecasts/view";
import { coverageLine } from "../hours/coverage";
import { hoursLineWords } from "../hours/words";
import { gapBuys } from "../profile/factsheet";
import { gapBuysText, gapBuysWords } from "../profile/gap-words";
import type { SnapshotView } from "../profile/snapshot";
import { TEAM_WHY } from "../team/module";
import { approvalRate } from "../trust/scorecard";
import { findingWords } from "../validation/words";
import { SIGNAL_NOUN, WATCHED_METRICS } from "../watch/watch-view";
import { logWords, moduleWords, ruleWords, signalNoun, sourceWords } from "../watch/words";
import type { AppLocale } from "./locales";
import { trFor } from "./server-tr";
import { englishPatterns, matchStored, readStored, storedPattern } from "./stored";
import { englishTr } from "./tr";

// These hold the review gate itself. All six languages went live on
// 2026-11-08 (the owner's override), so the gate is tested the way the
// owner would use it: with LANGUAGES_IN_REVIEW sending them back.
const IN_REVIEW = "es-ES,de-DE,fr-FR,hu-HU,ru-RU,zh-Hans";
beforeAll(() => {
  process.env.LANGUAGES_IN_REVIEW = IN_REVIEW;
});
afterAll(() => {
  delete process.env.LANGUAGES_IN_REVIEW;
});

const w = (locale: AppLocale, ns: string) => ({ tr: trFor(locale, ns), locale });
/** Intl writes no-break spaces; the assertions read plain ones. */
const NBSP = new RegExp(`[${String.fromCharCode(0xa0, 0x202f)}]`, "g");
const sp = (s: string | null | undefined) => (s ?? "").replace(NBSP, " ");

describe("reading stored English back (lib/i18n/stored)", () => {
  it("turns a message's placeholders into captures, and refuses plurals", () => {
    expect(
      storedPattern("Read {days} days of {label} {data}.")?.test("Read 3 days of Stripe payments."),
    ).toBe(true);
    expect(storedPattern("{n, plural, one {# day} other {# days}}")).toBeNull();
    expect(
      matchStored("Watch extended to 6 weeks at the owner's request.", "watchWords.log"),
    ).toEqual({
      key: "extended",
      values: { weeks: "6" },
    });
  });

  it("prints anything it doesn't know as stored", () => {
    const tr = trFor("de-DE", "watchWords");
    expect(readStored("a line a model wrote", "watchWords.log", tr)).toBe("a line a model wrote");
    expect(logWords("a line a model wrote", w("de-DE", "watchWords"))).toBe("a line a model wrote");
  });

  it("has a readable pattern for every simple English message it reads back", () => {
    for (const ns of ["watchWords.log", "queueWords.sending", "authWords.error", "econWords.why"]) {
      expect(englishPatterns(ns).length, ns).toBeGreaterThan(3);
    }
  });
});

describe("role refusals (roleWords)", () => {
  it("says in English exactly what the role table composes", () => {
    for (const a of ROLE_ACTION_KEYS) expect(refusalFor(a), a).toBe(englishRefusal(a));
  });

  it("refuses in the person's own language, through the status gate", async () => {
    const session = (language: string | null): AuthedSession => ({
      account_id: "acc-1",
      user_id: "u-1",
      email: "rev@example.com",
      profile_id: null,
      role: "manager",
      language,
    });
    const before = process.env.LANGUAGE_REVIEW_ACCOUNTS;
    process.env.LANGUAGE_REVIEW_ACCOUNTS = "rev@example.com";
    try {
      expect(languageOf(session("de-DE"))).toBe("de-DE");
      const res = requireRole(session("de-DE"), "connections.manage");
      expect(((await res?.json()) as { error: string }).error).toBe(
        "Nur ein Inhaber kann Konten verbinden oder trennen.",
      );
      expect(languageOf(session(null))).toBe("en");
      process.env.LANGUAGE_REVIEW_ACCOUNTS = "";
      // A review language is English for anyone who isn't a named reviewer.
      expect(languageOf(session("de-DE"))).toBe("en");
    } finally {
      process.env.LANGUAGE_REVIEW_ACCOUNTS = before;
    }
  });
});

describe("sign-in refusals (authWords)", () => {
  it("leaves English as sent and reads the rest back with the provider's name kept", () => {
    const tr = trFor("de-DE", "authWords");
    const failed = "Google sign-in failed — try again or use the email link";
    expect(authErrorWords(failed, tr, "en")).toBe(failed);
    const de = authErrorWords(failed, tr, "de-DE");
    expect(de).not.toBe(failed);
    expect(de).toContain("Google");
    const why = "Apple sign-in couldn't be verified (wrong issuer) — use the email link instead";
    expect(authErrorWords(why, tr, "de-DE")).not.toContain("wrong issuer");
  });
});

const emptyView: SnapshotView = {
  summary: {
    id: "s",
    profile_id: "p",
    taken_at: "2026-11-01T00:00:00Z",
    content_hash: "",
    fact_count: 0,
    entity_count: 0,
    reason: "test",
  },
  facts: new Map(),
  entities: [],
};

describe("the economics' refusals and formulas (econWords)", () => {
  it("reads every refusal an empty profile gets in German", () => {
    const eco = computeEconomics(emptyView, "EUR");
    expect(eco.refusals.length).toBeGreaterThan(2);
    for (const r of eco.refusals) {
      expect(econText(r.why, "why", w("de-DE", "econWords")), r.why).not.toBe(r.why);
      expect(econText(r.what, "what", w("de-DE", "econWords")), r.what).not.toBe(r.what);
      // English is what the engine wrote.
      expect(econText(r.why, "why"), r.why).toBe(r.why);
    }
  });

  it("formats a formula's own figures the reader's way", () => {
    const de = econText(
      "(price − cost_to_deliver) ÷ price × 100",
      "formula",
      w("de-DE", "econWords"),
    );
    expect(de).toContain("100");
    expect(de).not.toContain("price");
    expect(englishTr("econWords")("live.label")).toBe("Blended margin");
  });
});

describe("the report's lines (reportWords)", () => {
  it("says what answering buys as factsheet.gapBuys does, then in other languages", () => {
    for (const priority of ["core", "important", "deep", "optional"] as const) {
      for (const n of [0, 1, 3]) {
        const english = gapBuys({
          priority,
          unlocks: Array.from({ length: n }, (_, i) => `q${i}`),
        } as never);
        expect(gapBuysText(priority, n), `${priority} ${n}`).toBe(english);
        const de = gapBuysWords(english, priority, trFor("de-DE", "reportWords"), "de-DE");
        expect(de, `${priority} ${n}`).not.toBe(english);
      }
    }
  });

  it("counts the quiet line in Russian and Chinese", () => {
    const quiet = [{ reason: "within_relative" as const }];
    const ru = quietLine(quiet, 5, trFor("ru-RU", "reportWords"), "ru-RU");
    expect(ru).toMatch(/1/);
    expect(ru).toMatch(/5/);
    expect(ru).toMatch(/15/);
    const zh = quietLine([...quiet, ...quiet], 2, trFor("zh-Hans", "reportWords"), "zh-Hans");
    expect(zh).toMatch(/[一-鿿]/);
  });
});

describe("validation findings (validationWords)", () => {
  it("re-says a finding from its stored figures, money in its own currency", () => {
    const tr = trFor("de-DE", "validationWords");
    const de = findingWords(
      "revenue_vs_offers",
      {
        en: "You told me revenue is about 4,000 EUR a month. …",
        args: {
          stated: { amount_minor: 400_000, currency: "EUR" },
          sum: { amount_minor: 612_300, currency: "EUR" },
        },
      },
      tr,
      "de-DE",
    );
    expect(sp(de)).toContain("4.000 €");
    expect(sp(de)).toContain("6.123 €");
    expect(findingWords("stale_financials", { en: "x" }, tr, "de-DE")).toBe("x");
    expect(findingWords("margin_mismatch", { en: "English as stored" }, tr, "en")).toBe(
      "English as stored",
    );
  });

  it("agrees a Russian count of days", () => {
    const tr = trFor("ru-RU", "validationWords");
    const days = (n: number) =>
      findingWords("stale_financials", { en: "", args: { days: n } }, tr, "ru-RU");
    expect(days(91)).toContain("91 день");
    expect(days(92)).toContain("92 дня");
    expect(days(95)).toContain("95 дней");
  });
});

describe("trading-hours lines (hoursWords)", () => {
  it("reads every coverage line coverageLine writes", () => {
    const tr = trFor("fr-FR", "hoursWords");
    for (const p of [["square"], ["square", "stripe"], ["stripe", "shopify"]]) {
      const english = coverageLine(p);
      const fr = hoursLineWords(english, tr, "fr-FR");
      expect(fr, english).not.toBe(english);
      expect(hoursLineWords(english, tr, "en")).toBe(english);
    }
  });
});

describe("the watch (watchWords)", () => {
  const de = w("de-DE", "watchWords");
  const zh = w("zh-Hans", "watchWords");

  it("names every signal as SIGNAL_NOUN does in English", () => {
    for (const m of WATCHED_METRICS) {
      expect(englishTr("watchWords")(`signal.${m.replace(/\.daily$/, "")}`), m).toBe(
        SIGNAL_NOUN[m],
      );
      expect(signalNoun(m, SIGNAL_NOUN[m], de), m).not.toBe(SIGNAL_NOUN[m]);
    }
    expect(sourceWords("Bookings export", de)).not.toBe("Bookings export");
    expect(sourceWords("Stripe", de)).toBe("Stripe");
  });

  it("reads the rules and the module explanations back", () => {
    for (const r of thresholdTexts()) expect(ruleWords(r.text, de), r.text).not.toBe(r.text);
    expect(englishTr("watchWords")("module.team")).toBe(TEAM_WHY);
    expect(moduleWords(TEAM_WHY, de)).not.toBe(TEAM_WHY);
  });

  it("reads the log lines ScaleX writes from numbers", () => {
    const sync = activityDetail("Stripe", "stripe", 3, [
      { field_key: "revenue.monthly_revenue", outcome: "written" },
      { field_key: "revenue.order_count_monthly", outcome: "written" },
    ] as never);
    expect(sync).not.toBeNull();
    const deSync = logWords(sync!, de);
    expect(deSync).not.toBe(sync);
    expect(deSync).toContain("Stripe");
    // A provider's name with a space in it stays whole.
    const ga = logWords("Read 22 days of Google Analytics traffic.", de);
    expect(ga).toContain("Google Analytics");
    expect(ga).not.toContain("traffic");
    expect(logWords("Read 22 days of Meta Ads ad spend.", de)).toContain("Meta Ads");

    const run = describeRun(
      "revenue.daily",
      "EUR",
      {
        direction: "drop",
        days: [
          {
            date: "2026-10-30",
            actual: 123_450,
            pct: -0.32,
            deviation: -4.2,
            baseline: {
              weekday: 5,
              expected: 180_000,
              overall_mean: 170_000,
              weekday_factor: 1.06,
            },
          },
        ],
      } as never,
      { change: null } as never,
      null,
    );
    const deRun = logWords(run, de);
    expect(deRun).not.toBe(run);
    expect(deRun).toContain("Umsatz (EUR)");
    expect(sp(deRun)).toContain("1.234,50 €");
    expect(deRun).toContain("Freitag");

    const zhStarted = logWords("Started watching: 4 weeks, reviewing 2026-11-30.", zh);
    expect(zhStarted).toMatch(/[一-鿿]/);
    expect(zhStarted).toContain("2026");
    expect(logWords("Weekly snapshot: 3 changed, 1 new since last week.", de)).not.toContain(
      "changed",
    );
  });
});

describe("the queue (queueWords)", () => {
  it("keeps the ad card's fixed sentence the ad words file writes", () => {
    expect(englishTr("queueWords")("fact.createsPaused")).toBe(CREATES_PAUSED_NOTE);
  });

  it("writes the change, the span and the review time in German and Russian", () => {
    const pause = {
      summary: "Pause",
      detail: {
        change: "pause",
        campaign_name: "Autumn",
        spend_minor: 21_000,
        measured_days: 7,
        currency: "EUR",
      },
    };
    const de = changeLines(pause, "UTC", w("de-DE", "queueWords"));
    expect(sp(de?.[0]?.before)).toContain("30 €");
    expect(de?.[0]?.line).toContain("Autumn");
    const run = (days: number) => ({
      summary: "Ad",
      detail: {
        change: "go_live",
        budget: { daily_minor: 1000, currency: "EUR", run_days: days, total_minor: 1000 * days },
      },
    });
    const ru = (n: number) => effectSpan(run(n), w("ru-RU", "queueWords"));
    expect(ru(1)).toContain("1 день");
    expect(ru(3)).toContain("3 дня");
    expect(ru(7)).toContain("7 дней");
    expect(effectSpan(run(7))).toBe("over 7 days");
    expect(durationWord(160_000)).toBe("2 m 40 s");
    expect(durationWord(160_000, w("de-DE", "queueWords"))).not.toBe("2 m 40 s");
  });

  it("reads a proposal's own sending sentence back, and every one is a sentence lib/ writes", () => {
    const sources = libSources();
    const en = englishTr("queueWords");
    for (const [key, english] of englishPatterns("queueWords.sending")) {
      if (english.includes("{")) continue;
      expect(
        sources.some((s) => s.includes(JSON.stringify(english).slice(1, -1))),
        key,
      ).toBe(true);
      expect(sendingWords(english, w("fr-FR", "queueWords")), key).not.toBe(english);
      expect(en(`sending.${key}`)).toBe(english);
    }
    const note = approvalNote({
      runAt: null,
      sending: en("sending.stockPrices"),
      tr: trFor("zh-Hans", "proposals"),
      locale: "zh-Hans",
      qw: w("zh-Hans", "queueWords"),
    });
    expect(note).not.toContain("Approving records");
  });
});

describe("the ledger and the track record (ledgerWords, trackWords)", () => {
  it("spells the approval rate as the scorecard does", () => {
    for (const c of [
      { blocked: 1, pending: 0, approved: 2, rejected: 1, expired: 1, executed: 1 },
      { blocked: 0, pending: 3, approved: 0, rejected: 0, expired: 0, executed: 0 },
    ]) {
      const r = approvalRate(c);
      expect(rateArithmetic({ ...c, approval_rate: r.approval_rate })).toBe(r.arithmetic);
      expect(
        rateArithmetic({ ...c, approval_rate: r.approval_rate }, w("de-DE", "ledgerWords")),
      ).not.toBe(r.arithmetic);
    }
  });

  it("writes the ledger's own words in German, the proposal's title as stored", () => {
    const de = w("de-DE", "ledgerWords");
    const rows = proposalRows(
      {
        id: "11111111-2222",
        status: "pending",
        module: "ads",
        created_at: "2026-10-30T10:00:00Z",
        decided_at: null,
        rejection_reason: null,
        blocked_by_limit: null,
        action: { summary: "Pause the autumn campaign" },
      },
      null,
      Date.parse("2026-11-01T00:00:00Z"),
      de,
    );
    expect(rows[0]?.title).toBe("Pause the autumn campaign");
    expect(rows[0]?.note).not.toBe("waiting for you");
    const fact = factRow(
      {
        id: "abcdef12-0000",
        key: "k",
        label: "Preis",
        from: "10",
        to: "12",
        at: "2026-10-30T10:00:00Z",
        by: "owner_input",
      },
      de,
    );
    expect(fact.title).toContain("Preis");
    expect(fact.note).not.toBe("kept in record");
    const arith =
      "daily revenue averaged 120.00 EUR over the 7 measured day(s) after 2026-10-01, against 100.00 EUR over the 28 before — +20% (thresholds: helped at +5%, backfired at -5%)";
    const deArith = arithmeticWords(arith, de);
    expect(sp(deArith)).toContain("120,00 €");
    expect(deArith).not.toContain("daily revenue");
  });

  it("gives Russian its counting forms on the track record", () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `f${i}`,
        kind: "stock_out",
        made_at: "2026-10-01",
        recorded_at: "2026-10-01",
        subject: "Glaze",
        subject_ref: null,
        unit: "date",
        window_start: "2026-10-01",
        window_end: "2026-12-30",
        low_minor: null,
        high_minor: null,
        currency: null,
        low_num: null,
        high_num: null,
        low_date: "2026-12-01",
        high_date: "2026-12-03",
        claim: "c",
        basis: "b",
        graded_at: null,
        verdict: null,
        actual_note: null,
      }));
    const ru = w("ru-RU", "trackWords");
    const head = (n: number) => trackView(rows(n), "2026-11-01", undefined, ru).headline;
    expect(head(1)).not.toBe(head(3));
    expect(head(3)).not.toBe(head(5));
    // English is what the view always said.
    expect(trackView(rows(1), "2026-11-01").headline).toBe(
      "Too soon to judge my forecasts: none graded so far, 1 forecast waiting for its time to pass.",
    );
  });
});

/** Every .ts file under lib/, as text — where a stored sentence is written. */
function libSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts"))
        out.push(readFileSync(p, "utf8"));
    }
  };
  walk(join(process.cwd(), "lib"));
  return out;
}
