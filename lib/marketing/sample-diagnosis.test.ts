import { describe, expect, it } from "vitest";
import { DEMO_SAMPLES, type SampleFlag } from "./sample-diagnosis";

// The samples are fictional, but their grammar has to hold: a flag that
// disagrees with its own range sells nothing. Every demo is held to the
// same rules — the webshop and the salon alike.
describe.each(DEMO_SAMPLES.map((s) => [s.label, s] as const))(
  "the illustrative business (%s) follows the number grammar",
  (_, sample) => {
    it("every flag agrees with its value, range and act-now line", () => {
      for (const r of sample.markers) {
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
      for (const r of sample.markers) {
        const [lo, hi] = r.range;
        expect(r.act_at < lo || r.act_at > hi, r.measure).toBe(true);
      }
    });

    it("keeps every value, range and line on the bar's scale", () => {
      for (const r of sample.markers) {
        const [min, max] = r.scale;
        for (const v of [r.value, r.act_at, ...r.range]) {
          expect(v, r.measure).toBeGreaterThanOrEqual(min);
          expect(v, r.measure).toBeLessThanOrEqual(max);
        }
      }
    });

    it("prices a leak exactly where a marker is out of range", () => {
      for (const r of sample.markers) {
        if (r.flag === "OK") expect(r.leak_minor, r.measure).toBeNull();
        else expect(r.leak_minor, r.measure).toBeGreaterThan(0);
      }
    });

    it("shows at least one marker in range, so the report is not all alarm", () => {
      expect(sample.markers.some((r) => r.flag === "OK")).toBe(true);
    });

    it("states the leak as a range whose low end is the priced markers' sum", () => {
      const sum = sample.markers.reduce((a, r) => a + (r.leak_minor ?? 0), 0);
      expect(sample.leak.low_minor).toBe(sum);
      expect(sample.leak.low_minor).toBeLessThan(sample.leak.high_minor);
    });

    it("keeps money in integer minor units, with a currency", () => {
      expect(sample.currency).toMatch(/^[A-Z]{3}$/);
      const moneyMarkers = sample.markers.filter((r) => r.unit === "money_minor");
      const recordMoney = sample.record.rows.flatMap((r) =>
        "money_minor" in r.figure ? [r.figure.money_minor] : [],
      );
      for (const v of [
        sample.leak.low_minor,
        sample.leak.high_minor,
        sample.proposal.expected_low_minor,
        sample.proposal.expected_high_minor,
        sample.outcome.recovered_minor,
        ...sample.markers.map((r) => r.leak_minor ?? 0),
        ...moneyMarkers.flatMap((r) => [r.value, r.act_at, ...r.range, ...r.scale]),
        ...recordMoney,
      ]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    });

    it("measures an outcome inside the proposal's expected range", () => {
      const { outcome, proposal } = sample;
      expect(outcome.recovered_minor).toBeGreaterThanOrEqual(proposal.expected_low_minor);
      expect(outcome.recovered_minor).toBeLessThanOrEqual(proposal.expected_high_minor);
    });

    it("moves the marker the outcome names, from its own value, the better way", () => {
      const { outcome } = sample;
      const marker = sample.markers.find((r) => r.measure === outcome.measure);
      expect(marker, outcome.measure).toBeDefined();
      expect(marker?.flag).not.toBe("OK");
      expect(outcome.before).toBe(marker?.value);
      if (outcome.better === "higher") expect(outcome.after).toBeGreaterThan(outcome.before);
      else expect(outcome.after).toBeLessThan(outcome.before);
    });

    it("picks one of its own options in the record question", () => {
      const { record } = sample;
      expect(record.options[record.picked]).toBeDefined();
    });
  },
);

describe("the demos", () => {
  it("default to the webshop, then the salon, each a distinct id", () => {
    expect(DEMO_SAMPLES.map((s) => s.id)).toEqual(["shop", "salon"]);
  });
});
