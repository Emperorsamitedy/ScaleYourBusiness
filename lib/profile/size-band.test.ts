import { describe, expect, it } from "vitest";
import { validateSourceRef } from "../core/source-ref";
import type { BandInputRecord } from "./size-band";
import { SIZE_BAND_METHOD, TEAM_SIZE_KEY, bandForTeamSize, resolveSizeBand } from "./size-band";

const at = "2026-10-01T09:00:00.000Z";
const team = (value: unknown, status = "answered"): BandInputRecord => ({
  status,
  value,
  confidence: 0.75,
  observed_at: at,
});
const band = (code: string | null, status = "answered"): BandInputRecord => ({
  status,
  value: code === null ? null : { code },
  confidence: 0.75,
  observed_at: at,
});

describe("the size band inferred from team size — EU SME headcount boundaries", () => {
  it("maps 1 → solo, 2–9 → small, 10–49 → medium, 50+ → large, at both sides of every boundary", () => {
    expect(bandForTeamSize(1)).toBe("solo");
    expect(bandForTeamSize(2)).toBe("small");
    expect(bandForTeamSize(9)).toBe("small");
    expect(bandForTeamSize(10)).toBe("medium");
    expect(bandForTeamSize(49)).toBe("medium");
    expect(bandForTeamSize(50)).toBe("large");
    expect(bandForTeamSize(400)).toBe("large");
  });

  it("names no band for a headcount that names nobody", () => {
    expect(bandForTeamSize(0)).toBeNull();
    expect(bandForTeamSize(-3)).toBeNull();
    expect(bandForTeamSize(Number.NaN)).toBeNull();
  });
});

describe("resolveSizeBand — the owner's words win, the inference fills in", () => {
  it("uses the owner's stated band, even when the headcount says otherwise", () => {
    expect(resolveSizeBand(band("medium"), team(1))).toEqual({ band: "medium", via: "stated" });
  });

  it("infers from team size when the band was never asked, as a Field with derived_from and the formula (rule 6)", () => {
    const r = resolveSizeBand(null, team(4), new Date("2026-10-22T12:00:00.000Z"));
    expect(r?.band).toBe("small");
    expect(r?.via).toBe("inferred");
    if (r?.via !== "inferred") throw new Error("expected an inference");
    expect(r.field.status).toBe("inferred");
    expect(r.field.value).toEqual({ code: "small" });
    expect(r.field.source).toEqual({
      kind: "inferred",
      derived_from: [TEAM_SIZE_KEY],
      method: SIZE_BAND_METHOD,
    });
    expect(() => validateSourceRef(r.field.source)).not.toThrow();
    // §8.1: a derivation is min(inputs) × 0.9.
    expect(r.field.confidence).toBeCloseTo(0.675, 6);
    expect(r.field.observed_at).toBe(at);
  });

  it("infers when the band was skipped or reopened (unasked)", () => {
    expect(resolveSizeBand(band(null, "skipped"), team(12))?.band).toBe("medium");
    expect(resolveSizeBand(band(null, "unasked"), team(60))?.band).toBe("large");
  });

  it("keeps an explicit 'I don't know' on the band a gap: no inference over it (rule 5)", () => {
    expect(resolveSizeBand(band(null, "unknown"), team(4))).toBeNull();
  });

  it("is null without an answered headcount, so everything shows", () => {
    expect(resolveSizeBand(null, null)).toBeNull();
    expect(resolveSizeBand(null, team(null, "unknown"))).toBeNull();
    expect(resolveSizeBand(null, team(null, "skipped"))).toBeNull();
    expect(resolveSizeBand(null, team(0))).toBeNull();
  });

  it("ignores a stated code that is not a band", () => {
    expect(resolveSizeBand(band("enormous"), team(4))).toBeNull();
  });
});
