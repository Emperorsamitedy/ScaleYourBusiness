// P6-05 — the SEPA file's rules, held without a database: only approved
// payments go in (rule 12), CtrlSum is the integer sum of the minor units
// (rule 1), euros between SEPA IBANs only, the pain.001.001.03 shape, and
// text in the SEPA character set.

import { describe, expect, it } from "vitest";
import { InvalidMoneyError } from "../core/money";
import { handInstructions } from "./instructions";
import type { Debtor, FilePayment, SepaBar } from "./sepa";
import {
  PAIN_001_NAMESPACE,
  SepaFileError,
  eurDecimal,
  renderPain001,
  sepaBar,
  sepaId,
  sepaText,
  sumMinor,
} from "./sepa";

const debtor: Debtor = {
  holder_name: "Café Möller GmbH",
  iban: "DE89370400440532013000",
  bic: null,
};

const pay = (over: Partial<FilePayment> = {}): FilePayment => ({
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  proposal_status: "approved",
  approved_by: "11111111-1111-4111-8111-111111111111",
  paid: false,
  payee_name: "Bäckerei Groß & Söhne",
  payee_iban: "NL91ABNA0417164300",
  payee_bic: "ABNANL2A",
  amount: { amount_minor: 12_345, currency: "EUR" },
  reference: "Invoice 2026-118 <flour>",
  execution_date: "2026-11-20",
  ...over,
});

const render = (payments: FilePayment[], today = "2026-11-08") =>
  renderPain001({
    debtor,
    payments,
    msg_id: "SYB20261108120000ABCD",
    created_at: "2026-11-08T12:00:00.000Z",
    today,
  });

/** The text inside every <tag>…</tag>, in order. */
const all = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, "g"))].map((m) => m[1]!);

/** "123.45" → 12345, from the digits: the file's decimal read back as minor units. */
const toMinor = (decimal: string) => {
  const [whole, frac = ""] = decimal.split(".");
  return Number(`${whole}${frac.padEnd(2, "0")}`);
};

