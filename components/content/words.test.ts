// L-3c: the content screen's catalogue says in English what the code
// always said, and its figures follow the reader's locale.

import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { englishTr } from "../../lib/i18n/tr";
import { type QueueItem, contentHeadline, formatMinor, performanceLine } from "./content-view";

const tr = englishTr("content");

const item = (over: Partial<QueueItem>): QueueItem => ({
  id: "64e2a1a7-b362-4bef-9f5f-318a2d4a0aaa",
  kind: "post",
  channel_label: "instagram",
  scheduled_for: "2026-10-22",
  status: "drafted",
  publish_proposal_id: null,
  published_at: null,
  ...over,
});

describe("the content screen's English is the code's own words", () => {
  it("spells small counts as words in the headline, as it always did", () => {
    const h = (items: QueueItem[], producible = 0, blocked = 0, nextDate: string | null = null) =>
      contentHeadline({ items, producible, blocked, nextDate });
    expect(h([], 1)).toBe("Nothing drafted yet. One approved plan is ready to draft.");
    expect(h([], 3)).toBe("Nothing drafted yet. Three approved plans are ready to draft.");
    expect(h([], 12)).toBe("Nothing drafted yet. 12 approved plans are ready to draft.");
    expect(h([item({ status: "queued" }), item({ status: "published" })])).toBe(
      "1 scheduled. One posted.",
    );
    expect(h([item({ status: "queued" })])).toBe("1 scheduled. None posted.");
    expect(h([item({})])).toBe("1 draft.");
    expect(h([item({ publish_proposal_id: "a" }), item({ publish_proposal_id: "b" })])).toBe(
      "2 drafts. Two need your yes.",
    );
    expect(h([item({})], 2)).toBe("1 draft. Two more approved plans to draft.");
    expect(h([item({})], 0, 0, "Thu 22 Oct")).toBe("1 draft. The next one is due Thu 22 Oct.");
  });

  it("words each goal horizon and strip count with English's plural", () => {
    expect(tr("goals.horizon", { months: 3 })).toBe("3 months");
    expect(tr("goals.horizon", { months: 12 })).toBe("12 months");
    expect(tr("strip.shot_list", { count: 1 })).toBe("1 shot list");
    expect(tr("strip.piece", { count: 4 })).toBe("4 pieces");
    expect(tr("mediaPanel.uploaded", { count: 1 })).toBe("Clip uploaded.");
    expect(tr("mediaPanel.uploaded", { count: 3 })).toBe("3 clips uploaded.");
    expect(en.content.kind.shot_list).toBe("film this");
  });

  it("states the AI fallback's offer with and without its costs", () => {
    expect(
      tr("mediaPanel.fallback.offer", { image: "€0.04", video: "none", seconds: "5" }),
    ).toMatch(/^SYB can propose generating an image \(about €0\.04\) or a 5-second clip from/);
    expect(tr("mediaPanel.fallback.lastTry", { error: "timed out", cost: "none" })).toBe(
      "The last try: timed out.",
    );
    expect(tr("mediaPanel.fallback.lastTry", { error: "timed out", cost: "€0.04" })).toBe(
      "The last try: timed out (€0.04 charged).",
    );
  });
});

describe("the content screen's figures in the reader's locale", () => {
  it("prints costs in the business's currency the reader's way, never converting", () => {
    expect(formatMinor({ amount_minor: 4, currency: "EUR" })).toBe("€0.04");
    expect(formatMinor({ amount_minor: 4, currency: "EUR" }, "de-DE")).toBe("0,04 €");
    expect(formatMinor({ amount_minor: 50000, currency: "HUF" }, "hu-HU")).toMatch(/^500,00\sFt$/);
  });

  it("groups measured figures the reader's way", () => {
    const p = {
      verdict: "helped" as const,
      audience_metric: "reach" as const,
      age_days: 7,
      figures: { views: 2400, reach: 1240, interactions: 86 },
      arithmetic: "x",
    };
    expect(performanceLine(p)?.figures).toBe("day 7 · reach 1 240 · views 2 400 · interactions 86");
    expect(performanceLine(p, tr, "de-DE")?.figures).toBe(
      "day 7 · reach 1.240 · views 2.400 · interactions 86",
    );
  });
});
