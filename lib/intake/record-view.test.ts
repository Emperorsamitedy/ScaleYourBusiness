// The intake's record sheet: current records in, the view out. Pure
// functions; dotenv only because repr() lives beside the fact sheet's
// database read, whose module loads the db client.

import "dotenv/config";

import { describe, expect, it } from "vitest";
import type { CurrentRow, RecordInput } from "./record-view";
import {
  alreadyRead,
  AREA_ROWS,
  areaRecord,
  buildRecord,
  DERIVED_ROWS,
  listFacts,
  RECORD_ROWS,
} from "./record-view";
import type { RecordFact } from "./types";

const OFFER = "0b6f2c1e-7a4d-4e8b-9c3f-2d1a5e6f7a8b";

let clock = 0;
function row(over: Partial<CurrentRow> & { field_key: string }): CurrentRow {
  clock += 1;
  const at = new Date(Date.UTC(2026, 9, 1, 12, 0, clock)).toISOString();
  return {
    status: "answered",
    value: "x",
    source: { kind: "owner_input" },
    note: null,
    confidence: "0.750",
    observed_at: at,
    recorded_at: at,
    ...over,
  };
}

const measured = (metric: string) => ({
  kind: "inferred",
  derived_from: [`connector:shopify:${metric}`],
  method: `sum of ${metric} over 28 days`,
});

function input(rows: CurrentRow[]): RecordInput {
  return {
    rows,
    questionIdByKey: new Map([["identity.legal_name", "1.1"]]),
    providerLabel: (id) => (id === "shopify" ? "Shopify" : id),
  };
}

describe("the record sheet", () => {
  it("lists facts newest first, raw value intact, with the bank question that wrote it", () => {
    const rows = [
      row({ field_key: "identity.legal_name", value: "Fernhill Ceramics" }),
      row({
        field_key: "revenue.monthly_revenue",
        value: { amount_minor: 4126000, currency: "EUR" },
        status: "inferred",
        source: measured("revenue.daily"),
      }),
    ];
    const listed = listFacts(input(rows));
    const record = buildRecord(listed);
    expect(record.facts.map((f) => f.key)).toEqual([
      "revenue.monthly_revenue",
      "identity.legal_name",
    ]);
    expect(record.facts[0]).toMatchObject({
      value: { amount_minor: 4126000, currency: "EUR" },
      source_kind: "connector",
      provider: "Shopify",
      question_id: null,
    });
    expect(record.facts[1]).toMatchObject({ question_id: "1.1", provider: null });
  });

  it("counts facts by source and provider; gaps are not facts (rule 5)", () => {
    const rows = [
      row({ field_key: "identity.legal_name" }),
      row({ field_key: "identity.description" }),
      row({
        field_key: "revenue.orders",
        status: "inferred",
        value: 612,
        source: measured("orders"),
      }),
      row({ field_key: "costs.rent", status: "unknown", value: null }),
      row({ field_key: "goals.primary", status: "skipped", value: null }),
      row({ field_key: "goals.horizon", status: "unasked", value: null }),
    ];
    const record = buildRecord(listFacts(input(rows)));
    expect(record.fact_count).toBe(3);
    expect(record.sources).toEqual([
      { kind: "owner_input", provider: null, count: 2 },
      { kind: "connector", provider: "Shopify", count: 1 },
    ]);
    expect(record.not_known).toBe(1);
    expect(record.skipped).toBe(1);
    // An unasked record (a reopened question) is not on the sheet at all.
    expect(record.facts.map((f) => f.key)).not.toContain("goals.horizon");
    const gap = record.facts.find((f) => f.key === "costs.rent");
    expect(gap).toMatchObject({ value: null, text: null, status: "unknown" });
  });

  it("names entity facts by their entity, and reads a marker as a count", () => {
    const rows = [
      row({ field_key: `offers.${OFFER}.name`, value: "Mug" }),
      row({ field_key: `offers.${OFFER}.price`, value: { amount_minor: 2400, currency: "EUR" } }),
      row({ field_key: "offers", value: { entity_ids: [OFFER] } }),
    ];
    const facts = listFacts(input(rows));
    expect(facts.find((f) => f.field === "price")).toMatchObject({ entity: "Mug" });
    expect(facts.find((f) => f.key === "offers")?.text).toBe("1 on file");
  });

  it("caps the sheet and says how many it left out", () => {
    const rows = Array.from({ length: RECORD_ROWS + 5 }, (_, i) =>
      row({ field_key: `identity.f${i}` }),
    );
    const record = buildRecord(listFacts(input(rows)));
    expect(record.facts).toHaveLength(RECORD_ROWS);
    expect(record.more).toBe(5);
  });
});

