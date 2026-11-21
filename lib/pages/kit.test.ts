// Guided page set-up: the kit is the owner's own words, each piece with
// where it came from, and a gap where the fact sheet holds nothing. Pure.

import { describe, expect, it } from "vitest";
import type { KitFacts } from "./kit";
import {
  KIT_FIELDS,
  PAGE_SETUP_LINKS,
  SHORT_LINE_MAX,
  USERNAME_MAX,
  pageKit,
  shortLine,
  usernameIdea,
} from "./kit";

const facts = (over: Partial<KitFacts> = {}): KitFacts => ({
  name: "Emberworks Candles",
  description:
    "We pour small-batch candles that smell like a real fireplace. Two scents sell out every winter, and most of our customers come back for the same one.",
  business_type: "Online shop",
  website: "https://emberworks.example",
  ...over,
});

describe("the short line for a bio", () => {
  it("is the owner's answer as given when it is short already", () => {
    expect(shortLine("Hand-thrown stoneware, made to order.")).toEqual({
      value: "Hand-thrown stoneware, made to order.",
      formula: "as_given",
    });
  });

  it("is the first sentence when the answer runs on", () => {
    const out = shortLine(facts().description as string);
    expect(out).toEqual({
      value: "We pour small-batch candles that smell like a real fireplace.",
      formula: "first_sentence",
    });
  });

  it("cuts a long first sentence at a clause, never in the middle of a word", () => {
    const long =
      "A family bakery in the old town that bakes sourdough every morning, sells out by noon most days and takes orders for weddings, christenings and name days across the county";
    const out = shortLine(long);
    expect(out?.formula).toBe("cut_at_clause");
    expect(out?.value).toBe("A family bakery in the old town that bakes sourdough every morning");
    expect((out?.value ?? "").length).toBeLessThanOrEqual(SHORT_LINE_MAX);
  });

  it("falls back to the last whole word, with nothing hanging off the end", () => {
    const run =
      "Bespoke oak furniture built to measure for small flats where nothing off the shelf will fit the awkward corner by the window";
    const out = shortLine(run);
    expect(out?.formula).toBe("cut_at_word");
    expect((out?.value ?? "").length).toBeLessThanOrEqual(SHORT_LINE_MAX);
    expect(run.startsWith(out?.value ?? "x")).toBe(true);
    expect(run.charAt((out?.value ?? "").length)).toBe(" ");
    expect(out?.value).not.toMatch(/[,;:\s-]$/);
    expect(out?.value).not.toContain("…");
  });

  it("does not take a stop inside an abbreviation for the end of a sentence", () => {
    const out = shortLine(
      "We sell e.g. candles, wax melts and reed diffusers to people who would rather their home smelled of a real fire than of a perfume counter",
    );
    expect(out?.value).not.toBe("We sell e.g.");
    expect((out?.value ?? "").length).toBeGreaterThan(20);
  });

  it("makes nothing of nothing, or of one run with no place to cut", () => {
    expect(shortLine("   ")).toBeNull();
    expect(shortLine("x".repeat(SHORT_LINE_MAX + 20))).toBeNull();
  });
});

describe("an idea for the @name", () => {
  it("is the name in lower case with full stops for spaces and signs", () => {
    expect(usernameIdea("Emberworks Candles")).toBe("emberworks.candles");
    expect(usernameIdea("Fig & Cedar Candle Co.")).toBe("fig.cedar.candle.co");
    expect(usernameIdea("  Café  Zoé!  ")).toBe("cafe.zoe");
  });

  it("drops accents the way people type without them, Hungarian's long ones too", () => {
    expect(usernameIdea("Kézműves Kerámia Műhely")).toBe("kezmuves.keramia.muhely");
    expect(usernameIdea("Straße & Søn Łódź")).toBe("strasse.son.lodz");
  });

  it("stays inside the length, cut at a full stop", () => {
    const idea = usernameIdea("The Very Long Name Of A Small Family Bakery In Budapest");
    expect(idea).toBe("the.very.long.name.of.a.small");
    expect((idea ?? "").length).toBeLessThanOrEqual(USERNAME_MAX);
    expect(idea).not.toMatch(/\.$/);
  });

  it("is nothing for a name with no Latin letters: the owner picks their own", () => {
    expect(usernameIdea("Кофейня")).toBeNull();
    expect(usernameIdea("咖啡馆")).toBeNull();
    expect(usernameIdea("!!")).toBeNull();
  });
});

describe("the kit", () => {
  it("holds each piece with the fact it came from", () => {
    const kit = pageKit(facts());
    expect(kit.name).toEqual({ value: "Emberworks Candles", source_field: "identity.legal_name" });
    expect(kit.category_hint).toEqual({
      value: "Online shop",
      source_field: "identity.business_type",
    });
    expect(kit.about?.source_field).toBe("identity.description");
    expect(kit.about?.value).toContain("Two scents sell out every winter");
    expect(kit.website).toEqual({
      value: "https://emberworks.example",
      source_field: "presence.website_url",
    });
    expect(kit.gaps).toEqual([]);
  });

  it("says how the two worked-out pieces were worked out, and from what", () => {
    const kit = pageKit(facts());
    expect(kit.short_line).toEqual({
      value: "We pour small-batch candles that smell like a real fireplace.",
      derived_from: "identity.description",
      formula: "first_sentence",
    });
    expect(kit.username).toEqual({
      value: "emberworks.candles",
      derived_from: "identity.legal_name",
      formula: "handle",
    });
  });

  it("names a gap, with the question that fills it, and makes nothing up", () => {
    const kit = pageKit(facts({ name: null, description: "  ", business_type: null }));
    expect(kit.name).toBeNull();
    expect(kit.short_line).toBeNull();
    expect(kit.about).toBeNull();
    expect(kit.username).toBeNull();
    expect(kit.category_hint).toBeNull();
    expect(kit.gaps).toEqual([
      { key: "name", field: "identity.legal_name", question: "1.1" },
      { key: "business_type", field: "identity.business_type", question: "1.2" },
      { key: "description", field: "identity.description", question: "1.3" },
    ]);
  });

  it("never counts a missing website as a gap: a business may have none", () => {
    const kit = pageKit(facts({ website: null }));
    expect(kit.website).toBeNull();
    expect(kit.gaps).toEqual([]);
  });

  it("asks the interview's own questions, and sends the owner only to the platforms' own pages", () => {
    expect(Object.values(KIT_FIELDS).map((f) => f.question)).toEqual([
      "1.1",
      "1.3",
      "1.2",
      "2.1.2.1",
    ]);
    for (const url of Object.values(PAGE_SETUP_LINKS)) {
      expect(new URL(url).protocol).toBe("https:");
      expect(new URL(url).hostname).toMatch(/(^|\.)(facebook|instagram)\.com$/);
    }
  });
});
