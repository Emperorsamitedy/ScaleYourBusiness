// L-4c: the customers screen's server sentences come from the
// "customersWords" catalogue. In English they are the words lib/crm and
// lib/trust/email-readback always wrote (the old literals are pinned here);
// in the other languages figures and dates follow the reader, Russian counts
// take all their forms, Chinese joins sentences without a space, and a
// sentence that isn't SYB's own is shown as it came.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import type { AppLocale } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { realWritesOffSentence } from "../execution/engine";
import { EXECUTION_SCOPE_REGISTRY } from "../execution/scopes";
import { judgeEmailCampaign } from "../trust/email-readback";
import type { EmailJudgeInput } from "../trust/email-readback";
import { measuredSentence } from "../../components/crm/campaign-view";
import type { ReadbackView } from "../../components/crm/campaign-view";
import { watchingUntil } from "../care/watch-words";
import { campaignCompliance } from "./campaign-draft";
import { FIRST_CAMPAIGN_UNREVIEWED } from "./campaign-review";
import { GATE_WORDS } from "./campaign-send";
import { messageGaps, REGIMES } from "./jurisdiction";
import { lawReviewVerdict } from "./law-review";
import { campaignWords, crmErrorWords, gateWords, sendMessageWords, skipLines } from "./localize";
import { campaignSummary } from "./segment-proposals";
import { customersEnglish } from "./words";

const EN = customersEnglish();

