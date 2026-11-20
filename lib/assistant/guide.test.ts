// Lex's guide to ScaleX (lib/assistant/guide.ts): what holds it to the app.
// A screen the menu lists must be in the guide, a guide entry must be a real
// screen, and only the guide's own screens ever become links in a reply.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { placeFor } from "../../components/nav/AppFrame";
import { GUIDE, guideText, linksIn, screenFor, withoutCitations } from "./guide";

const ROOT = process.cwd();
const english = JSON.parse(readFileSync(join(ROOT, "messages", "en.json"), "utf8")) as {
  nav: { item: Record<string, string> };
};

describe("the guide covers the app", () => {
  it("has an entry for every screen the menu names", () => {
    const covered = new Set(GUIDE.map((s) => s.nav).filter((n): n is string => n !== null));
    const missing = Object.keys(english.nav.item).filter((key) => !covered.has(key));
    // A screen added to the menu without a line here is one Lex cannot guide anyone to.
    expect(missing).toEqual([]);
  });

  it("names each screen as the menu does, and points at a page that exists", () => {
    for (const s of GUIDE) {
      const page = join(ROOT, "app", ...s.route.split("/").filter(Boolean), "page.tsx");
      expect(existsSync(page), `${s.name} → ${s.route}`).toBe(true);
      if (s.nav !== null) expect(english.nav.item[s.nav], s.route).toBe(s.name);
    }
  });

  it("says where each screen sits as the menu has it", () => {
    // Lex told people Customers opened from the business's name; it is under Grow.
    const WORDS: Record<string, string> = {
      home: "Home",
      decisions: "Decisions",
      insights: "Insights",
      grow: "Grow",
      business: "Your business",
    };
    for (const s of GUIDE) {
      if (s.nav === null) continue;
      const place = placeFor(s.route);
      expect(place, s.route).not.toBeNull();
      expect(s.place.startsWith(WORDS[place as string] as string), `${s.name}: ${s.place}`).toBe(
        true,
      );
    }
    expect(guideText()).toContain(
      "Customers, Reviews, Abandoned carts, Pipeline and Support are under Grow",
    );
  });

  it("lists no screen twice, and says what each is for", () => {
    expect(new Set(GUIDE.map((s) => s.route)).size).toBe(GUIDE.length);
    for (const s of GUIDE) {
      expect(s.what.length, s.route).toBeGreaterThan(20);
      // The app prints no long dash (L7), and Lex repeats what it is given.
      expect(`${s.what} ${(s.how ?? []).join(" ")}`, s.route).not.toMatch(/[–—]/);
    }
  });
});

describe("the block Lex's answers are given", () => {
  it("holds every screen with its path, and how the interview is answered", () => {
    const text = guideText();
    for (const s of GUIDE) expect(text).toContain(`${s.name} [${s.route}]`);
    expect(text).toContain("I don't know");
    expect(text).toContain("Skip for now");
    expect(text).toContain("Stop everything");
  });

  it("is the same text every time, so it can be read from cache", () => {
    expect(guideText()).toBe(guideText());
  });
});

describe("the screen an address belongs to", () => {
  it("finds a screen by its own address or a page under it", () => {
    expect(screenFor("/cash")?.name).toBe("Cash flow");
    expect(screenFor("/settings/team")?.name).toBe("Team access");
    expect(screenFor("/profile?tab=charts")?.name).toBe("Fact sheet");
    expect(screenFor("/proposals/abc-123")?.name).toBe("Waiting for you");
  });

  it("knows no screen for an address outside the guide", () => {
    expect(screenFor("/cashier")).toBeNull(); // only starts alike
    expect(screenFor("/ops")).toBeNull();
    expect(screenFor("https://example.com/cash")).toBeNull();
    expect(screenFor(null)).toBeNull();
    expect(screenFor("")).toBeNull();
  });
});

describe("the screens a reply names", () => {
  it("become links: the guide's own, in order, each once", () => {
    const reply =
      "1. Open Connections [/connections].\n2. Then look at Cash flow [/cash] and Connections [/connections] again.";
    expect(linksIn(reply).map((s) => s.route)).toEqual(["/connections", "/cash"]);
  });

  it("never make a link of anything else a model writes in brackets", () => {
    expect(linksIn("See [/ops] or [https://evil.example] or [/api/chat] or [1].")).toEqual([]);
    expect(linksIn("No screen is named here.")).toEqual([]);
  });

  it("are taken out of the words that are read, and only they are", () => {
    expect(withoutCitations("Open Connections [/connections], then sign in.")).toBe(
      "Open Connections, then sign in.",
    );
    expect(withoutCitations("1. Go to Stock [/stock].\n2. Press Why.")).toBe(
      "1. Go to Stock.\n2. Press Why.",
    );
    // A bracket that is not one of the guide's screens is the model's own text.
    expect(withoutCitations("The range [low to high] is shown.")).toBe(
      "The range [low to high] is shown.",
    );
    expect(withoutCitations("Try [/nowhere].")).toBe("Try [/nowhere].");
  });
});
