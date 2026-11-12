// P7-53: monthly re-diagnosis — when a business is due, and that the job
// re-runs only the due ones, under its cap, never failing as a whole.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import {
  MAX_PER_RUN,
  REDIAGNOSE_AFTER_DAYS,
  dueForRediagnosis,
  runMonthlyRediagnosis,
} from "./monthly";

describe("P7-53 — monthly re-diagnosis", () => {
  const now = new Date("2026-11-12T06:00:00Z");

  it("is due at 30 days, not before", () => {
    expect(REDIAGNOSE_AFTER_DAYS).toBe(30);
    expect(dueForRediagnosis("2026-10-13T06:00:00Z", now)).toBe(true);
    expect(dueForRediagnosis("2026-10-13T06:00:01Z", now)).toBe(false);
    expect(dueForRediagnosis("2026-11-01T00:00:00Z", now)).toBe(false);
  });

  it("re-runs each due business once, through the report generator, and a failure stays one business's", async () => {
    const seen: string[] = [];
    let i = 0;
    const run = await runMonthlyRediagnosis(new Date("2100-01-01T00:00:00Z"), async (a) => {
      seen.push(a.profileId);
      i++;
      if (i === 1) throw new Error("one business failing");
      return { fresh: i % 2 === 0 };
    });
    // In 2100 every stored report is due: each business at most once, at most MAX_PER_RUN.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(Math.min(run.checked, MAX_PER_RUN));
    expect(run.regenerated + run.unchanged + run.failed).toBe(seen.length);
    if (seen.length > 0) expect(run.failed).toBe(1);
    expect(run.deferred).toBe(Math.max(0, run.checked - MAX_PER_RUN));
  });
});
