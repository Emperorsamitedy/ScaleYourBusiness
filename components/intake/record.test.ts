import { describe, expect, it } from "vitest";
import type { IntakeArea, IntakeRecord, RecordFact } from "@/lib/intake/types";
import { beat, parseCssMs } from "./motion";
import {
  AREA_NAME,
  SECONDS_PER_QUESTION,
  areaAskable,
  areaPercent,
  areaStatusWord,
  channelNo,
  connectorLegend,
  dialPoint,
  leftInArea,
  measuredOnly,
  minutesFor,
  moneyReference,
  optionColumns,
  parseRecordedAt,
  previousQuestion,
  readinessCells,
  rulerScale,
  tapeEntries,
  tapeStamp,
  tileColumns,
  basisWord,
  currencyMark,
  factCountText,
  factLabel,
  factValue,
  keyHint,
  numberKeyIndex,
  provenanceLines,
  sourceWord,
} from "./record";

const fact = (over: Partial<RecordFact>): RecordFact => ({
  key: "revenue.monthly_revenue",
  entity: null,
  field: "revenue.monthly_revenue",
  value: null,
  text: null,
  status: "answered",
  source_kind: "owner_input",
  provider: null,
  note: null,
  confidence: 0.75,
  observed_at: "2026-10-17 10:00:00+00",
  recorded_at: "2026-10-17 10:00:00+00",
  method: null,
  question_id: null,
  ...over,
});

const area = (over: Partial<IntakeArea>): IntakeArea => ({
  section: "operations",
  status: "not_started",
  needs: null,
  answered: 0,
  open: 3,
  skipped: 0,
  bars: ["open", "open", "open"],
  ...over,
});

describe("area tiles", () => {
  it("names every profile section in plain words", () => {
    expect(Object.keys(AREA_NAME)).toHaveLength(14);
    expect(AREA_NAME.identity).toBe("Store basics");
    expect(AREA_NAME.operations).toBe("Shipping & fulfilment");
  });

  it("words each status; a blocked area names the channel it needs", () => {
    const channelOf = (section: string) => (section === "offers" ? "03" : null);
    expect(areaStatusWord(area({ status: "completed" }))).toEqual({ word: "Done", tone: "ok" });
    expect(areaStatusWord(area({ status: "in_progress" })).word).toBe("In progress");
    expect(areaStatusWord(area({ status: "not_started" })).word).toBe("Not started");
    expect(areaStatusWord(area({ status: "blocked", needs: "offers" }), { channelOf })).toEqual({
      word: "Needs CH 03",
      tone: "drift",
    });
    // With no channel to name, the area's own name stands in.
    expect(areaStatusWord(area({ status: "blocked", needs: "operations" })).word).toBe(
      "Needs Shipping & fulfilment",
    );
  });

  it("the area being asked is MEASURING, whatever its status", () => {
    expect(areaStatusWord(area({ status: "completed" }), { active: true })).toEqual({
      word: "Measuring",
      tone: "live",
    });
    expect(areaStatusWord(area({ status: "in_progress" }), { active: false }).word).not.toBe(
      "Measuring",
    );
  });

  it("READ ONLY passes when every response in an unfinished area was measured", () => {
    const measured = area({
      status: "in_progress",
      answered: 2,
      open: 1,
      bars: ["measured", "measured", "open"],
    });
    expect(measuredOnly(measured)).toBe(true);
    expect(areaStatusWord(measured).word).toBe("Read only");
  });

  it("READ ONLY fails when one response came from the owner, or there are none", () => {
    const mixed = area({
      status: "in_progress",
      answered: 2,
      open: 1,
      bars: ["measured", "owner", "open"],
    });
    expect(measuredOnly(mixed)).toBe(false);
    expect(areaStatusWord(mixed).word).toBe("In progress");
    expect(measuredOnly(area({ bars: ["open", "skipped"] }))).toBe(false);
    // An explicit unknown is a response, and not a measured one (rule 5).
    expect(measuredOnly(area({ bars: ["measured", "unknown"] }))).toBe(false);
  });

  it("numbers channels from one, two digits", () => {
    expect(channelNo(0)).toBe("01");
    expect(channelNo(13)).toBe("14");
  });

  it("percent counts responses over applicable questions; an empty area is 0, not NaN", () => {
    expect(areaPercent({ answered: 5, open: 7, skipped: 0 })).toBe(42);
    expect(areaPercent({ answered: 3, open: 0, skipped: 0 })).toBe(100);
    expect(areaPercent({ answered: 0, open: 0, skipped: 0 })).toBe(0);
    // A skip holds the percentage down: it is not a response.
    expect(areaPercent({ answered: 1, open: 0, skipped: 1 })).toBe(50);
  });

  it("left in the area counts open and skipped questions; minutes say 'about', rounded up", () => {
    expect(leftInArea({ open: 3, skipped: 1 })).toBe(4);
    expect(minutesFor(4)).toBe(Math.ceil((4 * SECONDS_PER_QUESTION) / 60));
    expect(minutesFor(1)).toBe(1);
    expect(minutesFor(0)).toBe(0);
  });

  it("lays out one row up to ten tiles, two balanced rows past that", () => {
    expect(tileColumns(9)).toBe(9);
    expect(tileColumns(10)).toBe(10);
    expect(tileColumns(14)).toBe(7);
    expect(tileColumns(13)).toBe(7);
    expect(tileColumns(0)).toBe(1);
  });

  it("names the connector from the record's sources, or says 'a connection'", () => {
    expect(connectorLegend([{ kind: "connector", provider: "Shopify", count: 10 }])).toBe(
      "Shopify",
    );
    expect(
      connectorLegend([
        { kind: "owner_input", provider: null, count: 300 },
        { kind: "connector", provider: "Shopify", count: 10 },
        { kind: "connector", provider: "Google Analytics", count: 6 },
        { kind: "connector", provider: "Meta Ads", count: 2 },
      ]),
    ).toBe("Shopify, Google Analytics +1");
    expect(connectorLegend([{ kind: "owner_input", provider: null, count: 3 }])).toBe(
      "a connection",
    );
  });

  it("a tile is a choice only while its area has something to ask", () => {
    expect(areaAskable(area({ open: 2 }))).toBe(true);
    expect(areaAskable(area({ open: 0, skipped: 1 }))).toBe(true);
    expect(areaAskable(area({ status: "blocked", open: 0 }))).toBe(false);
    expect(areaAskable(area({ status: "completed", open: 0, answered: 4 }))).toBe(false);
  });
});

