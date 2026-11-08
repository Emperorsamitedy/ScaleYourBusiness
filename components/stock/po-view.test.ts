// P6-04 — the purchase-order words on /stock: where an order stands and why
// one wasn't really sent, in words (no codes, no ISO dates), in English and
// through another language's catalogue.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import type { Tr } from "../../lib/i18n/tr";
import type { PoWords } from "./po-view";
import { notSentWords, orderState, totalsText } from "./po-view";

function words(locale: "de-DE" | "en"): PoWords {
  const messages = JSON.parse(
    readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
  const t = createTranslator({ locale, messages, namespace: "stock" as "common" }) as unknown as Tr;
  return { tr: (k, v) => t(k, v), locale };
}

const base = { status: "pending", sent: null, sent_on: null, error: null };

describe("where an order stands", () => {
  it("in words, for each status, never as a code", () => {
    expect(orderState(base).word).toBe("waiting for your approval");
    expect(orderState({ ...base, status: "rejected" }).word).toBe("declined, never sent");
    expect(orderState({ ...base, status: "changes_requested" }).word).toBe(
      "changes asked for, not sent",
    );
    expect(orderState({ ...base, status: "expired" })).toEqual({
      word: "ran out of time, never sent",
      tone: "none",
    });
    expect(orderState({ ...base, status: "approved", error: "boom" }).word).toBe("didn't go out");
  });

  it("sent on a day in words; run against the fake sender, 'ready, not sent'", () => {
    const sent = orderState({ ...base, status: "executed", sent: true, sent_on: "2026-11-08" });
    expect(sent).toEqual({ word: "emailed on 8 Nov 2026", tone: "ok" });
    expect(sent.word).not.toContain("2026-11-08");
    expect(orderState({ ...base, status: "executed", sent: false }).word).toBe("ready, not sent");
  });

  it("why it wasn't sent, as sentences", () => {
    expect(notSentWords(["email_not_set_up", "real_writes_off"])).toBe(
      "Email isn't set up on SYB's sending domain yet. Real sending is switched off until the two-week unattended test completes.",
    );
    expect(notSentWords([])).toBe("");
  });

  it("reads the same through another language's catalogue", () => {
    const de = words("de-DE");
    expect(orderState({ ...base, status: "executed", sent: false }, de).word).toBe(
      "bereit, nicht gesendet",
    );
    expect(notSentWords(["real_writes_off"], de)).toMatch(/^Der echte Versand ist ausgeschaltet/);
  });

  it("totals per currency, never added across two", () => {
    expect(
      totalsText([
        { amount_minor: 49_000, currency: "EUR" },
        { amount_minor: 300_000, currency: "HUF" },
      ]),
    ).toBe("€490.00 + 3,000.00 HUF");
    expect(totalsText([])).toBe("—");
  });
});
