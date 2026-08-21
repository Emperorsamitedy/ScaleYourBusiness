// P0-15 — coverage across every FieldStatus and every SourceKind.
// Every status is constructed valid and violated; every source kind is
// validated whole and broken. Session B's done-when, second half.

import { describe, expect, it } from "vitest";
import { confidence, InvalidConfidenceError } from "./confidence";
import type { CreateFieldInput } from "./field";
import { createField, FieldInvariantError } from "./field";
import { FIELD_STATUSES, isFieldStatus, VALUE_BEARING_STATUSES } from "./field-status";
import { connectorId, documentId, fieldId } from "./ids";
import { InvalidISODateError, isoDateTime } from "./iso";
import type { Money } from "./money";
import { money } from "./money";
import type { SourceRef } from "./source-ref";
import { InvalidSourceRefError, isSourceKind, SOURCE_KINDS, validateSourceRef } from "./source-ref";

const OBSERVED = isoDateTime("2026-08-19T09:00:00Z");
const RECORDED = isoDateTime("2026-08-20T14:30:00+02:00");

function base(overrides: Partial<CreateFieldInput<Money>>): CreateFieldInput<Money> {
  return {
    id: fieldId("revenue.monthly_current"),
    value: money(420_000_000, "HUF"),
    status: "answered",
    confidence: 0.75,
    source: { kind: "owner_input" },
    observed_at: OBSERVED,
    recorded_at: RECORDED,
    ...overrides,
  };
}

// ---------------------------------------------------------------- statuses

describe("every FieldStatus constructs and is enforced", () => {
  it("the runtime list carries all six statuses, distinctly", () => {
    expect(FIELD_STATUSES).toHaveLength(6);
    expect(new Set(FIELD_STATUSES).size).toBe(6);
    for (const s of FIELD_STATUSES) expect(isFieldStatus(s)).toBe(true);
    expect(isFieldStatus("missing")).toBe(false);
  });

  it("answered — a value with provenance", () => {
    const f = createField(base({}));
    expect(f.status).toBe("answered");
    expect(f.value).toEqual(money(420_000_000, "HUF"));
    expect(f.superseded_by).toBeNull();
  });

  it("unknown — the owner's explicit 'I don't know', value null, note kept", () => {
    const f = createField(
      base({ status: "unknown", value: null, confidence: 0.75, note: "no retention tracking" }),
    );
    expect(f.status).toBe("unknown");
    expect(f.note).toBe("no retention tracking");
  });

  it("not_applicable — condition made it irrelevant", () => {
    expect(createField(base({ status: "not_applicable", value: null })).value).toBeNull();
  });

  it("skipped — declined now, ask again later", () => {
    expect(createField(base({ status: "skipped", value: null })).status).toBe("skipped");
  });

  it("inferred — value present, source names inputs and formula", () => {
    const f = createField(
      base({
        status: "inferred",
        confidence: 0.675, // min(inputs) × 0.9 per §8.1
        source: {
          kind: "inferred",
          derived_from: [fieldId("offer.price"), fieldId("offer.cogs")],
          method: "gross_margin = (price - cogs) / price",
        },
      }),
    );
    expect(f.status).toBe("inferred");
    expect(f.source.kind).toBe("inferred");
  });

  it("unasked — never presented; says nothing about the owner", () => {
    expect(createField(base({ status: "unasked", value: null })).status).toBe("unasked");
  });

  it("exactly answered and inferred bear values — the other four refuse one", () => {
    expect([...VALUE_BEARING_STATUSES].sort()).toEqual(["answered", "inferred"]);
    for (const status of FIELD_STATUSES) {
      if (VALUE_BEARING_STATUSES.has(status)) continue;
      expect(() => createField(base({ status, value: money(1, "EUR") }))).toThrow(
        FieldInvariantError,
      );
    }
  });

  it("answered with null value is refused — a gap must say so (rule 5)", () => {
    expect(() => createField(base({ value: null }))).toThrow(FieldInvariantError);
  });

  it("status and source must tell one story about inference (rule 6)", () => {
    // inferred status without inferred source
    expect(() => createField(base({ status: "inferred" }))).toThrow(FieldInvariantError);
    // inferred source hiding under answered
    expect(() =>
      createField(
        base({
          source: { kind: "inferred", derived_from: [fieldId("a")], method: "b = a" },
        }),
      ),
    ).toThrow(FieldInvariantError);
  });
});

