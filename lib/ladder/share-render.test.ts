// Phase 2's gate (the v1 spec §12): "Day-30 shadow summary renders" — for a
// business with zero gains too (§4.7) — and its share link opens it and
// nothing else, can't be forged, and runs out.

import "dotenv/config";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShadowSummaryView } from "../../components/ladder/ShadowSummaryView";
import { money } from "../core/money";
import { LOCALES } from "../i18n/locales";
import { trFor } from "../i18n/server-tr";
import type { ShadowSummary } from "./shadow-summary";
import { SHARE_DAYS, readShareToken, shareToken } from "./share";

const ZERO_GAINS: ShadowSummary = {
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-10-31T00:00:00.000Z",
  changes: 3,
  gained: { count: 0, total: [] },
  nothing: 1,
  lost: { count: 2, total: [money(-3_100_000, "HUF")] },
  unproven: 0,
  still_open: 0,
  net: [money(-3_100_000, "HUF")],
};

describe("PHASE 2 GATE — the day-30 shadow summary renders", () => {
  it("renders a business with zero gains honestly, in every language", () => {
    for (const locale of LOCALES) {
      const html = renderToStaticMarkup(
        ShadowSummaryView({
          summary: ZERO_GAINS,
          tr: trFor(locale, "shadowSummary"),
          locale,
          zeroWith: "HUF",
        }),
      );
      expect(html, locale).toContain("31 000 Ft"); // the loss, in whole forints
      expect(html, locale).toContain("0 Ft"); // zero gains, said as zero
      expect(html, locale).not.toMatch(/\{(count|amount)\}/);
    }
    const en = renderToStaticMarkup(
      ShadowSummaryView({
        summary: ZERO_GAINS,
        tr: trFor("en", "shadowSummary"),
        locale: "en",
        zeroWith: "HUF",
      }),
    );
    expect(en).toMatch(/Would have gained: 0/);
    expect(en).toMatch(/Would have lost: 2/);
    expect(en).toMatch(/nothing was touched/);
  });
});

describe("§4.2 — the shareable link", () => {
  const id = "00000000-0000-4000-8000-0000000000ab";

  it("opens the business it was made for", () => {
    expect(readShareToken(shareToken(id))).toBe(id);
  });

  it("refuses a forged, altered or expired link", () => {
    const t = shareToken(id);
    expect(readShareToken(t.slice(0, -2) + (t.endsWith("A") ? "BB" : "AA"))).toBeNull();
    expect(readShareToken("nonsense")).toBeNull();
    const later = new Date(Date.now() + (SHARE_DAYS + 1) * 86_400_000);
    expect(readShareToken(t, later)).toBeNull();
  });
});
