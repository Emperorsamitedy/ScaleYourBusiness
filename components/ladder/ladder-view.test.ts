// The Trust Ladder screen's layout rules (specs/ux-spec-v1.md §3), each
// with a case that holds and a case that doesn't.

import { describe, expect, it } from "vitest";
import {
  cellState,
  groupRows,
  highestOpen,
  nextMove,
  recordSegs,
  sharedCeiling,
  stationCounts,
} from "./ladder-view";

const cap = (capability: string) => ({ capability });
const check = (met: boolean) => ({ rule: "net_positive", met, detail: "" });
const next = (...met: boolean[]) => ({
  eligible: met.every(Boolean),
  from: 2 as const,
  to: 3 as const,
  checks: met.map(check),
});

describe("grouping the rows", () => {
  it("puts each capability under its kind, in the screen's order", () => {
    const rows = ["purchase_order", "google_ads", "meta_publish", "email_campaign", "meta_ads"];
    const out = groupRows(rows.map(cap));
    expect(out.map((g) => g.key)).toEqual(["posts", "ads", "customers", "suppliers"]);
    expect(out[1]?.rows.map((r) => r.capability)).toEqual(["meta_ads", "google_ads"]);
  });

  it("leaves out a kind with no rows and never drops an unknown capability", () => {
    const out = groupRows([cap("meta_ads"), cap("something_new")]);
    expect(out.map((g) => g.key)).toEqual(["ads", "other"]);
    expect(out[1]?.rows).toEqual([cap("something_new")]);
    expect(groupRows([])).toEqual([]);
  });
});

describe("the step columns", () => {
  it("counts the rows on each station", () => {
    expect(stationCounts([{ station: 2 }, { station: 2 }, { station: 4 }])).toEqual([0, 2, 0, 1]);
    expect(stationCounts([])).toEqual([0, 0, 0, 0]);
  });

  it("knows the highest station open here", () => {
    expect(highestOpen([{ ceiling: 2 }, { ceiling: 3 }])).toBe(3);
    expect(highestOpen([])).toBe(4);
  });
});

describe("saying the ceiling once", () => {
  it("names the ceiling every row shares when it is below the top", () => {
    expect(sharedCeiling([{ ceiling: 2 }, { ceiling: 2 }])).toBe(2);
  });

  it("says nothing when rows differ, when nothing is held back, or when there are no rows", () => {
    expect(sharedCeiling([{ ceiling: 2 }, { ceiling: 3 }])).toBeNull();
    expect(sharedCeiling([{ ceiling: 4 }, { ceiling: 4 }])).toBeNull();
    expect(sharedCeiling([])).toBeNull();
  });
});

describe("a row's track", () => {
  it("marks what is passed, where it stands, what is open and what is closed", () => {
    const row = { station: 2 as const, ceiling: 3 as const };
    expect([1, 2, 3, 4].map((s) => cellState(row, s))).toEqual(["below", "at", "open", "closed"]);
  });

  it("closes nothing at or below the ceiling", () => {
    const row = { station: 1 as const, ceiling: 4 as const };
    expect([1, 2, 3, 4].map((s) => cellState(row, s))).not.toContain("closed");
  });
});

describe("the control for going up a step", () => {
  it("offers nothing at the ceiling", () => {
    expect(nextMove({ station: 2, next: null, open_request: null })).toBe("ceiling");
  });

  it("waits while any rule is unmet, however many are met", () => {
    expect(nextMove({ station: 2, next: next(true, false), open_request: null })).toBe("wait");
    expect(nextMove({ station: 2, next: next(true, true), open_request: null })).not.toBe("wait");
  });

  it("raises directly below station 3", () => {
    expect(nextMove({ station: 1, next: next(true), open_request: null })).toBe("raise");
    expect(nextMove({ station: 2, next: next(true), open_request: null })).toBe("raise");
  });

  it("asks first, then confirms, for the step to acting within limits", () => {
    expect(nextMove({ station: 3, next: next(true), open_request: null })).toBe("ask");
    const open = { id: "r1", expires_at: "2026-12-01T00:00:00Z" };
    expect(nextMove({ station: 3, next: next(true), open_request: open })).toBe("confirm");
    expect(nextMove({ station: 3, next: next(false), open_request: open })).toBe("wait");
  });
});

describe("a row's record as a bar", () => {
  it("splits what was measured into gains, losses and neither, adding up to the total", () => {
    const segs = recordSegs({ closed: 7, gains: 4, losses: 1 }, (p) => p);
    expect(segs.map((s) => [s.key, s.value, s.tone])).toEqual([
      ["gains", 4, "ok"],
      ["losses", 1, "alarm"],
      ["neither", 2, "soft"],
    ]);
    expect(segs.reduce((n, s) => n + s.value, 0)).toBe(7);
  });

  it("draws nothing with no record, and never a negative remainder", () => {
    expect(recordSegs({ closed: 0, gains: 0, losses: 0 }, (p) => p)).toEqual([]);
    expect(recordSegs({ closed: 2, gains: 2, losses: 1 }, (p) => p).map((s) => s.key)).toEqual([
      "gains",
      "losses",
    ]);
  });
});
