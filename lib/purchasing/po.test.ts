// P6-04 — the purchase order's pure half: its lines and their arithmetic
// (rule 6), money per currency (rule 1), the fingerprint the sender checks,
// whether email can really go out, and the words of the email and document.
// Each rule has its passing case and its failing one beside it.

import { describe, expect, it } from "vitest";
import { PO_HELD, heldSentence } from "../execution/providers/purchase-order";
import {
  PO_APPROVAL_MAX_AGE_DAYS,
  PO_NEEDS_CONFIRMING,
  stalePurchaseOrder,
} from "../execution/stale";
import { englishWords, wordsFor } from "../i18n/recipient";
import type { PurchaseOrder, SuggestedLine } from "./po";
import {
  PO,
  canonicalJson,
  cleanText,
  normaliseEmail,
  poDocument,
  poEmail,
  poFromHeader,
  poLine,
  poNumber,
  poSha256,
  poTotals,
  pricedLine,
  readQuantity,
  sendingMode,
  totalWords,
} from "./po";

const MUG: SuggestedLine = {
  key: "conn-1:gid://shopify/Product/1",
  name: "Blue Mug",
  suggested: 50,
  arithmetic:
    "3.0 a day (up to 3.7) over 7 days = 21, + 5 safety margin = 26; Midland Clay's minimum order is 50, so 50.",
  unit_cost: { amount_minor: 980, currency: "EUR" },
  cost_basis: "measured",
  price_source: "stock.unit_cost",
};
const PLATE: SuggestedLine = {
  key: "conn-1:gid://shopify/Product/2",
  name: "Dinner <Plate>",
  suggested: 10,
  arithmetic: "1.0 a day over 7 days = 7, + 3 safety margin = 10; no minimum order on file.",
  unit_cost: null,
  cost_basis: null,
  price_source: null,
};

function order(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  const lines = [poLine(MUG, null), poLine(PLATE, 12)];
  const t = poTotals(lines);
  return {
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
    note: null,
    prepared_on: "2026-11-08",
    ...over,
  };
}

describe("the lines carry their arithmetic (rule 6) and their money (rule 1)", () => {
  it("keeps the suggestion's arithmetic as it was", () => {
    const l = poLine(MUG, null);
    expect(l).toMatchObject({ quantity: 50, suggested: 50, arithmetic: MUG.arithmetic });
    expect(l.line_total).toEqual({ amount_minor: 49_000, currency: "EUR" });
  });

  it("an owner's own quantity says so, beside the suggestion it replaced", () => {
    const l = poLine(MUG, 60);
    expect(l.quantity).toBe(60);
    expect(l.arithmetic).toBe(`You chose 60; the suggestion was 50: ${MUG.arithmetic}`);
    expect(l.line_total).toEqual({ amount_minor: 58_800, currency: "EUR" });
  });

  it("a line with no cost on file has no total, and is counted, never priced at zero", () => {
    const l = poLine(PLATE, null);
    expect(l.unit_cost).toBeNull();
    expect(l.line_total).toBeNull();
    expect(poTotals([poLine(MUG, null), l])).toEqual({
      totals: [{ amount_minor: 49_000, currency: "EUR" }],
      unpriced: 1,
    });
  });

  it("two currencies are two totals, never added", () => {
    const huf = poLine(
      {
        ...PLATE,
        unit_cost: { amount_minor: 150_000, currency: "HUF" },
        cost_basis: "stated",
        price_source: "offers.o-2.cost_to_deliver",
      },
      2,
    );
    expect(poTotals([poLine(MUG, null), huf]).totals).toEqual([
      { amount_minor: 49_000, currency: "EUR" },
      { amount_minor: 300_000, currency: "HUF" },
    ]);
  });

  it("a typed quantity is a whole number from 1; anything else is refused", () => {
    expect(readQuantity("60")).toBe(60);
    expect(readQuantity(12)).toBe(12);
    for (const bad of ["0", "-3", "2.5", "lots", "", 1e9, null])
      expect(readQuantity(bad)).toBeNull();
  });
});

