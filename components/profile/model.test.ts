// The fact sheet's rules, each with a passing and a failing case: facts
// filed under their section (entities included), the design's basis
// words without hiding an estimate, the source in words, a gap shown as
// what it is (rule 5), and the filters.

import { describe, expect, it } from "vitest";
import type { FactRow, FactSheet } from "./model";
import {
  LONG_VALUE,
  basisCounts,
  basisSegs,
  basisWord,
  changedIn,
  currentSection,
  displaySections,
  filterSections,
  focusSection,
  isLongValue,
  partFromSearch,
  sourceText,
  valueView,
} from "./model";

const fact = (key: string, over: Partial<FactRow> = {}): FactRow => ({
  key,
  value: "x",
  status: "answered",
  confidence: 0.8,
  source_kind: "owner_input",
  source_detail: null,
  observed_at: "2026-10-03T00:00:00Z",
  note: null,
  ...over,
});

const CH = "channels.26c8cb8f-76b6-48c8-b529-56a040357694";

const sheet: FactSheet = {
  profile_id: "p",
  snapshot_id: "s",
  taken_at: "2026-10-17T00:00:00Z",
  fact_count: 5,
  completeness: { overall: 0.4, core_complete: false },
  provenance: [],
  sections: [
    { section: "legal", facts: [fact("legal.country", { value: "Hungary" })] },
    {
      section: "identity",
      facts: [fact("identity.business_name", { value: "Ember & Oak" })],
    },
    {
      section: "presence",
      facts: [
        fact("presence.timezone", {
          status: "inferred",
          source_kind: "inferred",
          source_detail: "single-zone-country-map-v1",
        }),
        fact("presence.hour_cost", { source_kind: "system_default", status: "answered" }),
      ],
    },
  ],
  entities: [
    {
      id: CH,
      spine: "channels",
      name: null,
      facts: [fact("platform", { value: "instagram" }), fact("type", { value: "social organic" })],
    },
  ],
  gaps: [],
  changed: ["presence.timezone"],
};

describe("displaySections — every fact filed, sections in the data model's order", () => {
  it("orders sections by the data model and names them in the owner's words", () => {
    const s = displaySections(sheet);
    expect(s.map((x) => x.section)).toEqual(["identity", "presence", "channels", "legal"]);
    expect(s[0]!.label).toBe("Who you are");
    expect(s[0]!.facts[0]!.label).toBe("Business name");
  });

  it("files an entity's facts under its spine's section, keyed by the full field key", () => {
    const channels = displaySections(sheet).find((x) => x.section === "channels")!;
    expect(channels.facts.map((f) => f.key)).toEqual([`${CH}.platform`, `${CH}.type`]);
    // a channel has no name: its platform names it
    expect(channels.facts[1]!.label).toBe("Instagram · type");
  });
});

describe("basisWord — the design's words, an estimate never shown as exact", () => {
  it("reads the owner's exact answer FROM YOU, and an estimate as one", () => {
    expect(basisWord(fact("a.b"))).toMatchObject({ word: "FROM YOU", tone: "you" });
    expect(basisWord(fact("a.b", { note: "owner marked as estimate" })).word).toBe(
      "FROM YOU · EST.",
    );
  });
  it("prints OBSERVED / DERIVED / ASSUMED from the source, and a gap's status otherwise", () => {
    expect(basisWord(fact("a.b", { source_kind: "connector" })).word).toBe("OBSERVED");
    expect(basisWord(fact("a.b", { status: "inferred", source_kind: "inferred" })).word).toBe(
      "DERIVED",
    );
    expect(basisWord(fact("a.b", { source_kind: "system_default" }))).toMatchObject({
      word: "ASSUMED",
      tone: "drift",
    });
    expect(basisWord(fact("a.b", { value: null, status: "unknown" }))).toMatchObject({
      word: "NOT KNOWN",
      basis: null,
    });
  });
  it("counts the head line's classes, gaps apart", () => {
    const all = displaySections(sheet).flatMap((s) => s.facts.map((d) => d.fact));
    expect(basisCounts(all)).toEqual({ observed: 0, derived: 1, fromYou: 4, assumed: 1, gaps: 0 });
    expect(basisCounts([fact("a.b", { value: null, status: "skipped" })]).gaps).toBe(1);
  });
});