const lang = (locale: AppLocale, namespace = "customersWords"): Tr => {
  const messages = JSON.parse(
    readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
  const t = createTranslator({
    locale,
    messages,
    namespace: namespace as "common",
    timeZone: "UTC",
  }) as unknown as Tr;
  return (k, v) => t(k, v);
};
const de = lang("de-DE");
const ru = lang("ru-RU");
const zh = lang("zh-Hans");

describe("English is what lib/crm always said", () => {
  it("says the gates as GATE_WORDS, the reviews and the engine do", () => {
    for (const [code, words] of Object.entries(GATE_WORDS)) expect(EN(`gate.${code}`)).toBe(words);
    expect(EN("gate.first_campaign_unreviewed")).toBe(FIRST_CAMPAIGN_UNREVIEWED);
    expect(EN("gate.law_review_missing")).toBe(lawReviewVerdict(null, "x").words);
    expect(EN("gate.law_review_stale", { date: "2026-10-01" })).toBe(
      lawReviewVerdict({ table_sha256: "old", reviewed_on: "2026-10-01" }, "new").words,
    );
    const label = EXECUTION_SCOPE_REGISTRY.email_campaign.label;
    expect(EN("gate.real_sends_label")).toBe(label);
    expect(EN("gate.real_sends_off", { label })).toBe(realWritesOffSentence(label));
  });

  it("writes a campaign's summary as the old templates did, agreeing at one", () => {
    const old = {
      winback: (n: number) =>
        `Win back ${n} lapsed customer${n === 1 ? "" : "s"} who said yes to email`,
      vip: (n: number) => `Thank your ${n} best customer${n === 1 ? "" : "s"}`,
      cart: (n: number) =>
        `Remind ${n} shopper${n === 1 ? "" : "s"} who left a cart this week and said yes to email`,
    };
    for (const kind of ["winback", "vip", "cart"] as const) {
      for (const n of [0, 1, 3, 1234]) expect(campaignSummary(kind, n)).toBe(old[kind](n));
    }
  });

  it("says the draft's gaps as messageGaps does, and the refusals as applicableRegimes does", () => {
    const draft = (country: string | null, senderName: string | null, postal: string | null) =>
      campaignCompliance({ businessCountry: country, senderName, postalAddress: postal });
    const old = (country: string) =>
      messageGaps(
        {
          sender_name: "",
          sender_email: "",
          postal_address: null,
          unsubscribe_url: null,
          disclosure: "AI",
        },
        [Object.values(REGIMES).find((r) => r.countries.includes(country))!],
        "draft",
      );
    expect(draft("US", null, null).gaps).toEqual(old("US"));
    expect(draft("US", null, null).gaps).toEqual([
      "the business's name (United States)",
      "the business's postal address (United States)",
    ]);
    expect(draft("CA", null, null).gaps).toEqual(old("CA"));
    expect(draft("DE", null, null).gaps).toEqual(old("DE"));
    expect(draft("US", null, null).ask.map((a) => a.label)).toEqual([
      "Add your business name",
      "Add your postal address",
    ]);
    expect(draft("US", "Ember", "1 Main St").at_send).toEqual([
      "the sending address",
      "each recipient's own unsubscribe link",
    ]);
    expect(draft(null, null, null).gaps).toEqual([
      "the business's country isn't known, so its email rules aren't either",
    ]);
    expect(draft("Narnia", null, null).gaps).toEqual([
      "ScaleX doesn't yet know the email marketing rules for Narnia — nothing is sent there",
    ]);
    for (const r of Object.values(REGIMES)) {
      expect(EN(`compliance.regime.${r.id}`)).toBe(r.label.split(" — ")[0]);
    }
  });

  it("says the segments' reasons as segment-proposals wrote them", () => {
    const old = [
      'your own answer on customer consent (6.4b) was "no consent" — outbound email stays off until your data says otherwise',
      "already proposed today",
      "already proposed this month",
      "everyone who left a cart this week and said yes to email was already proposed a reminder in the last 30 days",
      "no contact who said yes to email left a cart in the last week",
      "nobody is in this segment",
      "4 in the segment, none with explicit email consent — nothing to send to",
      "you've declined customer email 3 times — I've stopped proposing it",
    ];
    const lines = skipLines(
      old.map((reason) => ({ segment: "lapsed", reason })),
      null,
      de,
      "de-DE",
    );
    for (const [i, l] of lines.entries()) expect(l.line, old[i]).not.toContain(old[i]!);
    // English: the line is the one the screen always built.
    expect(skipLines([{ segment: "vip", reason: old[2]! }], null, EN, "en")[0]?.line).toBe(
      "vip: already proposed this month",
    );
    expect(EN("skip.watching", { date: "6 Nov" })).toBe(watchingUntil("2026-11-06"));
  });

  it("knows every refusal lib/crm throws, word for word", () => {
    const files = [
      "contacts.ts",
      "import.ts",
      "campaign-draft.ts",
      "campaign-send.ts",
      "segment-proposals.ts",
    ];
    const literals: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), "lib", "crm", f), "utf8");
      for (const m of src.matchAll(
        /new (?:ContactError|SegmentProposalError|CampaignSendError)\(\s*(["`])((?:\\.|(?!\1)[\s\S])*)\1/g,
      )) {
        literals.push((m[2] as string).replace(/\$\{[^}]*\}/g, "7"));
      }
    }
    expect(literals.length).toBeGreaterThan(20);
    for (const l of literals) expect(crmErrorWords(l, de, "de-DE"), l).not.toBe(l);
    for (const words of Object.values(GATE_WORDS)) {
      expect(crmErrorWords(words, de, "de-DE"), words).not.toBe(words);
    }
    // English is untouched; a message that isn't lib/crm's is shown as it came.
    expect(crmErrorWords("no such campaign", EN, "en")).toBe("no such campaign");
    expect(crmErrorWords("this proposal is already pending", de, "de-DE")).toBe(
      "this proposal is already pending",
    );
  });
});

