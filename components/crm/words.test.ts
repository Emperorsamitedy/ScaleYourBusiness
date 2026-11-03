// L-3c: the customers catalogue says in English what the code's own words
// always said, and the screen's figures and dates follow the reader's
// locale, never converting a currency.

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import de from "../../messages/de-DE.json";
import zh from "../../messages/zh-Hans.json";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type { ReadbackView, SendView } from "./campaign-view";
import { REFUSAL_WORDS, readbackRows, refusalLines, sendSentence } from "./campaign-view";
import { LIFECYCLE_ORDER, LIFECYCLE_WORD, customersHeadline } from "./customers-view";

describe("the customers screen's English is the code's own words", () => {
  it("names every lifecycle as LIFECYCLE_WORD does", () => {
    for (const l of LIFECYCLE_ORDER) {
      expect(en.customers.lifecycle[l], l).toBe(LIFECYCLE_WORD[l].word);
    }
  });

  it("words every refusal code as REFUSAL_WORDS does", () => {
    const refusal = en.customers.campaign.refusal as Record<string, string>;
    expect(Object.keys(refusal).sort()).toEqual(Object.keys(REFUSAL_WORDS).sort());
    for (const [code, words] of Object.entries(REFUSAL_WORDS)) {
      expect(refusal[code], code).toBe(words);
    }
  });
});

const view = (over: Partial<SendView>): SendView => ({
  phase: "held",
  gates: [],
  counts: {
    pending: 0,
    refused: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
    unsubscribed: 0,
    total: 0,
    refused_by_reason: {},
  },
  approved_at: null,
  subject: null,
  body_sha256: null,
  execution: null,
  ...over,
});

describe("the customers screen's figures in the reader's locale", () => {
  const tr = englishTr("customers");
  const ctr = englishTr("customers.campaign");

  it("groups the headline's counts the English way", () => {
    expect(customersHeadline(3884, 412, tr)).toBe("3,884 customers. 412 have gone quiet.");
  });

  it("joins the headline's two sentences the way each language does", () => {
    const trIn = (locale: AppLocale, messages: typeof en): Tr =>
      createTranslator({ locale, messages, namespace: "customers" }) as unknown as Tr;
    expect(customersHeadline(54, 8, trIn("de-DE", de as typeof en))).toBe(
      "54 Kunden. 8 sind still geworden.",
    );
    // No space after the full-width full stop.
    expect(customersHeadline(54, 8, trIn("zh-Hans", zh as typeof en))).toBe(
      "54 位客户。其中 8 位已沉寂。",
    );
  });

  it("writes the send date and counts the reader's way", () => {
    const sent = view({
      phase: "sent",
      counts: { ...view({}).counts, sent: 1_200, total: 1_200 },
      execution: {
        status: "succeeded",
        held_for: null,
        error: null,
        finished_at: "2026-10-19T09:00:00Z",
      },
    });
    expect(sendSentence(sent, 1_200)).toBe(
      "Sent to 1,200 customers on 2026-10-19. A sent email can't be recalled.",
    );
    expect(sendSentence(sent, 1_200, ctr, "de-DE")).toContain("19. Okt. 2026");
    const sending = view({
      phase: "sending",
      counts: { ...view({}).counts, sent: 1_500, total: 2_000 },
    });
    expect(sendSentence(sending, 2_000, ctr, "de-DE")).toContain("1.500 of 2.000");
    expect(
      refusalLines({ ...view({}).counts, refused_by_reason: { no_email: 1_234 } }, ctr, "fr-FR"),
    ).toEqual(["no email address · 1 234"]);
  });

  it("writes the readback's rates as each language writes a percent", () => {
    const r: ReadbackView = {
      verdict: "helped",
      kind: "vip",
      lift_pp: 30,
      controlled: false,
      arithmetic: "…",
      sent_on: null,
      delivery: {
        sent: 10,
        unknown: 0,
        delivered: 9,
        bounced: 1,
        complained: 0,
        unsubscribed: 1,
        harmed: 1,
      },
      recipients: {
        size: 10,
        erased: 0,
        measured: 10,
        returned: 4,
        waiting: 0,
        measured_through: null,
      },
      comparison: {
        size: 10,
        erased: 0,
        measured: 10,
        returned: 1,
        waiting: 0,
        measured_through: null,
      },
      delivery_reported: true,
      replies_to: null,
    };
    const de = Object.fromEntries(readbackRows(r, ctr, "de-DE").map((x) => [x.label, x]));
    expect(de.delivered?.rate).toBe("90,0 %");
    expect(de.difference?.count).toBe("+30,0 points");
    const english = readbackRows(r).map((x) => x.label);
    expect(english).toContain("best customers not emailed, bought again");
  });
});
