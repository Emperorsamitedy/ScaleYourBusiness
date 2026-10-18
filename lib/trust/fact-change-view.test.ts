import "dotenv/config";
import { describe, expect, it } from "vitest";
import { describeChange } from "./fact-change-view";

const base = {
  id: "a",
  field_key: "offers.4b0c7a52-1d1e-4f4c-9a4a-0d3c5a3b2e10.price",
  status: "known",
  recorded_at: "2026-10-01T10:00:00Z",
};

describe("describeChange", () => {
  it("reads a supersession as old value → new value, from the successor's source", () => {
    const c = describeChange(
      { ...base, value: { amount_minor: 890, currency: "EUR" }, source: { kind: "owner_input" } },
      {
        ...base,
        id: "b",
        value: { amount_minor: 938, currency: "EUR" },
        source: { kind: "owner_input" },
        recorded_at: "2026-10-17T12:00:00Z",
      },
    );
    expect(c).toEqual({
      id: "b",
      key: base.field_key,
      from: "8.9 EUR",
      to: "9.38 EUR",
      to_status: "known",
      at: "2026-10-17T12:00:00Z",
      by: "owner_input",
    });
  });

  it("keeps a gap a gap: an unknown successor has no value, not an invented one", () => {
    const c = describeChange(
      { ...base, value: 12, source: { kind: "owner_input" } },
      { ...base, id: "b", value: null, status: "unknown", source: { kind: "owner_input" } },
    );
    expect(c.from).toBe("12");
    expect(c.to).toBeNull();
    expect(c.to_status).toBe("unknown");
  });
});
