// P6-09 — a purchase order as a PDF. Read back as text (pdf-text.test-util:
// pdf-lib loads it, the content streams are mapped through the font's own
// ToUnicode), so these check the file a supplier opens:
//   · it parses, and carries the order's number, every line (item,
//     quantity, unit price, line total), the total, the status and the foot;
//   · money is the integer minor units worded by the same formatter as the
//     email and the page — per currency, never added across two, the
//     unpriced lines stated — and this file does no float arithmetic on it;
//   · the same order gives the same bytes, dated the day it was prepared;
//   · Hungarian and Russian are written in their own letters; Chinese, which
//     the font doesn't carry, falls back to English, and a character the
//     font lacks prints as "?";
//   · a long order runs onto more pages, every line kept.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { englishWords, wordsFor } from "../i18n/recipient";
import { exactMoney } from "../stock/words";
import type { PurchaseOrder, SuggestedLine } from "./po";
import { poLine, poNumber, poTotals } from "./po";
import {
  PDF_LOCALES,
  drawable,
  pdfLocale,
  poPdfFilename,
  renderPurchaseOrderPdf,
  wrapText,
} from "./pdf";
import { pdfText } from "./pdf-text.test-util";

const WORDS = "emails.purchaseOrder";
const en = englishWords(WORDS);

const MUG: SuggestedLine = {
  key: "conn-1:1",
  name: "Speckled Everyday Mug",
  suggested: 50,
  arithmetic: "3.0 a day over 7 days = 21, + 5 safety margin = 26; minimum order 50, so 50.",
  unit_cost: { amount_minor: 980, currency: "EUR" },
  cost_basis: "measured",
};
const PLATE: SuggestedLine = {
  key: "conn-1:2",
  name: "Dinner Plate",
  suggested: 10,
  arithmetic: "1.0 a day over 7 days = 7, + 3 safety margin = 10.",
  unit_cost: null,
  cost_basis: null,
};

function order(lines = [poLine(MUG, null), poLine(PLATE, 12)], over: Partial<PurchaseOrder> = {}) {
  const t = poTotals(lines);
  const po: PurchaseOrder = {
    number: poNumber(7),
    business: "Fernhill Ceramics",
    supplier: {
      id: "sup-1",
      name: "Midland Clay",
      email: "orders@midland.test",
      email_field: "suppliers.sup-1.email",
    },
    lines,
    totals: t.totals,
    unpriced: t.unpriced,
    delivery_address: "Unit 4, Mill Lane\nStroud GL5 1AA",
    delivery_address_field: "legal.postal_address",
    note: "Please ring before delivery.",
    prepared_on: "2026-11-08",
    ...over,
  };
  return po;
}

const joined = async (bytes: Uint8Array) => (await pdfText(bytes)).runs.join("\n");

describe("the PDF carries the order", () => {
  it("parses, and holds the number, every line, the total, the address, the status and the foot", async () => {
    const po = order();
    const bytes = await renderPurchaseOrderPdf(po, en, { kind: "approved" });
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    const read = await pdfText(bytes);
    expect(read.pages).toBe(1);
    expect(read.title).toBe("Purchase order PO-0007");
    const text = read.runs.join("\n");
    expect(text).toContain("Purchase order PO-0007");
    expect(text).toContain("Fernhill Ceramics · prepared on 8 Nov 2026");
    expect(text).toContain("Approved: not sent yet");
    expect(text).toContain("Midland Clay\norders@midland.test");
    expect(text).toContain("Unit 4, Mill Lane\nStroud GL5 1AA");
    // Every line: item, quantity, unit price and line total — the unpriced one with dashes.
    expect(read.runs).toEqual(
      expect.arrayContaining(["Speckled Everyday Mug", "50", "€9.80", "€490.00"]),
    );
    expect(text).toContain("Dinner Plate\n12\n—\n—");
    // The total, with the line that has no price stated.
    expect(text).toContain("Expected total: €490.00, plus 1 line without a price");
    expect(text).toContain("Please ring before delivery.");
    expect(text).toContain("Prepared with SYB. SYB never changes, cancels or pays an order.");
    expect(text).toContain("PO-0007 · 1/1");
  });

  it("says where the order stands, as the page does", async () => {
    const po = order();
    const sent = await joined(
      await renderPurchaseOrderPdf(po, en, { kind: "sent", on: "2026-11-09" }),
    );
    expect(sent).toContain("Emailed to the supplier on 9 Nov 2026");
    expect(await joined(await renderPurchaseOrderPdf(po, en, { kind: "not_sent" }))).toContain(
      "Approved, not emailed: send it yourself",
    );
    expect(await joined(await renderPurchaseOrderPdf(po, en, { kind: "draft" }))).toContain(
      "Waiting for approval: not sent",
    );
  });

  it("leaves out the total and the note when there are none", async () => {
    const po = order([poLine(PLATE, null)], { note: null });
    const text = await joined(await renderPurchaseOrderPdf(po, en));
    expect(text).not.toContain("Expected total");
    expect(text).not.toContain("NOTE:");
    expect(text).toContain("Dinner Plate\n10");
  });
});

