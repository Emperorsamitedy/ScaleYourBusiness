// L-3c: the studio's and the site's catalogues say in English what the
// code always said, and their figures and dates follow the reader's locale.

import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { englishTr } from "../../lib/i18n/tr";
import type { SiteFinding } from "../../lib/site/audit/findings";
import { NEVER_LINES, NOT_BUILT, REFUSAL_WORDS } from "../../lib/site/audit/view";
import { FORMAT_WORD, SOURCE_WORD, dayText, timeText } from "../studio/studio-view";
import { NEVER_LINE_KEYS, euroLine, measuredValue, neverLine, speedCell } from "./site-view";

const site = englishTr("site");

describe("the studio's and the site's English are the code's own words", () => {
  it("names every citation kind and ad format as the studio's tables do", () => {
    for (const [kind, word] of Object.entries(SOURCE_WORD)) {
      expect(en.studio.source[kind as keyof typeof en.studio.source], kind).toBe(word);
    }
    for (const [format, word] of Object.entries(FORMAT_WORD)) {
      expect(en.studio.format[format as keyof typeof en.studio.format], format).toBe(word);
    }
  });

  it("says the audit's always-shown lines, refusals and not-built note as lib/site/audit does", () => {
    NEVER_LINES.forEach((line, i) => {
      expect(en.site.audit.never[NEVER_LINE_KEYS[i] ?? "reads"], line).toBe(line);
      expect(neverLine(line)).toBe(line);
    });
    expect(neverLine("A line the server added")).toBe("A line the server added");
    for (const [reason, words] of Object.entries(REFUSAL_WORDS)) {
      expect(en.site.audit.refused[reason as keyof typeof REFUSAL_WORDS], reason).toBe(words);
    }
    expect(site("audit.notBuilt", { section: 2 })).toBe(NOT_BUILT);
  });
});

const finding = (over: Partial<SiteFinding["evidence"]>, code = "lcp"): SiteFinding =>
  ({
    code,
    evidence: { basis: "lab", ...over },
  }) as unknown as SiteFinding;

describe("the site's figures in the reader's locale", () => {
  it("keeps English's figures and writes German's and French's, never converting", () => {
    const lcp = finding({ unit: "ms", metric: "lcp_ms", value: 2345 });
    expect(measuredValue(lcp)).toBe("2.3 s");
    expect(measuredValue(lcp, site, "de-DE")).toBe("2,3 s");
    expect(measuredValue(finding({ unit: "bytes", value: 3_456_000 }), site, "fr-FR")).toBe(
      "3,5 MB",
    );
    expect(measuredValue(finding({ unit: "clicks", value: 1 }))).toBe("1 click");
    expect(measuredValue(finding({ value: 404 }, "broken_link"))).toBe("status 404");

    const euro = {
      computed: true as const,
      low_minor: 120_000,
      high_minor: 340_000,
      currency: "EUR",
      per: "month" as const,
      formula: "",
      window: "",
      sources: [],
      assumed: [],
    };
    expect(euroLine(euro)).toBe("€1,200–€3,400 a month");
    expect(euroLine(euro, site, "de-DE")).toBe("1.200 €–3.400 € a month");
    expect(euroLine({ ...euro, currency: "HUF" }, site, "hu-HU")).toContain("Ft");

    const speed = {
      field: null,
      lab: { lcp_ms: 1850, cls: 0.1, tbt_ms: 240, page_bytes: 0 },
    } as unknown as Parameters<typeof speedCell>[0];
    expect(speedCell(speed)).toBe("LCP 1.9 s · CLS 0.10 · TBT 240 ms (lab)");
    expect(speedCell(speed, site, "de-DE")).toBe("LCP 1,9 s · CLS 0,10 · TBT 240 ms (lab)");
  });

  it("dates the studio's reads in the reader's language", () => {
    expect(dayText("2026-10-26T10:00:00.000Z")).toBe("26 Oct");
    expect(dayText("2026-10-26T10:00:00.000Z", "de-DE")).toBe("26. Okt.");
    expect(timeText("2026-10-27T09:05:00.000Z")).toBe("27 Oct, 09:05 UTC");
    expect(timeText("2026-10-27T09:05:00.000Z", "fr-FR")).toContain("09:05");
  });
});
