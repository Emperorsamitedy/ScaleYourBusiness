// Idea 47 — the carts screen's words: the measured headline, the consent
// notes as counts in plain words, the range, and why the button is off.
// No ISO date and no rule number reaches the owner.

import { describe, expect, it } from "vitest";
import type { CartsScreenView } from "../../app/api/carts/route";
import type { Measured } from "./carts-view";
import {
  cartsHeadline,
  consentNotes,
  moneyList,
  proposeBlock,
  sourcesLine,
  weekLine,
  winBackText,
  windowLine,
} from "./carts-view";

const measured: Measured = {
  status: "measured",
  current: {
    from: "2026-09-29",
    to: "2026-10-28",
    started: 47,
    left: 41,
    recovered: 6,
    orders: 120,
    share_left: 41 / 161,
    value_left: [{ currency: "EUR", amount_minor: 124_000 }],
  },
  prior: null,
  prior_note: "No comparison yet: the 30 days before have 3 days of carts and 2 left.",
  products: [],
  truncated: 0,
  reach: {
    shoppers: 41,
    emailable_shoppers: 9,
    carts: { emailable: 9, no_consent: 12, suppressed: 1, not_contact: 4, no_email: 15 },
  },
  win_back: [{ currency: "EUR", base_minor: 31_000, low_minor: 930, high_minor: 3_100 }],
};

const view = (over: Partial<CartsScreenView> = {}): CartsScreenView => ({
  applies: true,
  today: "2026-10-29",
  sources: [{ label: "Shopify", read_at: "2026-10-29 06:00:00+00", carts: 52 }],
  measure: measured,
  thresholds: {
    window_days: 30,
    min_days: 14,
    min_carts: 10,
    winback_min_days: 1,
    winback_max_days: 7,
    recontact_days: 30,
  },
  reminder: {
    emailable: 3,
    in_segment: 5,
    recently_proposed: 0,
    unmatched_carts: 6,
    no_consent: 2,
    suppressed: 0,
  },
  proposal: null,
  held: null,
  ...over,
});

const noIso = (s: string) => expect(s).not.toMatch(/\d{4}-\d{2}-\d{2}|rule \d/i);

describe("the head", () => {
  it("states the measured fact as the plan words it", () => {
    const h = cartsHeadline(view());
    expect(h).toBe(
      "€1,240 was left in carts in the last 30 days; 9 of the 41 shoppers can be emailed.",
    );
    noIso(h);
  });

  it("keeps currencies apart, and says when nothing is read or it's too early", () => {
    expect(
      moneyList([
        { currency: "EUR", amount_minor: 124_000 },
        { currency: "GBP", amount_minor: 8_000 },
      ]),
    ).toBe("€1,240 and £80");
    expect(cartsHeadline(view({ applies: false }))).toBe(
      "Abandoned carts need a connected Shopify shop.",
    );
    const refused = {
      status: "refused" as const,
      from: "2026-09-29",
      to: "2026-10-28",
      days: 5,
      left: 3,
      ready_from: null,
      reason: "x",
    };
    expect(cartsHeadline(view({ measure: refused }))).toBe(
      "Too early to measure your abandoned carts.",
    );
    expect(
      cartsHeadline(
        view({ measure: refused, sources: [{ label: "Shopify", read_at: null, carts: 0 }] }),
      ),
    ).toBe("I haven't read your carts yet.");
  });

  it("the window line uses short days and the share of checkouts", () => {
    const line = windowLine(measured);
    expect(line).toMatch(
      /^29 Sept? to 28 Oct: 47 checkouts started, 41 left, 6 finished later; 25% of all checkouts left unfinished\./,
    );
    noIso(line);
  });
});

describe("who can be emailed, in words", () => {
  it("counts each kind of cart, never an address", () => {
    const notes = consentNotes(measured);
    expect(notes).toEqual([
      "9 carts are from contacts who said yes to email.",
      "12 carts are from contacts with no recorded yes to email, so they aren't emailed.",
      "4 carts are from shoppers who aren't among your contacts, so they aren't emailed.",
      "1 cart is from someone who unsubscribed or asked to be forgotten, so it isn't emailed.",
      "15 carts carry no email I can read, so they aren't matched to anyone. Shopify only says who left a cart to an app that may read your customers, and I don't ask for that.",
    ]);
    for (const n of notes) expect(n).not.toMatch(/@/);
  });

  it("says who of the reminder's week won't get one, and why", () => {
    expect(weekLine(view())).toBe(
      "Of the contacts who left a cart in the last week, 2 can't be emailed.",
    );
    expect(weekLine(view({ reminder: { ...view().reminder!, recently_proposed: 3 } }))).toBe(
      "Of the contacts who left a cart in the last week, 2 can't be emailed, and 3 were already proposed a reminder in the last 30 days.",
    );
    expect(weekLine(view({ reminder: { ...view().reminder!, no_consent: 0 } }))).toBeNull();
  });

  it("the range is per currency, and absent when nobody can be emailed", () => {
    expect(winBackText(measured)).toBe("€9.30–€31");
    expect(winBackText({ ...measured, win_back: [] })).toBeNull();
  });

  it("the sources line names the read day in short form", () => {
    const s = sourcesLine(view());
    expect(s).toMatch(/^Carts and orders: Shopify, read 29 Oct\./);
    noIso(s);
  });
});

describe("the button", () => {
  it("is off while watching, saying why", () => {
    const held = "I'm watching until 6 Nov, and I propose nothing before then.";
    expect(proposeBlock(view({ held }))).toBe(held);
  });

  it("is on with someone to remind, and off with nobody, saying why", () => {
    expect(proposeBlock(view())).toBeNull();
    expect(
      proposeBlock(view({ reminder: { ...view().reminder!, emailable: 0, recently_proposed: 2 } })),
    ).toBe(
      "Everyone who left a cart 1–7 days ago and said yes to email was proposed a reminder in the last 30 days.",
    );
    expect(proposeBlock(view({ reminder: { ...view().reminder!, emailable: 0 } }))).toBe(
      "No contact who said yes to email left a cart 1–7 days ago, so there is nobody to remind.",
    );
  });
});