describe("never an estimate as a price (decision 4, 2026-11-09)", () => {
  const w = englishWords("emails.purchaseOrder");
  // An order stored before the decision: the mug priced from value at cost ÷ on hand, no source.
  const legacy = (): PurchaseOrder => {
    const po = order();
    const mug: Record<string, unknown> = { ...po.lines[0]! };
    delete mug.price_source;
    return { ...po, lines: [mug as unknown as (typeof po.lines)[number], po.lines[1]!] };
  };

  it("a price with no fact or measure behind it is dropped from the line, never kept", () => {
    const l = poLine({ ...MUG, price_source: null }, null);
    expect(l).toMatchObject({ unit_cost: null, line_total: null, price_source: null });
    expect(pricedLine(poLine(MUG, null))).toEqual({
      unit: { amount_minor: 980, currency: "EUR" },
      total: { amount_minor: 49_000, currency: "EUR" },
    });
  });

  it("a stored line priced without a source reads 'to be confirmed' in the email, page and totals", () => {
    const po = legacy();
    expect(pricedLine(po.lines[0]!)).toBeNull();
    const mail = poEmail(po, w);
    expect(mail.text).toContain("- 50 × Blue Mug, price to be confirmed by the supplier");
    expect(mail.text).not.toContain("€9.80");
    expect(mail.text).not.toContain("€490.00");
    expect(mail.text).toContain("No total yet: the supplier is to confirm the price of 2 lines");
    const page = poDocument(po, w, { kind: "approved" });
    expect(page).not.toContain("€9.80");
    expect(page).toContain("to be confirmed");
    expect(poTotals(po.lines)).toEqual({ totals: [], unpriced: 2 });
  });

  it("the total says how many lines the supplier prices, one or many", () => {
    const one = order({ lines: [poLine(PLATE, 3)] });
    expect(totalWords(one, w)).toBe("No total yet: the supplier is to confirm the price of 1 line");
    expect(totalWords(order(), w)).toBe(
      "Expected total: €490.00, plus 1 line with the price to be confirmed by the supplier",
    );
    expect(totalWords(order({ lines: [poLine(MUG, null)] }), w)).toBe("Expected total: €490.00");
  });

  it("a sent-by-hand order says so on its page", () => {
    expect(poDocument(order(), w, { kind: "sent_by_hand", on: "2026-11-09" })).toContain(
      "Sent to the supplier on 9 Nov 2026",
    );
  });
});

describe("held, not done (decision 3, 2026-11-09): when a held order needs a yes again", () => {
  it("fourteen days, the same span an order lives undecided", () => {
    expect(PO_APPROVAL_MAX_AGE_DAYS).toBe(PO.expiry_days);
  });

  it("goes on its own within the span; past it, waits for the owner — in words, no code", () => {
    const yes = "2026-11-01T09:00:00.000Z";
    expect(stalePurchaseOrder(yes, new Date("2026-11-15T09:00:00.000Z"))).toBeNull();
    const late = stalePurchaseOrder(yes, new Date("2026-11-15T09:00:01.000Z"));
    expect(late).toMatch(new RegExp(`^${PO_NEEDS_CONFIRMING}`));
    expect(late).toContain("You approved it on 1 November");
    expect(late).toContain("Press Send now");
    expect(stalePurchaseOrder(null, new Date())).toBeNull();
  });

  it("the held sentence names every reason and says it isn't marked done", () => {
    const s = heldSentence(["email_not_set_up", "real_writes_off"]);
    expect(s.startsWith(PO_HELD)).toBe(true);
    expect(s).toContain("Email isn't set up on SYB's sending domain yet.");
    expect(s).toContain("Real sending is switched off");
    expect(s).toContain("it isn't marked done");
  });
});