describe("renderPain001 — the file (passing)", () => {
  const a = pay();
  const b = pay({
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    payee_name: "Office Rent Ltd",
    payee_iban: "BE68539007547034",
    payee_bic: null,
    amount: { amount_minor: 95_000, currency: "EUR" },
    reference: "Rent December",
    execution_date: "2026-12-01",
  });
  const c = pay({
    id: "16fd2706-8baf-433b-82eb-8c7fada847da",
    amount: { amount_minor: 1, currency: "EUR" },
    reference: "",
  });
  const file = render([a, b, c]);

  it("carries pain.001.001.03's namespace and its document shape", () => {
    expect(file.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(file.xml).toContain(`<Document xmlns="${PAIN_001_NAMESPACE}">`);
    expect(PAIN_001_NAMESPACE).toBe("urn:iso:std:iso:20022:tech:xsd:pain.001.001.03");
    expect(file.xml).toContain("<CstmrCdtTrfInitn>");
    // Every element opened is closed (a well-formedness check without a parser).
    const opens = [...file.xml.matchAll(/<([A-Za-z]+)[ >]/g)].map((m) => m[1]);
    const closes = [...file.xml.matchAll(/<\/([A-Za-z]+)>/g)].map((m) => m[1]);
    expect(opens.sort()).toEqual(closes.sort());
  });

  it("GrpHdr has MsgId, CreDtTm, NbOfTxs and CtrlSum, in that order", () => {
    const head = file.xml.slice(file.xml.indexOf("<GrpHdr>"), file.xml.indexOf("</GrpHdr>"));
    const order = ["<MsgId>", "<CreDtTm>", "<NbOfTxs>", "<CtrlSum>", "<InitgPty>"].map((t) =>
      head.indexOf(t),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(all(head, "MsgId")).toEqual(["SYB20261108120000ABCD"]);
    expect(all(head, "CreDtTm")).toEqual(["2026-11-08T12:00:00"]);
    expect(all(head, "NbOfTxs")).toEqual(["3"]);
  });

  it("CtrlSum equals the sum of the payments in minor units — in the header and each PmtInf", () => {
    const sum = 12_345 + 95_000 + 1;
    expect(file.ctrl_sum_minor).toBe(sum);
    const sums = all(file.xml, "CtrlSum");
    expect(sums[0]).toBe("1073.46");
    expect(toMinor(sums[0]!)).toBe(sum);
    // The PmtInf sums add back up to the header's, as integers.
    expect(
      sums
        .slice(1)
        .map(toMinor)
        .reduce((x, y) => x + y, 0),
    ).toBe(sum);
    // And each amount in the file reads back to its own minor units.
    const amounts = all(file.xml, "InstdAmt").map(toMinor);
    expect(amounts.reduce((x, y) => x + y, 0)).toBe(sum);
    expect(file.xml).toContain('<InstdAmt Ccy="EUR">0.01</InstdAmt>');
  });

  it("one PmtInf per execution date, debtor = the business's own stated details", () => {
    expect(all(file.xml, "ReqdExctnDt")).toEqual(["2026-11-20", "2026-12-01"]);
    expect(file.xml.match(/<PmtInf>/g)).toHaveLength(2);
    expect(file.xml).toContain("<DbtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></DbtrAcct>");
    expect(file.xml).toContain("<Dbtr><Nm>Cafe Moller GmbH</Nm></Dbtr>");
    // No debtor BIC stated: IBAN-only, as the EPC guidelines allow.
    expect(file.xml).toContain("<Othr><Id>NOTPROVIDED</Id></Othr>");
    expect(all(file.xml, "PmtMtd")).toEqual(["TRF", "TRF"]);
    expect(all(file.xml, "Cd")).toEqual(["SEPA", "SEPA"]);
    expect(all(file.xml, "ChrgBr")).toEqual(["SLEV", "SLEV"]);
    expect(file.payment_ids).toEqual([a.id, c.id, b.id]);
  });

  it("each transfer: EndToEndId, amount, optional BIC, creditor, IBAN, remittance text", () => {
    expect(all(file.xml, "EndToEndId")[0]).toBe("0f8fad5bd9cb469fa16570867728950e");
    expect(all(file.xml, "Nm")).toContain("Backerei Gross + Sohne");
    expect(file.xml).toContain("<CdtrAgt><FinInstnId><BIC>ABNANL2A</BIC></FinInstnId></CdtrAgt>");
    expect(all(file.xml, "IBAN")).toEqual([
      "DE89370400440532013000",
      "NL91ABNA0417164300",
      "NL91ABNA0417164300",
      "DE89370400440532013000",
      "BE68539007547034",
    ]);
    expect(all(file.xml, "Ustrd")).toEqual(["Invoice 2026-118 flour", "Rent December"]);
  });

  it("a requested date already past goes out as today, and says so", () => {
    const late = render([pay({ execution_date: "2026-11-01" })]);
    expect(all(late.xml, "ReqdExctnDt")).toEqual(["2026-11-08"]);
    expect(late.moved_to_today).toEqual([pay().id]);
  });

  it("a debtor BIC, when stated, is used", () => {
    const withBic = renderPain001({
      debtor: { ...debtor, bic: "COBADEFFXXX" },
      payments: [pay()],
      msg_id: "M1",
      created_at: "2026-11-08T12:00:00Z",
      today: "2026-11-08",
    });
    expect(withBic.xml).toContain(
      "<DbtrAgt><FinInstnId><BIC>COBADEFFXXX</BIC></FinInstnId></DbtrAgt>",
    );
  });
});

describe("renderPain001 — what never goes in a file (failing)", () => {
  it("an unapproved payment never appears in a file: the renderer refuses the whole file", () => {
    for (const status of [
      "pending",
      "blocked",
      "rejected",
      "expired",
      "changes_requested",
      "executed",
    ]) {
      expect(() => render([pay(), pay({ id: "x", proposal_status: status })]), status).toThrow(
        SepaFileError,
      );
    }
    expect(() => render([pay({ approved_by: null })])).toThrow(/not_approved/);
  });

  it("a payment already marked paid, or whose details were erased", () => {
    expect(() => render([pay({ paid: true })])).toThrow(/paid/);
    expect(() => render([pay({ payee_iban: null, payee_name: null })])).toThrow(/erased/);
  });

  it("anything but euros, or a bank outside SEPA, gets instructions only", () => {
    expect(() => render([pay({ amount: { amount_minor: 100, currency: "HUF" } })])).toThrow(
      /not_eur/,
    );
    expect(() => render([pay({ payee_iban: "AE070331234567890123456" })])).toThrow(
      /payee_not_sepa/,
    );
    expect(sepaBar(pay({ amount: { amount_minor: 100, currency: "USD" } }), debtor)).toBe(
      "not_eur",
    );
    expect(sepaBar(pay(), null)).toBe("no_payer");
    expect(sepaBar(pay(), { ...debtor, iban: "AE070331234567890123456" })).toBe("payer_not_sepa");
    expect(sepaBar(pay(), debtor)).toBeNull();
  });

  it("no float money: a fractional minor amount is refused, never rounded (rule 1)", () => {
    expect(() => render([pay({ amount: { amount_minor: 10.5, currency: "EUR" } })])).toThrow(
      InvalidMoneyError,
    );
    expect(() => sumMinor([{ amount_minor: 0.1, currency: "EUR" }])).toThrow(InvalidMoneyError);
    // The printed decimal comes from the digits: no 0.1 + 0.2 drift.
    expect(eurDecimal(10 + 20)).toBe("0.30");
    expect(eurDecimal(9_007_199_254_740_991)).toBe("90071992547409.91");
  });

  it("an empty file is refused", () => {
    expect(() => render([])).toThrow(SepaFileError);
  });

  it("a name or reference in another script never becomes an empty or digits-only <Nm>", () => {
    // Greece and Bulgaria are SEPA: their names fold to nothing in the Latin set.
    const greek = pay({ payee_name: "Παπαδόπουλος ΑΕ", payee_iban: "GR1601101250000000012300695" });
    expect(sepaText("Παπαδόπουλος ΑΕ", 70)).toBe("");
    expect(sepaBar(greek, debtor)).toBe("name_not_latin");
    expect(() => render([greek])).toThrow(/name_not_latin/);
    expect(sepaBar(pay({ payee_name: "ООО Ромашка 2" }), debtor)).toBe("name_not_latin");
    expect(sepaBar(pay({ payee_name: "🍞🍞" }), debtor)).toBe("name_not_latin");
    expect(sepaBar(pay(), { ...debtor, holder_name: "Кафе Мёллер" })).toBe("name_not_latin");
    expect(sepaBar(pay({ reference: "Счёт 118" }), debtor)).toBe("name_not_latin");
    // Latin with accents still folds and goes in; an Icelandic ð is a d.
    expect(sepaBar(pay({ payee_name: "Guðrún Ólafsdóttir" }), debtor)).toBeNull();
    expect(sepaText("Guðrún Ólafsdóttir", 70)).toBe("Gudrun Olafsdottir");
  });

  it("a bank outside the EEA needs the payee's BIC in the file (the SCT rulebook's rule)", () => {
    const swiss = pay({ payee_iban: "CH9300762011623852957", payee_bic: null });
    expect(sepaBar(swiss, debtor)).toBe("bic_needed");
    expect(() => render([swiss])).toThrow(/bic_needed/);
    expect(sepaBar(pay({ payee_iban: "GB82WEST12345698765432", payee_bic: null }), debtor)).toBe(
      "bic_needed",
    );
    // The paying bank outside the EEA asks for it too.
    const fromGb: Debtor = { ...debtor, iban: "GB82WEST12345698765432" };
    expect(sepaBar(pay({ payee_bic: null }), fromGb)).toBe("bic_needed");
    // With the BIC, or both ends in the EEA, it goes in.
    expect(sepaBar({ ...swiss, payee_bic: "UBSWCHZH80A" }, debtor)).toBeNull();
    expect(sepaBar(pay({ payee_bic: null }), debtor)).toBeNull();
  });
});

describe("SEPA text", () => {
  it("folds accents, drops what the character set lacks, keeps the length", () => {
    expect(sepaText("Łódź Straße — «Ölmühle» & Co.", 70)).toBe("Lodz Strasse - Olmuhle + Co.");
    expect(sepaText("a".repeat(200), 140)).toHaveLength(140);
    expect(sepaText("<script>", 70)).toBe("script");
    expect(sepaId("ScaleX 2026-11-08 / x".repeat(4))).toHaveLength(35);
    expect(sepaId("ab cd")).toBe("abcd");
  });
});

describe("handInstructions — any currency, in plain steps", () => {
  it("lists each payment's full details and says why one isn't in the file", () => {
    const usd = pay({ amount: { amount_minor: 250_00, currency: "USD" }, id: "u" });
    const text = handInstructions(
      [pay(), usd],
      debtor,
      undefined,
      new Map([
        [pay().id, null],
        ["u", "not_eur"],
      ]),
    );
    expect(text).toContain("ScaleX can't move money");
    expect(text).toContain("Pay to: Bäckerei Groß & Söhne");
    expect(text).toContain("IBAN: NL91 ABNA 0417 1643 00");
    expect(text).toContain("BIC: ABNANL2A");
    expect(text).toContain("Amount: €123.45");
    expect(text).toContain("Amount: $250.00");
    expect(text).toContain("Payment 2 of 2");
    expect(text).toContain("Not in euros, so it isn't in the SEPA file: make it by hand.");
    expect(text).toContain("1. Open your bank's app or website");
    expect(text).toContain("Paid from: Café Möller GmbH, IBAN DE89 3704 0044 0532 0130 00");
  });

  it("says why a name in another script or a missing BIC kept one out of the file", () => {
    const text = handInstructions(
      [pay({ id: "g" }), pay({ id: "c" })],
      debtor,
      undefined,
      new Map<string, SepaBar | null>([
        ["g", "name_not_latin"],
        ["c", "bic_needed"],
      ]),
    );
    expect(text).toContain(
      "A name or reference not in Latin letters, so it isn't in the SEPA file",
    );
    expect(text).toContain("A bank outside the EEA needs the payee's BIC");
  });

  it("an erased payment says so and shows no details", () => {
    const text = handInstructions([pay({ payee_iban: null, payee_name: null })], null);
    expect(text).toContain("were erased");
    expect(text).not.toContain("NL91");
  });
});
