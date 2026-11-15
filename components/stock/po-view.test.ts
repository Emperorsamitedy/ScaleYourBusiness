// P6-04 — the purchase-order words on /stock: where an order stands and why
// one wasn't really sent, in words (no codes, no ISO dates), in English and
// through another language's catalogue.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import type { Tr } from "../../lib/i18n/tr";
import type { PoWords } from "./po-view";
import { notSentWords, orderState, totalsText, unitPriceText, waitingWords } from "./po-view";

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
      "Email isn't set up on ScaleX's sending domain yet. Real sending is switched off until the two-week unattended test completes.",
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

  it("held while sending is off: 'held', why, and that it goes out on its own — never 'done'", () => {
    const held = { ...base, status: "approved", held: ["real_writes_off" as const] };
    expect(orderState(held)).toEqual({
      word: "approved, held until email is set up",
      tone: "alarm",
    });
    const words = waitingWords({ ...held, needs_confirming: false }, 14);
    expect(words).toContain("Real sending is switched off");
    expect(words).toContain("it goes out on its own once sending is on");
    expect(words).toContain("mark it as sent by hand");
    // Not approved: nothing to say.
    expect(waitingWords({ status: "executed", held: [], needs_confirming: false }, 14)).toBe("");
  });

  it("past fourteen days, it waits for a yes again; sent by hand says so, on a day in words", () => {
    const old = {
      ...base,
      status: "approved",
      held: [],
      needs_confirming: true,
      approved_on: "2026-10-20",
    };
    expect(orderState(old).word).toBe("approved on 20 Oct 2026, waiting for your yes again");
    expect(waitingWords(old, 14)).toBe(
      "You said yes more than 14 days ago, so it isn't emailed on its own. Send now sends it as it is, or make a new order.",
    );
    expect(
      orderState({ ...base, status: "executed", by_hand_on: "2026-11-09" }, words("de-DE")).word,
    ).toBe("am 9. Nov. 2026 von Ihnen gesendet");
    expect(orderState({ ...base, status: "executed", by_hand_on: "2026-11-09" }).word).toBe(
      "sent by you on 9 Nov 2026",
    );
  });

  it("a line with no stated or measured price reads 'to be confirmed by the supplier'", () => {
    expect(unitPriceText(null)).toBe("to be confirmed by the supplier");
    expect(unitPriceText({ amount_minor: 980, currency: "EUR" })).toBe("€9.80");
    expect(unitPriceText(null, words("de-DE"))).toBe("Preis bestätigt der Lieferant");
  });

  it("totals per currency, never added across two", () => {
    // HUF prints whole forints (the currency table: the fillér was withdrawn).
    expect(
      totalsText([
        { amount_minor: 49_000, currency: "EUR" },
        { amount_minor: 300_000, currency: "HUF" },
      ]),
    ).toBe("€490.00 + 3,000 HUF");
    expect(totalsText([])).toBe("—");
  });
});
