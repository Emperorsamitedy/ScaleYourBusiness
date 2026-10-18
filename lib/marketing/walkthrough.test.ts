import { describe, expect, it } from "vitest";
import { SAMPLE_LEAK, SAMPLE_MARKERS, SAMPLE_OUTCOME } from "./sample-diagnosis";
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

  it("ends each scene with its full figures", () => {
    expect(frame(17.9).watch.filled).toBe(28);
    expect(frame(17.9).watch.readings).toBe(4212);
    const report = frame(23.9).report;
    expect(report.shown).toBe(SAMPLE_MARKERS.length);
    expect(report.total).toEqual(SAMPLE_LEAK);
    expect(frame(29.9).approve.approved).toBe(true);
    const results = frame(35.9).results;
    expect(results.recovered_minor).toBe(SAMPLE_OUTCOME.recovered_minor);
    expect(results.conversion).toBeCloseTo(SAMPLE_OUTCOME.conversion_after);
  });

  it("keeps the running leak total in whole euros of minor units", () => {
    for (let t = 18; t < 24; t += 0.1) {
      const total = frame(t).report.total;
      if (total) {
        expect(total.low_minor % 100).toBe(0);
        expect(total.low_minor).toBeLessThanOrEqual(total.high_minor);
      }
    }
  });
});
