// The live reading: lib/economics run on the current records, assembled in
// memory — nothing written, nothing snapshotted. Pure: rows in, figure out.

import { describe, expect, it } from "vitest";
import { computeEconomics } from "../economics/unit-economics";
import type { EconomicsResult } from "../economics/unit-economics";
import type { FieldRecordRow } from "../profile/field-codec";
import type { SnapshotEntity } from "../profile/snapshot";
import { currentRecordsView, liveReadingOf } from "./live-reading";

const PROFILE = "6a1f0c3e-2b4d-4e8f-9a1b-3c5d7e9f1a2b";
const MUG = "0b6f2c1e-7a4d-4e8b-9c3f-2d1a5e6f7a8b";
const AT = "2026-10-17T12:00:00.000Z";

function row(
  field_key: string,
  value: unknown,
  over: Partial<FieldRecordRow> = {},
): FieldRecordRow {
  return {
    profile_id: PROFILE,
    section: "offers",
    field_key,
    value,
    status: "answered",
    confidence: "0.750",
    source: { kind: "owner_input" },
    observed_at: AT,
    recorded_at: AT,
    note: null,
    ...over,
  };
}

const ENTITIES: SnapshotEntity[] = [{ spine: "offers", id: MUG, kind: "physical" }];
const eur = (minor: number) => ({ amount_minor: minor, currency: "EUR" });

describe("currentRecordsView", () => {
  it("passes: current rows become Fields the economics engine computes a margin from", () => {
    const view = currentRecordsView(
      PROFILE,
      [
        row(`offers.${MUG}.name`, "Mug"),
        row(`offers.${MUG}.price`, eur(2000)),
        row(`offers.${MUG}.cost_to_deliver`, eur(1240)),
      ],
      ENTITIES,
      AT,
    );
    expect(view.facts.size).toBe(3);
    expect(view.summary.id).toBe("current-records"); // never claims to be a stored snapshot
    const reading = liveReadingOf(computeEconomics(view, "EUR"));
    expect(reading).not.toBeNull();
    expect(reading!.value_pct).toBe(38);
    expect(reading!.label).toBe("Blended margin");
    // Rule 6: the figure carries its formula and what it rests on.
    expect(reading!.formula).toMatch(/margin/);
    expect(reading!.inputs).toBe(2);
  });

  it("fails closed: a row the Field codec rejects is left out, not let in", () => {
    const view = currentRecordsView(
      PROFILE,
      [
        row(`offers.${MUG}.price`, eur(2000)),
        row("offers.bad", 1, { status: "nonsense" as never }),
      ],
      ENTITIES,
      AT,
    );
    expect(view.facts.has("offers.bad")).toBe(false);
    expect(view.facts.size).toBe(1);
  });
});

describe("liveReadingOf", () => {
  const base: EconomicsResult = {
    currency: "EUR",
    offers: [],
    blended_margin_pct: null,
    break_even: null,
    average_order_value: null,
    cost_per_acquisition: null,
    fixed_costs_monthly: null,
    stated_vs_computed_margin: null,
    refusals: [],
  };

  it("is null — the card hides — when the engine refused the margin", () => {
    expect(liveReadingOf(base)).toBeNull();
    // A price with no cost is a refusal, not a guess.
    const view = currentRecordsView(PROFILE, [row(`offers.${MUG}.price`, eur(2000))], ENTITIES, AT);
    expect(liveReadingOf(computeEconomics(view, "EUR"))).toBeNull();
  });

  it("carries the owner's own stated margin when there is one, else null", () => {
    const blended = { value: 71.4, derived_from: ["a", "b", "a"], formula: "f", confidence: 0.6 };
    const withStated = liveReadingOf({
      ...base,
      blended_margin_pct: blended,
      stated_vs_computed_margin: {
        stated_pct: 58,
        computed_pct: 71.4,
        delta_pts: 13.4,
        used_for_analysis: "computed",
      },
    });
    expect(withStated).toEqual({
      label: "Blended margin",
      value_pct: 71.4,
      formula: "f",
      inputs: 2,
      stated_pct: 58,
    });
    expect(liveReadingOf({ ...base, blended_margin_pct: blended })?.stated_pct).toBeNull();
  });
});