describe("record rows", () => {
  it("prints money through num.ts, with comma grouping", () => {
    const v = factValue(fact({ value: { amount_minor: 4126000, currency: "EUR" } }));
    expect(v).toEqual({ text: "€41,260", full: "€41,260", figure: true });
    expect(factValue(fact({ value: { amount_minor: 938, currency: "EUR" } })).text).toBe("€9.38");
  });

  it("prints numbers grouped and keeps gaps as what they are (rule 5)", () => {
    expect(factValue(fact({ value: 1612 })).text).toBe("1,612");
    expect(factValue(fact({ status: "unknown" })).text).toBe("not known");
    expect(factValue(fact({ status: "skipped" })).text).toBe("skipped");
    expect(factValue(fact({ status: "unknown" })).text).not.toBe(
      factValue(fact({ status: "skipped" })).text,
    );
  });

  it("never dumps structured values as JSON, and truncates long text", () => {
    expect(factValue(fact({ value: { days: {} }, text: '{"days":{}}' })).text).toBe("on file");
    const long = "a".repeat(80);
    const v = factValue(fact({ value: long, text: long }));
    expect(v.text.length).toBeLessThanOrEqual(44);
    expect(v.full).toBe(long);
  });

  it("labels a fact by its key, or its entity's name", () => {
    expect(factLabel(fact({}))).toBe("Monthly revenue");
    expect(factLabel(fact({ entity: "Mug", field: "price" }))).toBe("Mug · price");
    const unnamed = fact({
      key: "channels.3292915d-fc88-4b69-8c9e-e6dfbf82cdf7.platform",
      field: "platform",
    });
    expect(factLabel(unnamed)).toBe("Channels · platform");
    // A lone word keeps its section.
    expect(factLabel(fact({ key: "presence.type", field: "presence.type" }))).toBe(
      "Presence · type",
    );
  });

  it("names the source in the owner's words", () => {
    expect(sourceWord({ source_kind: "connector", provider: "Shopify" })).toBe("Shopify");
    expect(sourceWord({ source_kind: "owner_input", provider: null })).toBe("you");
    expect(sourceWord({ source_kind: "inferred", provider: null })).toBe("worked out");
  });

  it("prints a basis class from what produced the fact, or the gap's word", () => {
    expect(basisWord(fact({ source_kind: "connector", status: "inferred" }))).toBe("OBSERVED");
    expect(basisWord(fact({ source_kind: "inferred", status: "inferred" }))).toBe("DERIVED");
    expect(basisWord(fact({ note: "owner marked as estimate", confidence: 0.55 }))).toBe(
      "ESTIMATED",
    );
    expect(basisWord(fact({}))).toBe("STATED");
    expect(basisWord(fact({ status: "unknown" }))).toBe("NOT KNOWN");
  });
});

