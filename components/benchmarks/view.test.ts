// /benchmarks' words (idea 44, I-44.4): the head names the cell, the foot
// names the source and its dates, and no sentence judges.

import { describe, expect, it } from "vitest";
import type { BenchInputs, BenchResult, ComparedLine } from "../../lib/benchmarks/compare";
import { CAVEAT, compareWithSimilar } from "../../lib/benchmarks/compare";
import { SNAPSHOT } from "../../lib/benchmarks/snapshot";
import {
  comparedCount,
  dateWords,
  footLine,
  headline,
  lineSentence,
  readingWord,
  sizeNote,
} from "./view";

const fernhillish: BenchInputs = {
  as_of: "2026-10-29",
  business_type: { code: "ecommerce_store" },
  country: { raw: "Ireland", iso: "IE" },
  team_size: { value: 2, basis: "STATED", source: "as you told me" },
  size_band: null,
  revenue: {
    amount_minor: 3_800_000,
    currency: "EUR",
    basis: "OBSERVED",
    source: "measured",
    on: null,
  },
  orders_month: null,
  gross_margin: { value: 62, basis: "ESTIMATED", source: "your estimate" },
  offers: [],
  costs: [],
  staff: null,
};

describe("the head", () => {
  it("is the cell in words", () => {
    expect(headline(compareWithSimilar(fernhillish))).toBe(
      "Compared with online and mail-order shops with up to 9 people in Ireland.",
    );
  });
  it("says what stops the comparison", () => {
    const outside: BenchResult = {
      status: "outside_eu",
      country: "Norway",
      why: "",
    };
    expect(headline(outside)).toBe("Eurostat doesn't cover Norway.");
    expect(headline({ status: "unmapped", type_code: "other", why: "" })).toBe(
      "There's no Eurostat comparison for this kind of business.",
    );
  });
});

describe("the foot", () => {
  it("names the dataset, both dates, the reuse terms and the caveat", () => {
    expect(footLine(SNAPSHOT.source, CAVEAT)).toBe(
      "Source: Eurostat, sbs_sc_ovw (doi.org/10.2908/SBS_SC_OVW), updated 30 Sep 2026, retrieved 29 Oct 2026, reused with the source acknowledged. I keep each group's latest year and convert euros to your currency; Eurostat isn't responsible for that. These are totals across every business in the group, not a typical business.",
    );
  });
  it("words a date, and leaves a malformed one alone", () => {
    expect(dateWords("2026-09-30")).toBe("30 Sep 2026");
    expect(dateWords("soon")).toBe("soon");
  });
});

describe("the lines", () => {
  const r = compareWithSimilar(fernhillish);
  if (r.status !== "ready") throw new Error(r.status);

  it("states both figures and the gap, and never advises", () => {
    const t = r.lines.find((l) => l.key === "turnover_per_person") as ComparedLine;
    expect(lineSentence(t)).toMatch(
      /^Yours is €228,000, theirs €730,550: €502,550 \(69%\) below\.$/,
    );
    const all = r.lines
      .map((l) => (l.status === "compared" ? lineSentence(l) + l.gap_note : l.why + l.gap_note))
      .join(" ");
    expect(all).not.toMatch(/\byou should\b|\bbetter\b|\bworse\b|\bgood\b|\bbad\b|\bscore\b/i);
  });

  it("words each reading", () => {
    expect(r.lines.map(readingWord)).toEqual(["NOT YET", "BELOW", "NOT YET"]);
    expect(comparedCount(r)).toBe("1 of 3 compared");
  });

  it("says when the size is unknown", () => {
    expect(sizeNote(r)).toBeNull();
    expect(sizeNote(compareWithSimilar({ ...fernhillish, team_size: null }))).toBe(
      "I don't know how many people work in the business, so the group is every size.",
    );
  });
});
