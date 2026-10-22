// Feature 35 — deterministic extraction from fixture pages. No network:
// the global fetch is stubbed to fail, and nothing here should reach it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  extractPage,
  fromJsonLd,
  fromOpenGraph,
  fromPatterns,
  needsModel,
  offerKey,
  parseAmount,
} from "./extract";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", `${name}.html`), "utf8");
const brief = (
  offers: {
    name: string;
    price: { amount_minor: number; currency: string };
    from: boolean;
    method: string;
  }[],
) => offers.map((o) => [o.name, o.price.amount_minor, o.price.currency, o.from, o.method]);

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in tests"))),
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("money from the digits as written (rule 1)", () => {
  it("reads every common spelling into integer minor units", () => {
    expect(parseAmount("85", "EUR")).toBe(8500);
    expect(parseAmount("85.00", "EUR")).toBe(8500);
    expect(parseAmount("85,00", "EUR")).toBe(8500);
    expect(parseAmount("85,-", "EUR")).toBe(8500);
    expect(parseAmount("12,500.50", "EUR")).toBe(1250050);
    expect(parseAmount("12.500,50", "EUR")).toBe(1250050);
    expect(parseAmount("1 200", "HUF")).toBe(120000);
    expect(parseAmount("1.200", "HUF")).toBe(120000);
    expect(parseAmount("1500", "JPY")).toBe(1500);
  });

  it("refuses what is not a plain positive amount", () => {
    expect(parseAmount("0", "EUR")).toBeNull();
    expect(parseAmount("abc", "EUR")).toBeNull();
    expect(parseAmount("1.2345", "EUR")).toBeNull();
    expect(parseAmount("-5", "EUR")).toBeNull();
  });

  it("reads schema.org numbers strictly: 1.5 is one and a half", () => {
    expect(parseAmount("1.5", "EUR", true)).toBe(150);
    expect(parseAmount("1,5", "EUR", true)).toBeNull();
  });
});

describe("1 · JSON-LD", () => {
  it("reads an OfferCatalog's services, with a priceSpecification price", () => {
    const { offers } = fromJsonLd(fixture("salon-jsonld"));
    expect(brief(offers)).toEqual([
      ["Cut and colour", 8500, "EUR", false, "jsonld"],
      ["Blow dry", 3000, "EUR", false, "jsonld"],
      ["Balayage", 12000, "EUR", false, "jsonld"],
    ]);
  });

  it("takes the business's rating, never a service's", () => {
    // The fixture's Balayage carries 3.1 from 900 reviews; the salon 4.7 from 212.
    expect(fromJsonLd(fixture("salon-jsonld")).rating).toEqual({
      rating: 4.7,
      best: 5,
      count: 212,
      method: "jsonld",
    });
  });

  it("reads a Product's offers and an AggregateOffer as a starting price", () => {
    const html = `<script type="application/ld+json">[{"@type":"Product","name":"Gift box","offers":{"@type":"Offer","price":"24.90","priceCurrency":"GBP"}},
      {"@type":"Product","name":"Hamper","offers":{"@type":"AggregateOffer","lowPrice":"40","highPrice":"90","priceCurrency":"GBP"}}]</script>`;
    expect(brief(fromJsonLd(html).offers)).toEqual([
      ["Gift box", 2490, "GBP", false, "jsonld"],
      ["Hamper", 4000, "GBP", true, "jsonld"],
    ]);
  });

  it("drops an offer whose currency it cannot name, and a block that isn't JSON", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Mystery","offers":{"@type":"Offer","price":"10"}}</script>
      <script type="application/ld+json">{ nope</script>`;
    expect(fromJsonLd(html).offers).toEqual([]);
  });
});

describe("2 · OpenGraph", () => {
  it("reads a product page's price tags", () => {
    expect(brief(fromOpenGraph(fixture("shop-og")))).toEqual([
      ["Elderflower cordial 0.5 l", 649000, "HUF", false, "og"],
    ]);
  });
});

describe("3 · visible price patterns", () => {
  it("reads a price list's rows, ranges as starting prices, a name on the line above", () => {
    const page = extractPage(fixture("salon-pricelist"));
    expect(brief(page.offers)).toEqual([
      ["Ladies cut", 4500, "EUR", false, "pattern"],
      ["Men's cut", 2500, "EUR", false, "pattern"],
      ["Balayage", 11000, "EUR", true, "pattern"],
      ["Highlights", 7000, "EUR", true, "pattern"],
      ["Keratin treatment", 15000, "EUR", false, "pattern"],
    ]);
  });

  it("leaves out delivery thresholds, vouchers and was/now pairs", () => {
    const { offers } = fromPatterns(
      "Free delivery on orders over €50\nGift vouchers from €20\nWas €40 now €30\n20% off colour",
    );
    expect(offers).toEqual([]);
  });

  it("reads currencies written after the number, including zł and Ft", () => {
    const { offers } = fromPatterns("Brows 20 zł\nKids cut 1 200 Ft\nGel nails 35 EUR");
    expect(offers.map((o) => [o.name, o.price.amount_minor, o.price.currency])).toEqual([
      ["Brows", 2000, "PLN"],
      ["Kids cut", 120000, "HUF"],
      ["Gel nails", 3500, "EUR"],
    ]);
  });
});

describe("the order of methods", () => {
  it("lets JSON-LD win over the same offer read off the visible text", () => {
    const page = extractPage(fixture("salon-jsonld"));
    expect(page.offers.find((o) => o.key === offerKey("Cut and colour"))?.method).toBe("jsonld");
    expect(page.offers).toHaveLength(3);
    expect(needsModel(page)).toBe(false);
  });

  it("asks for the model only when prices are on the page but unpaired", () => {
    const page = extractPage(fixture("salon-unstructured"));
    expect(page.offers).toEqual([]);
    expect(page.price_tokens).toBe(3);
    expect(needsModel(page)).toBe(true);
    expect(needsModel(extractPage(fixture("salon-pricelist")))).toBe(false);
  });

  it("gives an offer one key whatever its spelling", () => {
    expect(offerKey("Cut & Colour")).toBe(offerKey("cut and color"));
    expect(offerKey("Crème brûlée")).toBe("creme brulee");
  });
});