describe("the record's provenance line", () => {
  const record = (over: Partial<IntakeRecord>): IntakeRecord => ({
    fact_count: 0,
    sources: [],
    not_known: 0,
    skipped: 0,
    facts: [],
    more: 0,
    derived: [],
    ...over,
  });

  it("counts by real source, owner sources merged as 'from you'", () => {
    const lines = provenanceLines(
      record({
        sources: [
          { kind: "connector", provider: "Shopify", count: 31 },
          { kind: "owner_input", provider: null, count: 14 },
          { kind: "conversation", provider: null, count: 2 },
        ],
      }),
    );
    expect(lines).toEqual(["31 read from Shopify · 16 from you"]);
  });

  it("names unknowns and skips apart, and only when there are some", () => {
    expect(provenanceLines(record({ not_known: 2, skipped: 1 }))).toEqual([
      "2 not known yet · 1 skipped for now",
    ]);
    expect(provenanceLines(record({}))).toEqual([]);
  });

  it("says the count in words with a grouped figure", () => {
    expect(factCountText(1)).toBe("1 fact on file");
    expect(factCountText(1047)).toBe("1,047 facts on file");
  });
});

describe("the money field", () => {
  it("reads the currency mark and its side from num.ts", () => {
    expect(currencyMark("EUR")).toEqual({ mark: "€", before: true });
    expect(currencyMark("HUF")).toEqual({ mark: "HUF", before: false });
  });
});

describe("keys", () => {
  const none = { ctrl: false, meta: false, alt: false };

  it("1–9 pick a row when the owner is not typing", () => {
    expect(numberKeyIndex("1", { tagName: "BUTTON" }, none)).toBe(0);
    expect(numberKeyIndex("9", { tagName: "BODY" }, none)).toBe(8);
  });

  it("never while typing, never with a modifier, never 0 or a letter", () => {
    expect(numberKeyIndex("1", { tagName: "INPUT" }, none)).toBeNull();
    expect(numberKeyIndex("1", { tagName: "TEXTAREA" }, none)).toBeNull();
    expect(numberKeyIndex("1", { tagName: "DIV", isContentEditable: true }, none)).toBeNull();
    expect(numberKeyIndex("1", { tagName: "BODY" }, { ...none, ctrl: true })).toBeNull();
    expect(numberKeyIndex("0", { tagName: "BODY" }, none)).toBeNull();
    expect(numberKeyIndex("a", { tagName: "BODY" }, none)).toBeNull();
  });

  it("names keys in words, never glyphs", () => {
    expect(keyHint("long_text", true)).toBe("Cmd + Enter to record");
    expect(keyHint("long_text", false)).toBe("Ctrl + Enter to record");
    expect(keyHint("money", false)).toBe("Enter to record");
    expect(keyHint("single_select", false)).toBe("Keys 1–9 choose");
    expect(keyHint("file", false)).toBeNull();
    for (const t of ["long_text", "text", "number", "money", "date", "entity_list"] as const) {
      expect(keyHint(t, true)).not.toMatch(/[↩⌘⏎]/);
    }
  });
});

describe("intake motion timing", () => {
  it("parses the CSS duration token the depart animation uses", () => {
    expect(parseCssMs("280ms")).toBe(280);
    expect(parseCssMs(" 0.3s ")).toBe(300);
    expect(parseCssMs("0ms")).toBe(0);
    expect(parseCssMs("")).toBeNull();
    expect(parseCssMs("fast")).toBeNull();
  });

  it("collapses every beat to zero under reduced motion", () => {
    expect(beat(130, false)).toBe(130);
    expect(beat(130, true)).toBe(0);
  });
});

describe("going back", () => {
  it("offers the newest answer the owner gave through another question", () => {
    const facts = [
      fact({ question_id: "8.1c", source_kind: "connector", status: "inferred" }),
      fact({ question_id: "3.4", status: "skipped" }),
      fact({ question_id: "3.3", status: "answered" }),
      fact({ question_id: "3.2", status: "unknown" }),
    ];
    expect(previousQuestion(facts, "3.5")).toBe("3.3");
  });

  it("never the current question, a skip, a measurement or a derivation; null when none", () => {
    expect(previousQuestion([fact({ question_id: "3.5" })], "3.5")).toBeNull();
    expect(previousQuestion([fact({ question_id: "3.4", status: "skipped" })], null)).toBeNull();
    expect(
      previousQuestion([fact({ question_id: "8.1c", source_kind: "connector" })], null),
    ).toBeNull();
    expect(previousQuestion([fact({ question_id: null })], null)).toBeNull();
    // An explicit unknown can be reopened: it is a response (rule 5).
    expect(previousQuestion([fact({ question_id: "3.2", status: "unknown" })], null)).toBe("3.2");
  });
});

