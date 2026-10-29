// I-44.2: the business-type → NACE mapping is data, and it is whole: every
// business_type in the bank has an entry, every code it names is in the
// snapshot, every match says what it covers and every non-match says why.

import { describe, expect, it } from "vitest";
import bank from "../../specs/question-bank-v1.json";
import {
  BENCHMARK_MAP,
  costTreatment,
  geoFor,
  isMapped,
  mappedNaceCodes,
  parentGroup,
  sizeClassesFor,
  sizeWords,
  typeEntry,
} from "./map";
import { SNAPSHOT } from "./snapshot";

const vocab = (bank as unknown as { vocabularies: Record<string, unknown> }).vocabularies;
const TYPES = vocab.business_type as string[];
const CATEGORIES = vocab.cost_category as string[];

describe("the mapping covers the bank (rule 4)", () => {
  it("has an entry for every business_type, and none the bank doesn't have", () => {
    expect(Object.keys(BENCHMARK_MAP.business_types).sort()).toEqual([...TYPES].sort());
  });

  it("gives every match a group and a one-line cover note, and every non-match a reason", () => {
    for (const [type, e] of Object.entries(BENCHMARK_MAP.business_types)) {
      if (e.nace === null) {
        expect(e.why.length, type).toBeGreaterThan(20);
      } else {
        expect(e.group.length, type).toBeGreaterThan(3);
        expect(e.covers, type).toMatch(/NACE [A-Z]/);
      }
    }
  });

  it("names no comparison for nonprofit, other and agriculture", () => {
    for (const t of ["nonprofit", "other", "agriculture"]) {
      expect(isMapped(typeEntry({ code: t })), t).toBe(false);
    }
  });

  it("names only codes the snapshot holds, and the snapshot holds only codes it names", () => {
    expect(mappedNaceCodes()).toEqual(Object.keys(SNAPSHOT.nace).sort());
  });

  it("makes each parent the code one level up", () => {
    for (const e of Object.values(BENCHMARK_MAP.business_types)) {
      if (e.nace === null || e.parent === null) continue;
      expect(e.nace.startsWith(e.parent), e.nace).toBe(true);
      expect(e.nace.length).toBeGreaterThan(e.parent.length);
    }
  });

  it("words every parent, and nothing else", () => {
    const parents = new Set(
      Object.values(BENCHMARK_MAP.business_types).flatMap((e) =>
        e.nace !== null && e.parent !== null ? [e.parent] : [],
      ),
    );
    const worded = Object.keys(BENCHMARK_MAP.parent_groups).filter((k) => k !== "about");
    expect(worded.sort()).toEqual([...parents].sort());
    expect(parentGroup("G47")).toBe("shops");
    expect(parentGroup("ZZ")).toBe("ZZ");
  });

  it("treats every cost category in the bank", () => {
    for (const c of CATEGORIES)
      expect(Object.hasOwn(BENCHMARK_MAP.cost_categories, c), c).toBe(true);
    expect(costTreatment("salaries")).toBe("staff");
    expect(costTreatment("loan_payments")).toBe("financing");
    expect(costTreatment("rent")).toBe("running");
    expect(costTreatment(null)).toBe("running");
    expect(costTreatment("something_new")).toBe("running");
  });

  it("uses only size classes Eurostat names", () => {
    for (const c of BENCHMARK_MAP.size_classes) expect(c.code in SNAPSHOT.sizes, c.code).toBe(true);
    expect(BENCHMARK_MAP.all_sizes.code in SNAPSHOT.sizes).toBe(true);
  });
});

describe("reading a type", () => {
  it("maps the plan's examples", () => {
    expect(typeEntry({ code: "restaurant" })).toMatchObject({ nace: "I56" });
    expect(typeEntry("cafe")).toMatchObject({ nace: "I56" });
    expect(typeEntry({ code: "salon_beauty" })).toMatchObject({ nace: "S96", parent: null });
    expect(typeEntry({ code: "barber" })).toMatchObject({ nace: "S96" });
    expect(typeEntry({ code: "ecommerce_store" })).toMatchObject({ nace: "G479", parent: "G47" });
    expect(typeEntry({ code: "clinic_health" })).toMatchObject({ nace: "Q86" });
  });
  it("returns null for a code it doesn't know, or nothing", () => {
    expect(typeEntry({ code: "spaceport" })).toBeNull();
    expect(typeEntry(null)).toBeNull();
  });
});

describe("the country", () => {
  it("reads an EU member, Greece as EL", () => {
    expect(geoFor("HU")).toEqual({ status: "eu", geo: "HU" });
    expect(geoFor("gr")).toEqual({ status: "eu", geo: "EL" });
  });
  it("says a country outside the EU is outside, and no country is unknown", () => {
    expect(geoFor("GB")).toEqual({ status: "outside", iso: "GB" });
    expect(geoFor("CH")).toEqual({ status: "outside", iso: "CH" });
    expect(geoFor(null)).toEqual({ status: "unknown" });
    expect(geoFor(" ")).toEqual({ status: "unknown" });
  });
});

describe("the size class", () => {
  it("picks from the headcount, narrowest class first", () => {
    expect(sizeClassesFor(1, null)).toEqual({
      codes: ["0_1", "0-9"],
      via: "team_size",
      persons: 1,
    });
    expect(sizeClassesFor(2, "large").codes).toEqual(["2-9", "0-9"]);
    expect(sizeClassesFor(9, null).codes).toEqual(["2-9", "0-9"]);
    expect(sizeClassesFor(10, null).codes).toEqual(["10-19"]);
    expect(sizeClassesFor(49, null).codes).toEqual(["20-49"]);
    expect(sizeClassesFor(50, null).codes).toEqual(["50-249"]);
    expect(sizeClassesFor(400, null).codes).toEqual(["GE250"]);
  });
  it("falls back to the band, and a band spanning two classes picks none", () => {
    expect(sizeClassesFor(null, "small")).toEqual({
      codes: ["2-9", "0-9"],
      via: "size_band",
      persons: null,
    });
    expect(sizeClassesFor(null, "medium")).toEqual({ codes: [], via: "size_band", persons: null });
    expect(sizeClassesFor(null, null)).toEqual({ codes: [], via: "none", persons: null });
    expect(sizeClassesFor(Number.NaN, null).via).toBe("none");
  });
  it("words a class", () => {
    expect(sizeWords("0-9")).toBe("with up to 9 people");
    expect(sizeWords("TOTAL")).toBe("of every size");
  });
});