describe("money in the PDF: integer minor units, per currency (rule 1)", () => {
  it("each currency totalled on its own, never added across two, worded as the email words it", async () => {
    const pounds: SuggestedLine = {
      ...MUG,
      key: "conn-1:3",
      name: "Glaze, 5 kg",
      unit_cost: { amount_minor: 1_299, currency: "GBP" },
    };
    const po = order([poLine(MUG, null), poLine(pounds, 3)]);
    expect(po.totals).toEqual([
      { amount_minor: 49_000, currency: "EUR" },
      { amount_minor: 3_897, currency: "GBP" },
    ]);
    const text = await joined(await renderPurchaseOrderPdf(po, en));
    expect(text).toContain(
      `Expected total: ${exactMoney(49_000, "EUR", "en")} + ${exactMoney(3_897, "GBP", "en")}`,
    );
    expect(text).toContain("£38.97");
  });

  it("an amount past a float's exact cents is still to the cent", async () => {
    // 90 071 992 547 409.93 — beyond 2^53 / 100: a float in euros would lose the cents.
    const big: SuggestedLine = {
      ...MUG,
      unit_cost: { amount_minor: 9_007_199_254_740_991, currency: "EUR" },
    };
    const po = order([poLine(big, 1)], { note: null });
    const text = await joined(await renderPurchaseOrderPdf(po, en));
    expect(text).toContain(exactMoney(9_007_199_254_740_991, "EUR", "en"));
  });

  it("this file does no arithmetic on money: no division, no toFixed, no parseFloat", () => {
    const src = readFileSync(join(process.cwd(), "lib/purchasing/pdf.ts"), "utf8");
    expect(src).not.toMatch(/amount_minor\s*[/*]/);
    expect(src).not.toMatch(/toFixed|parseFloat|Number\(/);
    expect(src).toMatch(/exactMoney\(m\.amount_minor, m\.currency, locale\)/);
  });
});

describe("the same order, the same bytes", () => {
  it("renders byte for byte the same, dated the day it was prepared, made by SYB", async () => {
    const po = order();
    const a = await renderPurchaseOrderPdf(po, en, { kind: "approved" });
    const b = await renderPurchaseOrderPdf(po, en, { kind: "approved" });
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    const read = await pdfText(a);
    expect(read.creationDate?.toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(read.producer).toBe("SYB");
    // No random font-name suffix: the embedded names are fixed.
    expect(Buffer.from(a).toString("latin1")).toContain("SYB-DejaVuSans");
  });

  it("a different order gives different bytes", async () => {
    const a = await renderPurchaseOrderPdf(order(), en);
    const b = await renderPurchaseOrderPdf(order(undefined, { number: poNumber(8) }), en);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
  });
});

describe("languages", () => {
  it("writes Hungarian and Russian in their own letters", async () => {
    const po = order([poLine({ ...MUG, name: "Bögre, őszi színű" }, null)]);
    const hu = await joined(await renderPurchaseOrderPdf(po, await wordsFor("hu-HU", WORDS)));
    expect(hu).toContain("PO-0007 számú megrendelés");
    expect(hu).toContain("Bögre, őszi színű");
    const ru = await joined(await renderPurchaseOrderPdf(po, await wordsFor("ru-RU", WORDS)));
    expect(ru).toContain("Заказ поставщику PO-0007");
  });

  it("covers six languages; Chinese falls back to English, honestly", () => {
    expect(PDF_LOCALES).toEqual(["en", "es-ES", "de-DE", "fr-FR", "hu-HU", "ru-RU"]);
    for (const l of PDF_LOCALES) expect(pdfLocale(l)).toBe(l);
    expect(pdfLocale("zh-Hans")).toBe("en");
  });

  it("every word of the six catalogues' order words is drawable in the font", async () => {
    const bytes = await renderPurchaseOrderPdf(order(), en);
    expect(bytes.byteLength).toBeGreaterThan(0);
    for (const l of PDF_LOCALES) {
      const text = await joined(
        await renderPurchaseOrderPdf(order(), await wordsFor(l, WORDS), {
          kind: "sent",
          on: "2026-11-09",
        }),
      );
      expect({ l, missing: text.includes("?") || text.includes("�") }).toEqual({
        l,
        missing: false,
      });
    }
  });

  it("a character the font lacks prints as ?, never as an invisible box", async () => {
    const po = order([poLine({ ...MUG, name: "Mug 杯子" }, null)], { business: "茶 House" });
    const text = await joined(await renderPurchaseOrderPdf(po, en));
    expect(text).toContain("Mug ??");
    expect(text).toContain("? House");
    expect(drawable("a\tb\u0007c\nd", new Set([..."abcd "].map((c) => c.codePointAt(0)!)))).toBe(
      "a bc\nd",
    );
  });
});

describe("a long order", () => {
  it("runs onto more pages, the table head repeated, every line kept", async () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      poLine(
        {
          ...MUG,
          key: `conn-1:${i}`,
          name: `Item number ${i + 1} with a rather long descriptive name that wraps onto a second line`,
        },
        i + 1,
      ),
    );
    const read = await pdfText(await renderPurchaseOrderPdf(order(lines), en));
    expect(read.pages).toBeGreaterThan(1);
    const text = read.runs.join(" ");
    for (let i = 1; i <= 25; i++) expect(text).toContain(`Item number ${i} with`);
    expect(read.runs.filter((r) => r === "Item").length).toBe(read.pages);
    expect(text).toContain(`PO-0007 · ${read.pages}/${read.pages}`);
  });
});

describe("small pieces", () => {
  it("names the file after the order", () => {
    expect(poPdfFilename({ number: "PO-0007" })).toBe("PO-0007.pdf");
    expect(poPdfFilename({ number: 'PO-"7"/..' })).toBe("PO-7.pdf");
  });

  it("wraps words to a width, cutting only a word too long for a line", () => {
    const measure = (s: string) => s.length;
    expect(wrapText("one two three", 7, measure)).toEqual(["one two", "three"]);
    expect(wrapText("abcdefghij", 4, measure)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("a\nb", 10, measure)).toEqual(["a", "b"]);
  });
});
