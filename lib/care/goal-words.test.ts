// L-4b: the weekly check's detail is built from what the check found
// (`explain`). English is what the watch log stores, its days written out;
// a fake translator shows the screen's copy goes through "goalsWords"
// with its money, counts, shares and dates in the reader's locale.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
import type { ProgressExplain } from "./progress";
import { assessProgress, checkDetail, progressArithmetic } from "./progress";

const fake: Tr = (k, v) => `[${k}${v ? " " + JSON.stringify(v) : ""}]`;
const GERMAN = { tr: fake, locale: "de-DE" as const };

const path: ProgressExplain = {
  kind: "path",
  lead: "plain",
  metric: "revenue",
  currency: "EUR",
  actual: 330_000,
  days_measured: 28,
  expected: 354_000,
  today: "2026-05-01",
  baseline: 300_000,
  baseline_to: "2025-12-31",
  target: 390_000,
  deadline: "2026-07-20",
  ratio: 0.5555,
  shortfall: 0.08,
};

describe("English is what the watch log always stored", () => {
  it("words the path, the share and the verdict", () => {
    expect(checkDetail("lagging", path)).toBe(
      "Behind the path: €3,300.00 revenue per 30 days over the last 28 measured days, against €3,540.00 revenue per 30 days expected by 1 May 2026 on the path from €3,000.00 revenue per 30 days (31 Dec 2025) to €3,900.00 revenue per 30 days (20 Jul 2026): 55.6% of the expected progress, 8% behind the path.",
    );
  });
  it("is the assessment's own arithmetic", () => {
    const a = assessProgress({
      measure: {
        metric: "orders",
        direction: "increase",
        target_per_30d: 300,
        currency: null,
        set_on: "2026-01-01",
        deadline: "2026-07-01",
      },
      baseline: null,
      current: null,
      care: { day_zero: "2025-01-01T00:00:00.000Z", watch_ends_at: null },
      today: "2026-03-01",
    });
    expect(a.arithmetic).toBe(
      "no measured baseline for orders before 1 Jan 2026: connect a source and the history fills it",
    );
    expect(progressArithmetic(a.explain)).toBe(a.arithmetic);
    expect(englishTr("goalsWords")("area.increase_revenue")).toBe("increase revenue");
  });
});

describe("another language goes through the translator", () => {
  it("words the verdict and the path, figures and dates in German", () => {
    const d = checkDetail("lagging", path, GERMAN);
    expect(d.startsWith("[check.detail")).toBe(true);
    expect(d).toContain("check.verdict.lagging");
    expect(d).toContain("3.300,00 €");
    expect(d).toContain("1. Mai 2026");
    expect(d).toMatch(/55,6\s%/);
    expect(d).not.toMatch(/per 30 days|measured days|behind the path|2026-05-01/);
  });
});