describe("basisSegs — the head line as one bar", () => {
  const gap = (status: string) => fact("a.b", { value: null, status });
  const facts = [
    fact("a.b", { source_kind: "connector" }),
    fact("a.b", { source_kind: "connector" }),
    fact("a.b", { status: "inferred", source_kind: "inferred" }),
    fact("a.b"),
    fact("a.b", { note: "owner marked as estimate" }),
    fact("a.b", { source_kind: "system_default" }),
    gap("unasked"),
    gap("unknown"),
    gap("skipped"),
    gap("unknown"),
  ];

  it("draws a segment per basis in the line's order, in the basis column's words", () => {
    expect(basisSegs(facts).slice(0, 5)).toEqual([
      { key: "OBSERVED", label: "OBSERVED", value: 2, tone: "ink" },
      { key: "DERIVED", label: "DERIVED", value: 1, tone: "ink2" },
      { key: "STATED", label: "FROM YOU", value: 1, tone: "hollow" },
      { key: "ESTIMATED", label: "FROM YOU · EST.", value: 1, tone: "okband" },
      { key: "ASSUMED", label: "ASSUMED", value: 1, tone: "faint" },
    ]);
  });

  it("keeps not known, skipped and not asked as separate segments (rule 5)", () => {
    expect(basisSegs(facts).slice(5)).toEqual([
      { key: "gap.unknown", label: "NOT KNOWN", value: 2, tone: "soft" },
      { key: "gap.skipped", label: "SKIPPED", value: 1, tone: "soft" },
      { key: "gap.unasked", label: "NOT ASKED", value: 1, tone: "soft" },
    ]);
  });

  it("adds up to the line's counts, and draws no segment for a class with no facts", () => {
    const c = basisCounts(facts);
    const of = (...keys: string[]) =>
      basisSegs(facts)
        .filter((s) => keys.includes(s.key))
        .reduce((n, s) => n + s.value, 0);
    expect(of("STATED", "ESTIMATED")).toBe(c.fromYou);
    expect(of("gap.unknown", "gap.skipped", "gap.unasked")).toBe(c.gaps);
    expect(basisSegs([fact("a.b")]).map((s) => s.key)).toEqual(["STATED"]);
    expect(basisSegs([])).toEqual([]);
  });
});

describe("sourceText and valueView", () => {
  it("names the source in words, with what it points at", () => {
    expect(sourceText(fact("a.b"))).toBe("you · interview");
    expect(sourceText({ source_kind: "web_research", source_detail: "https://www.x.hu/" })).toBe(
      "researched · x.hu",
    );
    expect(sourceText({ source_kind: "inferred", source_detail: "price − cost" })).toBe(
      "computed · price − cost",
    );
    expect(sourceText({ source_kind: "connector", source_detail: null })).toBe(
      "measured · connected account",
    );
  });
  it("sets money and numbers as figures, keeps words as words, and shows a gap as what it is", () => {
    expect(valueView(fact("a.b", { value: "4 090 EUR" }))).toEqual({
      text: "€4,090",
      figure: true,
      gap: false,
    });
    expect(valueView(fact("a.b", { value: "Hungary" })).figure).toBe(false);
    expect(valueView(fact("a.b", { value: null, status: "unknown" }))).toMatchObject({
      text: "you didn't know, recorded",
      gap: true,
    });
    expect(valueView(fact("a.b", { value: null, status: "skipped" })).text).toBe("skipped for now");
  });
});

