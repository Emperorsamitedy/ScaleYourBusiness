// L-3b: the charts' words in the catalogue (messages/en.json "charts")
// say in English exactly what the chart code always said, and the
// figures and dates beside them follow the reader's language.

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { BUCKETS, BUCKET_LABEL } from "../../lib/charts/candles";
import type { Candle } from "../../lib/charts/candles";
import {
  EVENT_WORD,
  VOLUME_WORDS,
  dayMoney,
  periodLabel,
  volumeWord,
} from "../../lib/charts/model";
import { COMPONENT_LABEL } from "../../lib/charts/opportunity";
import { CHART_ARCHETYPES } from "../../lib/charts/profiles";
import { dayFig } from "../care/CandleChart";

const t = createTranslator({ locale: "en", messages: en }) as unknown as (
  key: string,
  values?: Record<string, unknown>,
) => string;

const candle = (start: string) => ({ start }) as unknown as Candle;

describe("the charts' English is the code's own words", () => {
  it("names the periods, events and components as lib/charts does", () => {
    for (const b of BUCKETS)
      expect(t(`charts.market.period.${b}`, { count: "1" })).toBe(BUCKET_LABEL[b]);
    for (const [kind, word] of Object.entries(EVENT_WORD)) {
      expect(t(`charts.market.event.${kind}`), kind).toBe(word);
    }
    for (const [key, label] of Object.entries(COMPONENT_LABEL)) {
      expect(t(`charts.market.component.${key}`), key).toBe(label);
    }
  });

  it("has a word for every volume and price series a profile can draw", () => {
    const volumes = new Set<string>();
    const prices = new Map<string, string>();
    for (const a of Object.values(CHART_ARCHETYPES)) {
      for (const v of a.volume) volumes.add(v.word);
      for (const p of a.price) prices.set(p.metric, p.label);
    }
    expect([...volumes].sort()).toEqual([...VOLUME_WORDS].sort());
    for (const w of volumes) expect(volumeWord(w)).toBe(w);
    expect(prices.get("revenue.daily")).toBe(t("charts.market.price.revenue"));
    expect(prices.get("booking_revenue.daily")).toBe(t("charts.market.price.bookingRevenue"));
  });

  it("keeps the English period labels", () => {
    expect(periodLabel(candle("2026-10-05"), "day")).toBe("5 Oct");
    expect(periodLabel(candle("2026-10-05"), "week")).toBe("Week of 5 Oct");
    expect(periodLabel(candle("2026-10-01"), "month")).toBe("October 2026");
  });
});

describe("the charts' figures and dates in another language", () => {
  it("writes whole units the language's way, the decimals dropped as English drops them", () => {
    expect(dayMoney(123456, "EUR")).toBe("€1,234");
    expect(dayMoney(123456, "EUR", "de-DE")).toBe("1.234 €");
    expect(dayMoney(123499, "EUR", "de-DE")).toBe("1.234 €");
    expect(dayMoney(45000000, "HUF", "fr-FR")).toBe("450 000 HUF");
  });

  it("dates a candle in the language", () => {
    const words = (key: string, v?: Record<string, string | number>) => `${key}:${v?.day}`;
    expect(periodLabel(candle("2026-10-05"), "day", "de-DE")).toBe("5. Okt.");
    expect(periodLabel(candle("2026-10-05"), "week", "de-DE", words)).toBe("weekOf:5. Okt.");
    expect(periodLabel(candle("2026-10-01"), "month", "de-DE")).toBe("Oktober 2026");
  });

  it("prints a goal's per-day figure in the language", () => {
    expect(dayFig(1250, "EUR")).toBe("€12.50");
    expect(dayFig(1250, "EUR", "de-DE")).toBe("12,50 €");
    expect(dayFig(12.5, null, "fr-FR")).toBe("12,5");
  });
});
