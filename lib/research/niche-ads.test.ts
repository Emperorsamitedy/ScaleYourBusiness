// P3-50 — the analysis. Deterministic: staying power from running time
// and versions, with the arithmetic in words; near-identical versions
// grouped per page; hooks, offers and calls to action by pattern, null
// when none is found.

import { describe, expect, it } from "vitest";
import type { LibraryAd } from "./ad-library";
import { parseAd } from "./ad-library";
import { ceramicsNiche } from "./ad-library-fake";
import {
  ctaOf,
  groupVersions,
  hookOf,
  offerOf,
  rankNicheAds,
  runningDays,
  stayingPower,
  wordOverlap,
} from "./niche-ads";

const TODAY = "2026-10-26";

function ads(): LibraryAd[] {
  return ceramicsNiche(TODAY)
    .filter((a) => a.countries.includes("IE"))
    .map((a) =>
      parseAd(
        {
          id: a.id,
          page_id: a.page_id,
          page_name: a.page_name,
          ad_creative_bodies: a.bodies,
          ad_creative_link_titles: a.titles,
          ad_delivery_start_time: a.start,
          ad_delivery_stop_time: a.stop ?? undefined,
          publisher_platforms: a.platforms,
        },
        a.media,
        { kind: "term", term: "mug" },
      )!,
    );
}

describe("P3-50 — running time and versions", () => {
  it("counts the first day, and runs to the read while still live", () => {
    expect(runningDays({ started: "2026-10-20", stopped: "2026-10-20" }, TODAY)).toBe(1);
    expect(runningDays({ started: "2026-10-20", stopped: "2026-10-22" }, TODAY)).toBe(3);
    expect(runningDays({ started: "2026-10-20", stopped: null }, TODAY)).toBe(7);
  });

  it("scores staying power with its arithmetic, versions capped at five", () => {
    expect(stayingPower(100, 1)).toEqual({
      score: 100,
      arithmetic: "100 days × (1 + ¼ × (1 version − 1)) = 100",
    });
    expect(stayingPower(100, 3).score).toBe(150);
    expect(stayingPower(100, 9).score).toBe(200);
  });

  it("groups near-identical versions of one page, and keeps other pages apart", () => {
    const groups = groupVersions(ads());
    const saltmarsh = groups.find((g) => g[0]!.page_name === "Saltmarsh Pottery");
    expect(saltmarsh?.map((a) => a.id).sort()).toEqual([
      "910000000000001",
      "910000000000002",
      "910000000000003",
    ]);
    const wheelhouse = groups.filter((g) => g[0]!.page_name === "The Wheelhouse Ceramics");
    expect(wheelhouse).toHaveLength(2); // a mug ad and a class voucher are different concepts
  });

  it("measures word overlap symmetrically, and two empty texts are not alike", () => {
    expect(wordOverlap("a b c", "a b c")).toBe(1);
    expect(wordOverlap("a b", "c d")).toBe(0);
    expect(wordOverlap("", "")).toBe(0);
  });

  it("ranks the long-running, many-version concept first; short tests last", () => {
    const ranked = rankNicheAds(ads(), TODAY);
    expect(ranked[0]!.page_name).toBe("Saltmarsh Pottery");
    expect(ranked[0]!.versions).toBe(3);
    expect(ranked[0]!.running_days).toBe(143);
    expect(ranked[0]!.active).toBe(true);
    expect(ranked[0]!.format).toBe("video");
    expect(ranked[0]!.library_url).toBe("https://www.facebook.com/ads/library/?id=910000000000001");
    expect(ranked[0]!.arithmetic).toContain("143 days");
    // The two week-long tests that stopped come last, tied on 8 days, by name.
    expect(ranked.slice(-2).map((g) => [g.page_name, g.running_days, g.active])).toEqual([
      ["Hollow Oak Homeware", 8, false],
      ["Kiln Lane Studio", 8, false],
    ]);
    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  });

  it("limits the list when asked", () => {
    expect(rankNicheAds(ads(), TODAY, { limit: 2 })).toHaveLength(2);
  });
});

describe("P3-50 — hooks, offers and calls to action", () => {
  it("the hook is the first line, cut to a sentence when long", () => {
    expect(hookOf("First line here.\nSecond line.")).toBe("First line here.");
    expect(hookOf("")).toBeNull();
    const long = `This is a long opening sentence that keeps going for a while. ${"and more words ".repeat(12)}`;
    expect(hookOf(long)).toBe("This is a long opening sentence that keeps going for a while.");
    const noStop = "word ".repeat(60).trim();
    expect(hookOf(noStop)!.length).toBeLessThanOrEqual(140);
    expect(hookOf(noStop)!.endsWith("…")).toBe(true);
  });

  it("finds offers by plain patterns, and returns null when there is none", () => {
    expect(
      offerOf({
        body: "Seconds sale: 30% off mugs with tiny glaze quirks.\nEnds Sunday.",
        title: null,
      }),
    ).toBe("Seconds sale: 30% off mugs with tiny glaze quirks.");
    expect(
      offerOf({ body: "Lovely mugs. Free EU shipping over €60. Shop now.", title: null }),
    ).toBe("Free EU shipping over €60.");
    expect(offerOf({ body: "Handmade-look mugs, 4 for €40.", title: null })).toBe(
      "Handmade-look mugs, 4 for €40.",
    );
    expect(
      offerOf({ body: "POV: you open the kiln and nothing cracked.", title: "Back again" }),
    ).toBeNull();
  });

  it("finds the last call to action, capitalised, or null", () => {
    expect(ctaOf({ body: "Learn more about us. Then shop now.", title: null })).toBe("Shop now");
    expect(ctaOf({ body: "Two hours at the wheel. Book now.", title: null })).toBe("Book now");
    expect(ctaOf({ body: "We discovered clay in 2019.", title: null })).toBeNull();
    expect(ctaOf({ body: "Nothing to do here.", title: null })).toBeNull();
  });
});
