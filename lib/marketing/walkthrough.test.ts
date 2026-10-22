import { describe, expect, it } from "vitest";
import { DEMO_SAMPLES, SALON_SAMPLE, SHOP_SAMPLE } from "./sample-diagnosis";
import { CHAPTERS, REDUCED_MOTION_SECOND, WALK_SECONDS, frame } from "./walkthrough";

describe("the walkthrough's clock", () => {
  it("plays six six-second chapters in 36 seconds", () => {
    expect(CHAPTERS).toHaveLength(6);
    expect(WALK_SECONDS).toBe(36);
    for (let i = 0; i < 6; i++) expect(frame(i * 6 + 0.01).scene).toBe(i);
    expect(frame(35.9).scene).toBe(5);
  });

  it("opens on the report, paused, under reduced motion", () => {
    expect(frame(REDUCED_MOTION_SECOND).scene).toBe(3);
  });

  it("shows the cursor only in scenes where something is clicked or pointed at", () => {
    expect(frame(1).cursor).not.toBeNull();
    expect(frame(13).cursor).toBeNull();
    expect(frame(33).cursor).toBeNull();
  });

  it("ripples at the click and nowhere else", () => {
    expect(frame(3).ripple).not.toBeNull(); // scene 1, p = 0.5
    expect(frame(3).ripple?.opacity).toBeCloseTo(1);
    expect(frame(1).ripple).toBeNull();
    expect(frame(20).ripple).toBeNull(); // the report has no click
  });

  it("connects after the click and fills the read bar", () => {
    expect(frame(2.5).connect.done).toBe(false);
    expect(frame(3.6).connect.done).toBe(true);
    expect(frame(5.9).connect.bar).toBe(100);
  });

  it.each(DEMO_SAMPLES.map((s) => [s.label, s] as const))(
    "ends each scene with its full figures (%s)",
    (_, sample) => {
      expect(frame(17.9, sample).watch.filled).toBe(28);
      expect(frame(17.9, sample).watch.readings).toBe(4212);
      const report = frame(23.9, sample).report;
      expect(report.shown).toBe(sample.markers.length);
      expect(report.total).toEqual(sample.leak);
      expect(frame(29.9, sample).approve.approved).toBe(true);
      const results = frame(35.9, sample).results;
      expect(results.recovered_minor).toBe(sample.outcome.recovered_minor);
      expect(results.metric).toBeCloseTo(sample.outcome.after);
      expect(frame(33.01, sample).results.metric).toBeCloseTo(sample.outcome.before, 1);
    },
  );

  it.each(DEMO_SAMPLES.map((s) => [s.label, s] as const))(
    "keeps the running leak total in whole euros of minor units (%s)",
    (_, sample) => {
      for (let t = 18; t < 24; t += 0.1) {
        const total = frame(t, sample).report.total;
        if (total) {
          expect(total.low_minor % 100).toBe(0);
          expect(total.low_minor).toBeLessThanOrEqual(total.high_minor);
        }
      }
    },
  );

  it("plays the webshop by default, and the salon's own figures when asked", () => {
    expect(frame(23.9).report.total).toEqual(SHOP_SAMPLE.leak);
    expect(frame(23.9, SALON_SAMPLE).report.total).toEqual(SALON_SAMPLE.leak);
  });
});
