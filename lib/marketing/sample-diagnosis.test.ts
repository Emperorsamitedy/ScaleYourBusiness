import { describe, expect, it } from "vitest";
import {
  SAMPLE_LEAK,
  SAMPLE_MARKERS,
  SAMPLE_OUTCOME,
  SAMPLE_PROPOSAL,
  type SampleFlag,
} from "./sample-diagnosis";

// The sample is fictional, but its grammar has to hold: a flag that
// disagrees with its own range sells nothing.
describe("the illustrative store follows the number grammar", () => {
  it("every flag agrees with its value, range and act-now line", () => {
    for (const r of SAMPLE_MARKERS) {
      const [lo, hi] = r.range;
      const actBelow = r.act_at < lo;
      const past = actBelow ? r.value < r.act_at : r.value > r.act_at;
      const expected: SampleFlag = past
        ? "ACT"
        : r.value < lo
          ? "LOW"
          : r.value > hi
            ? "HIGH"
            : "OK";
      expect(r.flag, r.measure).toBe(expected);
    }
  });

  it("puts the act-now line outside the range, on the side it guards", () => {
    for (const r of SAMPLE_MARKERS) {
      const [lo, hi] = r.range;
      expect(r.act_at < lo || r.act_at > hi, r.measure).toBe(true);
    }
  });

  it("keeps every value, range and line on the bar's scale", () => {
    for (const r of SAMPLE_MARKERS) {
      const [min, max] = r.scale;
      for (const v of [r.value, r.act_at, ...r.range]) {
        expect(v, r.measure).toBeGreaterThanOrEqual(min);
        expect(v, r.measure).toBeLessThanOrEqual(max);
      }
    }
  });

  it("prices a leak exactly where a marker is out of range", () => {
    for (const r of SAMPLE_MARKERS) {
      if (r.flag === "OK") expect(r.leak_minor, r.measure).toBeNull();
      else expect(r.leak_minor, r.measure).toBeGreaterThan(0);
    }
  });

  it("states the leak as a range whose low end is the priced markers' sum", () => {
    const sum = SAMPLE_MARKERS.reduce((a, r) => a + (r.leak_minor ?? 0), 0);
    expect(SAMPLE_LEAK.low_minor).toBe(sum);
    expect(SAMPLE_LEAK.low_minor).toBeLessThan(SAMPLE_LEAK.high_minor);
  });

  it("keeps money in integer minor units", () => {
    for (const v of [
      SAMPLE_LEAK.low_minor,
      SAMPLE_LEAK.high_minor,
      SAMPLE_PROPOSAL.expected_low_minor,
      SAMPLE_PROPOSAL.expected_high_minor,
      SAMPLE_OUTCOME.recovered_minor,
      ...SAMPLE_MARKERS.map((r) => r.leak_minor ?? 0),
    ]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("measures an outcome inside the proposal's expected range", () => {
    expect(SAMPLE_OUTCOME.recovered_minor).toBeGreaterThanOrEqual(
      SAMPLE_PROPOSAL.expected_low_minor,
    );
    expect(SAMPLE_OUTCOME.recovered_minor).toBeLessThanOrEqual(SAMPLE_PROPOSAL.expected_high_minor);
    expect(SAMPLE_OUTCOME.conversion_after).toBeGreaterThan(SAMPLE_OUTCOME.conversion_before);
  });
});