describe("in the reader's language", () => {
  it("says a gate in German, and a gate it doesn't know as it came", () => {
    const g = gateWords({ code: "no_draft", words: GATE_WORDS.no_draft }, de, "de-DE");
    expect(g.code).toBe("no_draft");
    expect(g.words).not.toBe(GATE_WORDS.no_draft);
    expect(g.words).toMatch(/E-Mail/);
    const stale = gateWords(
      {
        code: "law_review_stale",
        words: lawReviewVerdict({ table_sha256: "a", reviewed_on: "2026-10-01" }, "b").words,
      },
      de,
      "de-DE",
    );
    expect(stale.words).toContain("1. Okt. 2026");
    const foreign = { code: "stopped" as const, words: "Some other module's words." };
    expect(gateWords(foreign, de, "de-DE").words).toBe(foreign.words);
  });

  it("writes the readback's arithmetic in German figures", () => {
    const input: EmailJudgeInput = {
      kind: "winback",
      delivery: {
        sent: 40,
        unknown: 0,
        delivered: 40,
        bounced: 0,
        complained: 0,
        unsubscribed: 1,
        harmed: 1,
      },
      recipients: {
        size: 40,
        erased: 0,
        measured: 2,
        returned: 1,
        waiting: 38,
        measured_through: null,
      },
      comparison: {
        size: 0,
        erased: 0,
        measured: 0,
        returned: 0,
        waiting: 0,
        measured_through: null,
      },
      sent_on: "2026-10-01",
    };
    const en = judgeEmailCampaign(input).arithmetic;
    expect(en).toBe(
      "1 recipient unsubscribed or marked it as spam (1 unsubscribed, 0 complained) of 40 sent, 2.5% — backfired at 2% with at least 2 people, or any complaints at 0.3% or more; 2 recipients measured by a customer export at least 14 days after the email — the verdict needs 5",
    );
    const local = judgeEmailCampaign(input, de, "de-DE").arithmetic;
    expect(local).toContain("2,5");
    expect(local).toContain("0,3");
    expect(local).not.toContain("recipient");
  });

  it("gives Russian its counting forms at 1, 3, 5 and 21", () => {
    const say = (n: number) => campaignSummary("vip", n, ru, "ru-RU");
    const forms = [1, 3, 5, 21].map(say);
    expect(new Set(forms).size).toBeGreaterThan(1);
    expect(forms[0]).toContain("1");
    expect(forms[3]).toContain("21");
    // 1 and 21 take the same form, 3 and 5 another (the animate accusative: "лучших клиентов").
    expect(forms[0]!.replace("1", "#")).toBe(forms[3]!.replace("21", "#"));
    expect(forms[0]!.replace("1", "#")).not.toBe(forms[1]!.replace("3", "#"));
    // A recipient as a subject: 1 получатель, 3 получателя, 5 получателей, 21 получатель.
    const people = (n: number) => ru("readback.recipients", { count: n, n: String(n) });
    expect(people(1).replace("1", "#")).toBe(people(21).replace("21", "#"));
    expect(people(3).replace("3", "#")).not.toBe(people(5).replace("5", "#"));
  });

  it("joins a gate and 'nothing was sent' in Chinese without a space", () => {
    const english = `${GATE_WORDS.no_draft} ${EN("send.stillApproved")}`;
    const said = sendMessageWords(english, zh, "zh-Hans");
    expect(said).not.toBe(english);
    expect(said).toBe(`${zh("gate.no_draft")}${zh("send.stillApproved")}`);
    expect(said).not.toMatch(/[。，；：] /);
    expect(sendMessageWords(english, EN, "en")).toBe(english);
  });

  it("says a stored campaign's summary and label again only when ScaleX's English is exactly it", () => {
    const detail = { segment: "lapsed", contact_ids: ["a", "b", "c"] };
    const stored = { summary: campaignSummary("winback", 3), label: "Lapsed customers" };
    const local = campaignWords(stored, detail, de, "de-DE");
    expect(local.summary).not.toBe(stored.summary);
    expect(local.label).toBe(de("segment.label.lapsed"));
    // An older wording, or a count that doesn't match the recipients, stays as stored.
    const older = { summary: "Win back the lapsed", label: "Old label" };
    expect(campaignWords(older, detail, de, "de-DE")).toEqual(older);
    expect(campaignWords(stored, { ...detail, contact_ids: ["a"] }, de, "de-DE").summary).toBe(
      stored.summary,
    );
    expect(campaignWords(stored, detail, EN, "en")).toEqual(stored);
  });

  it("says the measured line in Chinese, the readback's period too", () => {
    const r: ReadbackView = {
      verdict: "too_early",
      kind: "winback",
      lift_pp: null,
      controlled: false,
      arithmetic: "",
      sent_on: "2026-10-01",
      delivery: {
        sent: 1,
        unknown: 0,
        delivered: 1,
        bounced: 0,
        complained: 0,
        unsubscribed: 0,
        harmed: 0,
      },
      recipients: {
        size: 1,
        erased: 0,
        measured: 1,
        returned: 0,
        waiting: 0,
        measured_through: "2026-10-16T00:00:00Z",
      },
      comparison: {
        size: 0,
        erased: 0,
        measured: 0,
        returned: 0,
        waiting: 0,
        measured_through: null,
      },
      delivery_reported: true,
      replies_to: "hello@example.test",
    };
    expect(measuredSentence(r)).toMatch(/^I counted delivery/);
    const said = measuredSentence(r, zh, "zh-Hans");
    expect(said).toContain("hello@example.test");
    expect(said).toMatch(/。$/);
    expect(said).not.toContain("I counted");
  });
});
