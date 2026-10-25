import { describe, expect, it } from "vitest";
import { stepKey } from "./keys";
import type { SnapshotRow } from "./stock-history";
import { HISTORY_ITEMS, buildStockHistory } from "./stock-history";

const row = (ref: string, date: string, v: number, currency = "EUR"): SnapshotRow => ({
  connection_id: "c1",
  product_ref: ref,
  period_date: date,
  value_minor: v,
  currency,
});

describe("slow stock over time — snapshots, never sums", () => {
  it("draws one line per item through its value on each count day", () => {
    const m = buildStockHistory(
      [row("a", "2026-10-03", 50000), row("a", "2026-10-25", 47000), row("b", "2026-10-25", 9000)],
      [
        { connection_id: "c1", ref: "a", name: "Vase" },
        { connection_id: "c1", ref: "b", name: "Bowl" },
      ],
    );
    expect(m?.dates).toEqual(["2026-10-03", "2026-10-25"]);
    expect(m?.items[0]).toEqual({
      key: "c1:a",
      name: "Vase",
      points: [
        { date: "2026-10-03", cash_minor: 50000 },
        { date: "2026-10-25", cash_minor: 47000 },
      ],
    });
    // Nothing is added across days: the latest point is the latest count, not a total.
    expect(m?.items[0]?.points.at(-1)?.cash_minor).toBe(47000);
    expect(m?.summary).toMatch(/never added across days/);
  });

  it("is absent with a single count: no story over time", () => {
    expect(
      buildStockHistory(
        [row("a", "2026-10-25", 1)],
        [{ connection_id: "c1", ref: "a", name: "x" }],
      ),
    ).toBeNull();
  });

  it("two reads on one day keep the later one, never their sum", () => {
    const m = buildStockHistory(
      [row("a", "2026-10-03", 100), row("a", "2026-10-25", 300), row("a", "2026-10-25", 200)],
      [{ connection_id: "c1", ref: "a", name: "x" }],
    );
    expect(m?.items[0]?.points.at(-1)?.cash_minor).toBe(200);
  });

  it("leaves out another currency and caps the items shown", () => {
    const slow = Array.from({ length: HISTORY_ITEMS + 2 }, (_, i) => ({
      connection_id: "c1",
      ref: `r${i}`,
      name: `Item ${i}`,
    }));
    const rows = slow.flatMap((s, i) => [
      row(s.ref, "2026-10-03", 100, i === 1 ? "GBP" : "EUR"),
      row(s.ref, "2026-10-25", 90, i === 1 ? "GBP" : "EUR"),
    ]);
    const m = buildStockHistory(rows, slow);
    expect(m?.currency).toBe("EUR");
    expect(m?.other_currency).toBe(1);
    expect(m?.items.length).toBe(HISTORY_ITEMS - 1);
  });
});

describe("keyboard stepping", () => {
  it("lands on the newest first, then steps, clamps, jumps and lets go", () => {
    expect(stepKey("ArrowLeft", null, 5)).toEqual({ next: 4, handled: true });
    expect(stepKey("ArrowLeft", 4, 5)).toEqual({ next: 3, handled: true });
    expect(stepKey("ArrowLeft", 0, 5)).toEqual({ next: 0, handled: true });
    expect(stepKey("ArrowRight", 4, 5)).toEqual({ next: 4, handled: true });
    expect(stepKey("Home", 3, 5)).toEqual({ next: 0, handled: true });
    expect(stepKey("End", 0, 5)).toEqual({ next: 4, handled: true });
    expect(stepKey("Escape", 2, 5)).toEqual({ next: null, handled: true });
    expect(stepKey("a", 2, 5)).toEqual({ next: 2, handled: false });
    expect(stepKey("ArrowLeft", null, 0)).toEqual({ next: null, handled: false });
  });
});