describe("what the record already says — derived facts only", () => {
  it("passes a derivation from the owner's own facts, with its formula", () => {
    const rows = [
      row({
        field_key: "costs.gross_margin",
        status: "inferred",
        value: 0.38,
        source: {
          kind: "inferred",
          derived_from: ["revenue.monthly_revenue", "costs.cogs"],
          method: "gross_margin = (revenue - cogs) / revenue",
        },
      }),
    ];
    const record = buildRecord(listFacts(input(rows)));
    expect(record.derived).toHaveLength(1);
    expect(record.derived[0]?.method).toContain("gross_margin");
  });

  it("fails a measurement — that is read, not derived", () => {
    const rows = [
      row({
        field_key: "revenue.orders",
        status: "inferred",
        value: 612,
        source: measured("orders"),
      }),
      row({ field_key: "identity.legal_name" }),
    ];
    expect(buildRecord(listFacts(input(rows))).derived).toEqual([]);
  });

  it(`shows at most ${DERIVED_ROWS}`, () => {
    const rows = Array.from({ length: DERIVED_ROWS + 2 }, (_, i) =>
      row({
        field_key: `costs.d${i}`,
        status: "inferred",
        value: i,
        source: { kind: "inferred", derived_from: ["costs.a"], method: "m" },
      }),
    );
    expect(buildRecord(listFacts(input(rows))).derived).toHaveLength(DERIVED_ROWS);
  });
});

describe("already read from a connector", () => {
  it("passes a measured fact at the question's key or beneath it", () => {
    const facts = listFacts(
      input([
        row({
          field_key: "operations.shipping.label_share",
          status: "inferred",
          value: 0.78,
          source: measured("shipping.labels"),
        }),
      ]),
    );
    expect(alreadyRead("operations.shipping", facts)?.provider).toBe("Shopify");
  });

  it("fails an owner answer, a gap, or an unrelated key — never invented", () => {
    const facts = listFacts(
      input([
        row({ field_key: "operations.shipping" }),
        row({ field_key: "operations.shipping_x", status: "inferred", source: measured("m") }),
        row({ field_key: "operations.shipping.cost", status: "unknown", value: null }),
      ]),
    );
    expect(alreadyRead("operations.shipping", facts)).toBeNull();
  });
});

describe("the area's record card", () => {
  const fact = (key: string, status: string, question_id: string | null = null): RecordFact => ({
    key,
    entity: null,
    field: key,
    value: status === "answered" ? "x" : null,
    text: status === "answered" ? "x" : null,
    status,
    source_kind: "owner_input",
    provider: null,
    note: null,
    confidence: 0.75,
    observed_at: "2026-10-17 10:00:00+00",
    recorded_at: "2026-10-17 10:00:00+00",
    method: null,
    question_id,
  });
  const sectionOf = (f: RecordFact) =>
    f.question_id === "1.1b" ? "identity" : f.key.split(".")[0]!;

  it("passes: keeps only the area's facts and gaps, in the order given, capped", () => {
    const listed = [
      fact("operations.a", "answered"),
      fact("legal.country", "answered", "1.1b"), // asked in identity
      fact("operations.b", "unknown"),
      fact("operations.c", "skipped"),
      fact("revenue.x", "answered"),
    ];
    const card = areaRecord(listed, "operations", sectionOf, 2);
    expect(card.facts.map((f) => f.key)).toEqual(["operations.a", "operations.b"]);
    // The count is value-bearing facts only: a gap is not a fact (rule 5).
    expect(card.fact_count).toBe(1);
    expect(areaRecord(listed, "identity", sectionOf).facts.map((f) => f.key)).toEqual([
      "legal.country",
    ]);
  });

  it("fails to include another area's facts, and is empty for an area with none", () => {
    const card = areaRecord([fact("revenue.x", "answered")], "operations", sectionOf);
    expect(card).toEqual({ section: "operations", facts: [], fact_count: 0 });
    expect(AREA_ROWS).toBeGreaterThan(0);
  });
});
