// L-3b: the pipeline's catalogue names each stage as lib/pipeline does,
// and its figures follow the reader's locale.

import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { DEAL_STAGES, STAGE_LABELS } from "../../lib/pipeline/stages";
import { money as m } from "../../lib/core/money";
import { pct, roughMoney, statedPct } from "./pipeline-view";

describe("the pipeline's English is the code's own words", () => {
  it("names every stage as STAGE_LABELS does, and in a sentence in lower case", () => {
    for (const s of DEAL_STAGES) {
      expect(en.pipeline.stage[s], s).toBe(STAGE_LABELS[s]);
      expect(en.pipeline.stageInline[s], s).toBe(STAGE_LABELS[s].toLowerCase());
    }
  });
});

describe("the pipeline's figures in the reader's locale", () => {
  it("keeps English's grammar and writes German's, never converting", () => {
    expect(roughMoney(m(1_234_567, "EUR"))).toBe("€12,346");
    expect(roughMoney(m(1_234_567, "EUR"), "de-DE")).toBe("12.346 €");
    expect(roughMoney(m(1_234_567, "HUF"), "hu-HU")).toBe("12 346 Ft");
    expect(pct(0.25)).toBe("25%");
    expect(pct(0.25, "de-DE")).toBe("25 %");
    expect(statedPct(22.5)).toBe("22.5%");
    expect(statedPct(22.5, "zh-Hans")).toBe("22.5%");
  });
});