describe("the order's fingerprint", () => {
  it("is the same after a jsonb round trip reorders its keys", () => {
    const po = order();
    const reordered = JSON.parse(canonicalJson(po)) as PurchaseOrder;
    expect(poSha256(reordered)).toBe(poSha256(po));
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("changes when anything the owner approved changes", () => {
    const po = order();
    expect(poSha256({ ...po, delivery_address: "Somewhere else" })).not.toBe(poSha256(po));
    expect(poSha256({ ...po, supplier: { ...po.supplier, email: "other@midland.test" } })).not.toBe(
      poSha256(po),
    );
    const lines = po.lines.map((l, i) => (i === 0 ? { ...l, quantity: 500 } : l));
    expect(poSha256({ ...po, lines })).not.toBe(poSha256(po));
  });
});

describe("whether an order can really be emailed", () => {
  const ready = {
    RESEND_API_KEY: "re_live",
    EMAIL_FROM: "SYB <hello@syb.example>",
    SESSION_D_REAL_WRITES: "on",
  };

  it("really, only with the email service set up on a domain AND the real-write gate on", () => {
    expect(sendingMode(ready)).toEqual({
      mode: "real",
      api_key: "re_live",
      from_address: "hello@syb.example",
    });
  });

  it("otherwise against the fake sender, naming every reason", () => {
    expect(sendingMode({ ...ready, SESSION_D_REAL_WRITES: undefined })).toEqual({
      mode: "fake",
      reasons: ["real_writes_off"],
    });
    expect(sendingMode({ ...ready, SESSION_D_REAL_WRITES: "yes" })).toMatchObject({
      reasons: ["real_writes_off"],
    });
    expect(sendingMode({ ...ready, RESEND_API_KEY: " " })).toEqual({
      mode: "fake",
      reasons: ["email_not_set_up"],
    });
    // Resend's sandbox sender reaches only the Resend account's own owner.
    expect(sendingMode({ ...ready, EMAIL_FROM: "SYB <onboarding@resend.dev>" })).toMatchObject({
      reasons: ["email_not_set_up"],
    });
    expect(sendingMode({})).toEqual({
      mode: "fake",
      reasons: ["email_not_set_up", "real_writes_off"],
    });
  });

  it("the From names the business and keeps SYB's verified address", () => {
    expect(poFromHeader('Fern "hill" <x>', "hello@syb.example")).toBe(
      '"Fern hill x via SYB" <hello@syb.example>',
    );
    expect(poFromHeader("", "hello@syb.example")).toBe('"A business via SYB" <hello@syb.example>');
  });
});

describe("the small checks", () => {
  it("an email address is one address, normalised", () => {
    expect(normaliseEmail("  Orders@Midland.TEST ")).toBe("orders@midland.test");
    for (const bad of ["", "orders", "a@b", "a b@c.de", "a@b.de, c@d.de", "<a@b.de>", 7]) {
      expect(normaliseEmail(bad)).toBeNull();
    }
  });

  it("text is trimmed, control characters dropped, and capped", () => {
    expect(cleanText("  Unit 4\r\nMill Lane\u0007 ", 100)).toBe("Unit 4\nMill Lane");
    expect(cleanText("   ", 100)).toBeNull();
    expect(cleanText("x".repeat(50), 10)).toBe("x".repeat(10));
  });
});

describe("the words", () => {
  it("the email lists every line, the total, the address and who replies", () => {
    const mail = poEmail(order(), englishWords("emails.purchaseOrder"));
    expect(mail.subject).toBe("Purchase order PO-0007 from Fernhill Ceramics");
    expect(mail.text).toContain("- 50 × Blue Mug at €9.80 = €490.00");
    expect(mail.text).toContain("- 12 × Dinner <Plate>, price to be confirmed by the supplier");
    expect(mail.text).toContain(
      "Expected total: €490.00, plus 1 line with the price to be confirmed by the supplier",
    );
    expect(mail.text).toContain("Deliver to:\nUnit 4, Mill Lane\nStroud GL5 1AA");
    expect(mail.text).toContain("an AI assistant");
    // The HTML part escapes what came from data.
    expect(mail.html).toContain("Dinner &lt;Plate&gt;");
    expect(mail.html).not.toContain("<Plate>");
  });

  it("the email reads in the business's language", async () => {
    const mail = poEmail(order(), await wordsFor("de-DE", "emails.purchaseOrder"));
    expect(mail.subject).toBe("Bestellung PO-0007 von Fernhill Ceramics");
    expect(mail.text).toContain("Lieferung an:");
  });

  it("the document is a page with no script, every value escaped, its status in words", () => {
    const w = englishWords("emails.purchaseOrder");
    const page = poDocument(order({ note: "<script>alert(1)</script>" }), w, {
      kind: "sent",
      on: "2026-11-08",
    });
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).not.toMatch(/<script/i);
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("Emailed to the supplier on 8 Nov 2026");
    expect(page).not.toContain("2026-11-08");
    expect(poDocument(order(), w, { kind: "not_sent" })).toContain(
      "Approved, not emailed: send it yourself",
    );
  });
});
