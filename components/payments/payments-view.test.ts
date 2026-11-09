// P6-05 — the payments screen's pure helpers: stages grouped the way the
// screen shows them, amounts typed into exact minor units (rule 1), and
// every refusal code the API sends has words in the catalogue.

import { describe, expect, it } from "vitest";
import type { PaymentRow } from "../../app/api/payments/route";
import { englishTr } from "../../lib/i18n/tr";
import {
  amountToMinor,
  fileTotalMinor,
  fileWord,
  groupPayments,
  inFileWord,
  newFileRows,
  refusalWords,
  stageWord,
} from "./payments-view";

const tr = englishTr("payments");

const row = (over: Partial<PaymentRow>): PaymentRow => ({
  id: crypto.randomUUID(),
  proposal_id: crypto.randomUUID(),
  stage: "ready",
  payee_name: "Mill & Co",
  iban_masked: "NL•• •••• 4300",
  bic: null,
  amount: { amount_minor: 6100, currency: "EUR" },
  reference: "Flour",
  execution_date: "2026-11-12",
  pays_kind: "other",
  supplier_id: null,
  cost_item_id: null,
  purchase_order_ref: null,
  created_at: "2026-11-08T10:00:00Z",
  approved_at: null,
  paid_stated_at: null,
  erased: false,
  blocked_by_limit: null,
  file_bar: null,
  in_file: null,
  ...over,
});

const IN_FILE = {
  export_id: "e",
  format: "sepa",
  msg_id: "SYB20261109100000ABCD1234",
  made_on: "2026-11-09",
} as const;

describe("groupPayments", () => {
  it("ready (by date), waiting (pending, held, changes asked), and the rest", () => {
    const later = row({ execution_date: "2026-12-01" });
    const sooner = row({ execution_date: "2026-11-10" });
    const g = groupPayments([
      later,
      row({ stage: "waiting" }),
      row({ stage: "blocked" }),
      row({ stage: "changes" }),
      sooner,
      row({ stage: "paid" }),
      row({ stage: "declined" }),
      row({ stage: "lapsed" }),
    ]);
    expect(g.ready.map((r) => r.id)).toEqual([sooner.id, later.id]);
    expect(g.waiting.map((r) => r.stage)).toEqual(["waiting", "blocked", "changes"]);
    expect(g.closed.map((r) => r.stage)).toEqual(["paid", "declined", "lapsed"]);
  });
});

describe("amountToMinor — exact, never a float (rule 1)", () => {
  it("reads what people type", () => {
    expect(amountToMinor("61", "EUR")).toBe(6100);
    expect(amountToMinor("61.5", "eur")).toBe(6150);
    expect(amountToMinor("1 234,56", "EUR")).toBe(123_456);
    expect(amountToMinor("0.01", "EUR")).toBe(1);
    expect(amountToMinor("1500", "JPY")).toBe(1500);
  });

  it("refuses what isn't an amount above zero, or is more precise than the currency", () => {
    expect(amountToMinor("", "EUR")).toBeNull();
    expect(amountToMinor("0", "EUR")).toBeNull();
    expect(amountToMinor("-5", "EUR")).toBeNull();
    expect(amountToMinor("1.005", "EUR")).toBeNull();
    expect(amountToMinor("12", "EURO")).toBeNull();
  });

  it("the file total is an integer sum of the euro rows that go in the file", () => {
    expect(
      fileTotalMinor([
        row({ amount: { amount_minor: 10, currency: "EUR" } }),
        row({ amount: { amount_minor: 20, currency: "EUR" } }),
        row({ amount: { amount_minor: 999, currency: "USD" }, file_bar: "not_eur" }),
        row({ stage: "waiting", amount: { amount_minor: 5, currency: "EUR" } }),
      ]),
    ).toBe(30);
  });

  it("the file total leaves out payments already in a downloaded file", () => {
    expect(
      fileTotalMinor([
        row({ amount: { amount_minor: 10, currency: "EUR" } }),
        row({ amount: { amount_minor: 20, currency: "EUR" }, in_file: IN_FILE }),
      ]),
    ).toBe(10);
  });
});

describe("newFileRows — a payment already in a file is never offered in a new one (2026-11-09)", () => {
  it("SEPA: ready, in no file, and able to go in a SEPA file", () => {
    const fresh = row({});
    const rows = [
      fresh,
      row({ in_file: IN_FILE }),
      row({ file_bar: "not_eur" }),
      row({ stage: "paid" }),
      row({ stage: "waiting" }),
    ];
    expect(newFileRows(rows, "sepa").map((r) => r.id)).toEqual([fresh.id]);
  });

  it("steps: every ready payment in no file, any currency", () => {
    const a = row({});
    const b = row({ file_bar: "not_eur" });
    const rows = [a, b, row({ in_file: { ...IN_FILE, format: "steps" } }), row({ stage: "paid" })];
    expect(newFileRows(rows, "steps").map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("says which file a payment is in, with the day, or that it is in none", () => {
    const day = (iso: string) => `[${iso}]`;
    expect(inFileWord({ in_file: null }, tr, day)).toBe("Not in a file yet");
    expect(inFileWord({ in_file: IN_FILE }, tr, day)).toBe("In the SEPA file of [2026-11-09]");
    expect(inFileWord({ in_file: { ...IN_FILE, format: "steps" } }, tr, day)).toBe(
      "In the instructions of [2026-11-09]",
    );
  });
});

describe("words", () => {
  it("names every stage and every reason a payment stays out of the file", () => {
    for (const stage of [
      "waiting",
      "blocked",
      "ready",
      "paid",
      "declined",
      "changes",
      "lapsed",
    ] as const) {
      expect(stageWord({ stage }, tr)).not.toContain("payments.");
    }
    expect(fileWord({ file_bar: null }, tr)).toBe("In the SEPA file");
    expect(fileWord({ file_bar: "not_eur" }, tr)).toBe("By hand: not in euros");
  });

  it("turns each refusal code into words, and falls back to the server's own", () => {
    expect(refusalWords({ code: "iban_checksum", error: "x" }, tr)).toMatch(/check digits/);
    expect(refusalWords({ code: "none_for_file" }, tr)).toMatch(/SEPA file/);
    for (const code of ["all_in_file", "taken", "no_such_file", "file_erased"]) {
      expect(refusalWords({ code, error: "x" }, tr), code).not.toBe("x");
      expect(refusalWords({ code }, tr), code).not.toContain("payments.");
    }
    expect(
      refusalWords({ error: "Only an owner can prepare payments or say one was paid." }, tr),
    ).toBe("Only an owner can prepare payments or say one was paid.");
    expect(refusalWords({}, tr)).toBe("That didn't work. Try again in a minute.");
  });
});