describe("filterSections — the design's filters over a search", () => {
  const sections = displaySections(sheet);
  const changed = new Set(sheet.changed);

  it("ALL with no query keeps everything", () => {
    expect(filterSections(sections, { mode: "all", query: "", changed })).toHaveLength(4);
  });
  it("ASSUMED keeps only facts on an assumption", () => {
    const out = filterSections(sections, { mode: "assumed", query: "", changed });
    expect(out.flatMap((s) => s.facts.map((f) => f.key))).toEqual(["presence.hour_cost"]);
  });
  it("CHANGED keeps only facts replaced this month", () => {
    const out = filterSections(sections, { mode: "changed", query: "", changed });
    expect(out.flatMap((s) => s.facts.map((f) => f.key))).toEqual(["presence.timezone"]);
    expect(changedIn(sections[1]!, changed)).toBe(1);
    expect(changedIn(sections[0]!, changed)).toBe(0);
  });
  it("the query matches label, value, source, basis or section; no match drops the section", () => {
    const q = (query: string) =>
      filterSections(sections, { mode: "all", query, changed }).flatMap((s) =>
        s.facts.map((f) => f.key),
      );
    expect(q("hungary")).toEqual(["legal.country"]);
    expect(q("instagram")).toEqual([`${CH}.platform`, `${CH}.type`]);
    expect(q("derived")).toEqual(["presence.timezone"]);
    expect(q("who you are")).toEqual(["identity.business_name"]);
    expect(q("nothing like this")).toEqual([]);
  });
});

describe("the screen's two parts", () => {
  it("opens on the record, and on the charts only when the address asks", () => {
    expect(partFromSearch("")).toBe("record");
    expect(partFromSearch("?tab=charts")).toBe("charts");
    expect(partFromSearch("?ask=1&tab=charts")).toBe("charts");
  });

  it("an unknown part is the record, never a blank screen", () => {
    expect(partFromSearch("?tab=history")).toBe("record");
    expect(partFromSearch("?tab=")).toBe("record");
  });
});

describe("a long written answer", () => {
  it("is folded once it runs past a line or two", () => {
    expect(isLongValue({ text: "x".repeat(LONG_VALUE + 1), figure: false })).toBe(true);
  });

  it("a short answer and a figure are shown whole", () => {
    expect(isLongValue({ text: "Online shop", figure: false })).toBe(false);
    expect(isLongValue({ text: "x".repeat(LONG_VALUE), figure: false })).toBe(false);
    expect(isLongValue({ text: "9".repeat(LONG_VALUE + 30), figure: true })).toBe(false);
  });
});

describe("the section a narrow screen shows", () => {
  const listed = ["fs-identity", "fs-offers", "fs-open"];

  it("is the reader's pick while it is listed", () => {
    expect(currentSection(listed, "fs-offers", "fs-identity")).toBe("fs-offers");
  });

  it("falls back to the section an address asks for, then to the first", () => {
    expect(currentSection(listed, "", "fs-offers")).toBe("fs-offers");
    expect(currentSection(listed, "", null)).toBe("fs-identity");
    // A pick the filter has taken off the list does not leave the screen empty.
    expect(currentSection(listed, "fs-costs", null)).toBe("fs-identity");
    expect(currentSection(listed, "", "fs-costs")).toBe("fs-identity");
    expect(currentSection([], "fs-offers", null)).toBeNull();
  });

  it("finds the section that holds a focused fact, and only a fact", () => {
    const sections = [
      {
        section: "identity",
        label: "Who you are",
        facts: [{ key: "identity.size_band", label: "Size", fact: fact("identity.size_band") }],
      },
      {
        section: "presence",
        label: "Where you trade",
        facts: [
          { key: "presence.opening_hours", label: "Hours", fact: fact("presence.opening_hours") },
        ],
      },
    ];
    expect(focusSection("?focus=fact-presence.opening_hours", sections)).toBe("presence");
    expect(focusSection("?focus=fact-nothing.here", sections)).toBeNull();
    expect(focusSection("?focus=stop", sections)).toBeNull();
    expect(focusSection("", sections)).toBeNull();
  });
});