describe("the tape", () => {
  it("reads Postgres and ISO timestamps; rejects garbage", () => {
    expect(parseRecordedAt("2026-10-17 21:00:49.983+00")?.toISOString()).toBe(
      "2026-10-17T21:00:49.983Z",
    );
    expect(parseRecordedAt("2026-10-17T21:00:49.983Z")?.toISOString()).toBe(
      "2026-10-17T21:00:49.983Z",
    );
    expect(parseRecordedAt("not a time")).toBeNull();
  });

  it("stamps today's facts with the local clock time, earlier ones with their date", () => {
    const now = new Date(2026, 9, 17, 15, 30);
    const today = new Date(2026, 9, 17, 14, 1).toISOString();
    const earlier = new Date(2026, 9, 16, 9, 5).toISOString();
    expect(tapeStamp(today, now)).toBe("14:01");
    expect(tapeStamp(earlier, now)).toBe("16 Oct");
    expect(tapeStamp("garbage", now)).toBe("");
  });

  it("prints each fact as label = value · source, newest first as given, gaps as gaps", () => {
    const now = new Date(2026, 9, 17, 15, 30);
    const at = new Date(2026, 9, 17, 13, 58).toISOString();
    const entries = tapeEntries(
      [
        fact({
          recorded_at: at,
          value: { amount_minor: 938, currency: "EUR" },
          source_kind: "connector",
          provider: "Shopify",
          status: "inferred",
        }),
        fact({ key: "costs.debt", field: "costs.debt", recorded_at: at, status: "unknown" }),
      ],
      now,
    );
    expect(entries[0]).toMatchObject({
      stamp: "13:58",
      label: "Monthly revenue",
      value: "€9.38",
      source: "Shopify",
    });
    expect(entries[1]?.value).toBe("not known");
  });
});

describe("report readiness cells", () => {
  it("fills proportionally, rounded, within the row", () => {
    expect(readinessCells(0.61)).toBe(15);
    expect(readinessCells(1)).toBe(25);
    expect(readinessCells(0)).toBe(0);
  });

  it("never fills past the row or below zero, and NaN fills nothing", () => {
    expect(readinessCells(1.4)).toBe(25);
    expect(readinessCells(-0.2)).toBe(0);
    expect(readinessCells(Number.NaN)).toBe(0);
  });
});

describe("the dial", () => {
  it("puts 0 at the left end, 50 at the top, 100 at the right", () => {
    const at = (p: number) => {
      const { x, y } = dialPoint(p, 100, 100, 50);
      return [Math.round(x), Math.round(y)];
    };
    expect(at(0)).toEqual([50, 100]);
    expect(at(50)).toEqual([100, 50]);
    expect(at(100)).toEqual([150, 100]);
  });

  it("pins values off the scale to its ends", () => {
    expect(dialPoint(140, 100, 100, 50)).toEqual(dialPoint(100, 100, 100, 50));
    expect(dialPoint(-5, 100, 100, 50)).toEqual(dialPoint(0, 100, 100, 50));
  });
});

describe("the money ruler", () => {
  it("builds five nice steps with the reference inside the first 5/8", () => {
    const scale = rulerScale(9.38);
    expect(scale).not.toBeNull();
    expect(scale!.labels).toHaveLength(6);
    expect(scale!.labels[0]).toBe(0);
    expect(scale!.max).toBe(scale!.step * 5);
    expect(scale!.at).toBeGreaterThan(0);
    expect(scale!.at).toBeLessThanOrEqual(5 / 8);
    expect([1, 2, 2.5, 3, 5]).toContain(scale!.step / 10 ** Math.floor(Math.log10(scale!.step)));
  });

  it("refuses a reference with nothing to put on an axis", () => {
    expect(rulerScale(0)).toBeNull();
    expect(rulerScale(-3)).toBeNull();
    expect(rulerScale(Number.NaN)).toBeNull();
  });

  it("takes the reference only from a measured money value (rule 1: minor units + currency)", () => {
    const read = fact({
      value: { amount_minor: 938, currency: "EUR" },
      source_kind: "connector",
      provider: "Shopify",
      status: "inferred",
    });
    expect(moneyReference({ already_read: read })).toEqual({
      major: 9.38,
      currency: "EUR",
      text: "€9.38",
    });
    expect(moneyReference({ already_read: null })).toBeNull();
    expect(moneyReference({ already_read: fact({ value: 12 }) })).toBeNull();
  });
});

describe("option tiles", () => {
  it("one row up to four, then rows of three or four", () => {
    expect(optionColumns(2)).toBe(2);
    expect(optionColumns(4)).toBe(4);
    expect(optionColumns(6)).toBe(3);
    expect(optionColumns(8)).toBe(4);
    expect(optionColumns(33)).toBe(4);
    expect(optionColumns(0)).toBe(1);
  });
});
