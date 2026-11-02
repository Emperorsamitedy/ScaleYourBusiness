// L-3b: the simulator's catalogue says in English exactly what the code's
// own labels say, and its figures follow the reader's locale.

import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { MEASURES, MEASURE_LABEL, valueText } from "../../lib/simulate/model";
import {
  PRICE_MEASURES,
  PRICE_MEASURE_LABEL,
  periodWords,
  unitNoun,
} from "../../lib/simulate/pricing";
import { englishTr } from "../../lib/i18n/tr";
import { periodText, stepLabel } from "./pricing-view";
import { KIND_LABEL, sharePct } from "./view";

describe("the simulator's English is the code's own words", () => {
  it("names each measure, price measure and kind as lib/simulate does", () => {
    for (const m of MEASURES) expect(en.simulate.measure[m], m).toBe(MEASURE_LABEL[m]);
    for (const m of PRICE_MEASURES) {
      expect(en.simulate.pricing.measure[m], m).toBe(PRICE_MEASURE_LABEL[m]);
    }
    for (const [k, word] of Object.entries(KIND_LABEL)) {
      expect(en.simulate.kind[k as keyof typeof en.simulate.kind], k).toBe(word);
    }
  });

  it("says a unit's noun and period as lib/simulate/pricing does", () => {
    const tr = englishTr("simulate");
    for (const kind of ["offer", "service"] as const) {
      expect(periodText({ kind })).toBe(periodWords({ kind }));
      expect(tr("pricing.be.noun", { kind })).toBe(unitNoun({ kind }));
      expect(tr("pricing.math.volume", { kind })).toBe(unitNoun({ kind }));
    }
  });
});

describe("the simulator's figures in the reader's locale", () => {
  it("keeps English's own grammar, and writes German's", () => {
    expect(valueText({ low: 123456, high: 123456 }, "money", "EUR", true)).toBe("€1,235");
    expect(valueText({ low: 123456, high: 123456 }, "money", "EUR", true, "de-DE")).toBe("1.235 €");
    expect(valueText({ low: 0.125, high: 0.25 }, "rate", "EUR", false, "de-DE")).toBe(
      "12,5 % – 25,0 %",
    );
    expect(sharePct(0.2)).toBe("20%");
    expect(sharePct(0.2, "zh-Hans")).toBe("20%");
    expect(stepLabel(-0.05, "de-DE")).toBe("−5 %");
  });
});
