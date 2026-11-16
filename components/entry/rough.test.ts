// D90 on the screen: the free entry's peer comparison says "rough guide",
// with its reasons, in every locale — and says nothing extra when fair.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EntryResult } from "../../lib/entry/one-number";
import { LOCALES } from "../../lib/i18n/locales";
import { trFor } from "../../lib/i18n/server-tr";
import { precisionOf } from "../../lib/peers/cohort";
import { EntryResultView } from "./EntryResultView";

function result(
  businesses: number,
  widened: ("nace_3" | "nace_2" | "region" | "any_band")[],
): EntryResult {
  return {
    leak: {
      id: "no_shows",
      low_minor: 100_000,
      high_minor: 300_000,
      currency: "EUR",
      grade: "D",
      basis: { low_bp: 100, high_bp: 300, band: "b1" },
      measure: "bookings",
    } as EntryResult["leak"],
    comparison: {
      status: "served",
      metric: "revenue_per_employee",
      currency: "EUR",
      p25: 4_000_000,
      p50: 5_000_000,
      p75: 6_000_000,
      own_percentile: 40,
      cohort: {
        nace: "56",
        nace_level: 2,
        geography: { kind: "country", code: "HU" },
        band: "any",
        businesses,
        month: "2026-10",
        widened,
      },
      precision: precisionOf(businesses, widened),
      source: "syb_peer_cohort",
      as_of: "2026-10-31",
    },
    own_minor: 4_500_000,
  };
}

const html = (r: EntryResult, locale: (typeof LOCALES)[number]) =>
  renderToStaticMarkup(
    createElement(EntryResultView, { result: r, tr: trFor(locale, "entry"), locale }),
  );

describe("D90 — the entry result says when a comparison is a rough guide", () => {
  it("names each reason, in English", () => {
    const out = html(result(9, ["nace_3", "nace_2"]), "en");
    expect(out).toContain("A rough guide: only 9 businesses and a wider sector than yours.");
  });

  it("says nothing extra when the comparison is fair", () => {
    expect(html(result(40, ["nace_3"]), "en")).not.toMatch(/rough guide/i);
  });

  it("renders in every locale with the count filled in and no key left raw", () => {
    for (const locale of LOCALES) {
      const out = html(result(9, ["region"]), locale);
      expect(out, locale).toContain("9");
      expect(out, locale).not.toMatch(/peer\.rough|roughWhy/);
    }
  });
});
