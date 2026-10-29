// I-54.4 — the track record in words. Pure. A miss reads as plainly as a
// hit, "can't tell" is never counted as right, and under three graded
// forecasts it says it is too soon to judge.

import { describe, expect, it } from "vitest";
import type { TrackRow } from "./view";
import { rangeWords, trackView } from "./view";

const TODAY = "2026-11-20";
let n = 0;

function row(over: Partial<TrackRow> = {}): TrackRow {
  n += 1;
  // A distinct minute on 12 Oct for each row, as Postgres prints a timestamp.
  const hh = String(Math.floor(n / 60)).padStart(2, "0");
  const at = `2026-10-12 ${hh}:${String(n % 60).padStart(2, "0")}:00+00`;
  return {
    id: `f${n}`,
    kind: "season_week",
    made_at: at,
    recorded_at: at,
    subject: "revenue",
    subject_ref: { source: "Shopify" },
    unit: "money",
    window_start: "2026-11-02",
    window_end: "2026-11-08",
    low_minor: 370_000,
    high_minor: 450_000,
    currency: "EUR",
    low_num: null,
    high_num: null,
    low_date: null,
    high_date: null,
    claim: "The week of 2 Nov to 8 Nov: €3,700–€4,500 of revenue.",
    basis: "Last year the same week ran 1.9–2.3× your normal week.",
    graded_at: "2026-11-10 06:00:00+00",
    verdict: "inside",
    actual_note: "It came to €4,120, measured by Shopify: inside the range.",
    ...over,
  };
}

const waiting = (over: Partial<TrackRow> = {}) =>
  row({ graded_at: null, verdict: null, actual_note: null, ...over });

describe("the headline", () => {
  it("counts graded forecasts once there are three, misses included", () => {
    const v = trackView(
      [
        row(),
        row(),
        row({
          verdict: "above",
          actual_note: "It came to €5,010: €510 over the top of the range.",
        }),
        row({
          verdict: "below",
          actual_note: "It came to €3,100: €600 under the bottom of the range.",
        }),
      ],
      TODAY,
    );
    expect(v.too_soon).toBe(false);
    expect(v.headline).toBe("2 of my last 4 forecasts landed inside the range I gave; 2 missed.");
  });

  it("is too soon to judge under three graded, and says how many wait", () => {
    const v = trackView([row(), row({ verdict: "above" }), waiting(), waiting()], TODAY);
    expect(v.too_soon).toBe(true);
    expect(v.headline).toBe(
      "Too soon to judge my forecasts: 2 graded so far, 2 forecasts waiting for their time to pass.",
    );
  });

  it("never counts can't tell as right — it is named and kept apart", () => {
    const v = trackView(
      [
        row(),
        row(),
        row({ verdict: "below" }),
        row({ verdict: "cant_tell", actual_note: "1 day wasn't measured." }),
      ],
      TODAY,
    );
    expect(v).toMatchObject({ graded: 3, inside: 2, cant_tell: 1 });
    expect(v.headline).toMatch(/^2 of my last 3 forecasts landed inside/);
    expect(v.headline).toMatch(/I couldn't tell on 1: .* It isn't counted either way\.$/);
    // Three can't-tells are not three graded forecasts.
    const unsure = trackView(
      [row({ verdict: "cant_tell" }), row({ verdict: "cant_tell" }), row({ verdict: "cant_tell" })],
      TODAY,
    );
    expect(unsure.too_soon).toBe(true);
    expect(unsure.headline).toMatch(/^Too soon to judge my forecasts: none graded so far/);
  });

  it("says so when there is nothing on record", () => {
    expect(trackView([], TODAY).headline).toMatch(/^No forecasts on record yet/);
  });
});

describe("each forecast", () => {
  it("lists a miss in the same shape as a hit, with how far off it was", () => {
    const v = trackView(
      [
        row(),
        row({
          verdict: "above",
          actual_note: "It came to €5,010: €510 over the top of the range.",
        }),
      ],
      TODAY,
    );
    const [miss, hit] = v.entries;
    expect(Object.keys(miss!)).toEqual(Object.keys(hit!));
    expect(miss).toMatchObject({ word: "above", range: "€3,700–€4,500" });
    expect(miss!.happened).toMatch(/€510 over the top/);
    expect(miss!.said_on).toBe("Said on 12 Oct 2026");
    expect(miss!.basis).toMatch(/^Last year/);
  });

  it("says why a waiting forecast isn't graded yet", () => {
    const open = trackView([waiting({ window_end: "2026-11-29" })], TODAY).entries[0]!;
    expect(open.word).toBe("waiting");
    expect(open.happened).toMatch(/its window closes on 29 Nov 2026/);
    const late = trackView([waiting()], TODAY).entries[0]!;
    expect(late.happened).toMatch(/waiting for Shopify's figures/);
  });

  it("marks a row written to the record days after its date (the demo's), and only that", () => {
    const back = row({ made_at: "2026-10-01 09:00:00+00", recorded_at: "2026-11-19 10:00:00+00" });
    const v = trackView([back, row()], TODAY);
    expect(v.entries.find((e) => e.id === back.id)!.backdated).toMatch(
      /^Written to the record on 19 Nov 2026, after the day it is dated: a demo example/,
    );
    expect(v.entries.find((e) => e.id !== back.id)!.backdated).toBeNull();
  });

  it("breaks the record down by kind", () => {
    const v = trackView(
      [
        row(),
        row({
          kind: "stock_out",
          unit: "date",
          low_date: "2026-11-01",
          high_date: "2026-11-03",
          verdict: "cant_tell",
        }),
        waiting({
          kind: "stock_out",
          unit: "date",
          low_date: "2026-11-21",
          high_date: "2026-11-23",
        }),
      ],
      TODAY,
    );
    expect(v.kinds.map((k) => k.sentence)).toEqual([
      "Stock run-out dates: none graded yet, 1 couldn't tell, 1 waiting.",
      "Weeks against last year: 1 of 1 inside.",
    ]);
  });
});

describe("ranges in their own units", () => {
  it("prints money, counts and dates", () => {
    expect(rangeWords(row())).toBe("€3,700–€4,500");
    expect(
      rangeWords(row({ unit: "count", subject: "orders", low_num: "74.0", high_num: "93.4" })),
    ).toBe("74–93 orders");
    expect(rangeWords(row({ unit: "date", low_date: "2026-11-01", high_date: "2026-11-03" }))).toBe(
      "1 Nov to 3 Nov 2026",
    );
  });
});