// ------------------------------------------------------------ source kinds

describe("every SourceKind validates and is enforced", () => {
  it("the runtime list carries all six kinds — 'conversation' arrives in Session C", () => {
    expect(SOURCE_KINDS).toHaveLength(6);
    for (const k of SOURCE_KINDS) expect(isSourceKind(k)).toBe(true);
    expect(isSourceKind("conversation")).toBe(false);
  });

  const valid: Record<(typeof SOURCE_KINDS)[number], SourceRef> = {
    owner_input: { kind: "owner_input" },
    connector: { kind: "connector", connector_id: connectorId("shopify") },
    document: { kind: "document", document_id: documentId("doc_2026_pnl") },
    inferred: {
      kind: "inferred",
      derived_from: [fieldId("offer.price")],
      method: "unit_margin = price - cogs",
    },
    web_research: { kind: "web_research", researched_url: "https://competitor.example/pricing" },
    system_default: { kind: "system_default" },
  };

  for (const kind of SOURCE_KINDS) {
    it(`${kind} — valid ref passes through unchanged`, () => {
      expect(validateSourceRef(valid[kind])).toEqual(valid[kind]);
    });
  }

  it("connector without its id is refused", () => {
    expect(() => validateSourceRef({ kind: "connector", connector_id: " " as never })).toThrow(
      InvalidSourceRefError,
    );
  });

  it("document without its id is refused", () => {
    expect(() => validateSourceRef({ kind: "document", document_id: "" as never })).toThrow(
      InvalidSourceRefError,
    );
  });

  it("inferred with empty derived_from is refused — no unexplainable numbers", () => {
    expect(() =>
      validateSourceRef({ kind: "inferred", derived_from: [], method: "x = y" }),
    ).toThrow(InvalidSourceRefError);
  });

  it("inferred with a blank method is refused — the formula is provenance", () => {
    expect(() =>
      validateSourceRef({ kind: "inferred", derived_from: [fieldId("a")], method: "  " }),
    ).toThrow(InvalidSourceRefError);
  });

  it("web_research without its url is refused", () => {
    expect(() => validateSourceRef({ kind: "web_research", researched_url: "" })).toThrow(
      InvalidSourceRefError,
    );
  });
});

// ------------------------------------------------------------------- edges

describe("confidence and timestamp edges", () => {
  it("accepts the closed interval ends", () => {
    expect(confidence(0)).toBe(0);
    expect(confidence(1)).toBe(1);
  });

  it("rejects out-of-range and non-finite confidence", () => {
    expect(() => confidence(-0.01)).toThrow(InvalidConfidenceError);
    expect(() => confidence(1.01)).toThrow(InvalidConfidenceError);
    expect(() => confidence(Number.NaN)).toThrow(InvalidConfidenceError);
    expect(() => createField(base({ confidence: 1.5 }))).toThrow(InvalidConfidenceError);
  });

  it("accepts timestamps with Z or offset; rejects zoneless ones", () => {
    expect(isoDateTime("2026-08-20T14:30:00.123+02:00")).toBeTruthy();
    expect(() => isoDateTime("2026-08-20T14:30:00")).toThrow(InvalidISODateError);
    expect(() => isoDateTime("2026-08-20")).toThrow(InvalidISODateError);
    expect(() => isoDateTime("2026-02-30T10:00:00Z")).toThrow(InvalidISODateError);
  });
});
