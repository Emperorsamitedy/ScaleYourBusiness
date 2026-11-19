// Idea 47 — the carts screen's words: the measured headline, the consent
// notes as counts in plain words, the range, and why the button is off.
// No ISO date and no rule number reaches the owner.

import { describe, expect, it } from "vitest";
import type { CartsScreenView } from "../../app/api/carts/route";
import type { CartsWords, Measured } from "./carts-view";
import {
  cartsHeadline,
  checkoutConsentNotes,
  refusalTitle,
  consentNotes,
  funnelRows,
  moneyList,
  proposeBlock,
  sourcesLine,
  valueBars,
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
      basis: "thin" as const,
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
    // Review 2026-10-30: a stale or partial read says so.
    const read = [{ label: "Shopify", read_at: "2026-10-20 06:00:00+00", carts: 12 }];
    expect(cartsHeadline(view({ measure: { ...refused, basis: "stale" }, sources: read }))).toBe(
      "Your carts haven't been read lately.",
    );
    expect(cartsHeadline(view({ measure: { ...refused, basis: "too_many" }, sources: read }))).toBe(
      "Too many checkouts to read in full.",
    );
    expect(refusalTitle({ ...refused, basis: "too_many" })).toBe("Too many checkouts to read");
    expect(refusalTitle(refused)).toBe("Not enough carts to measure");
  });

  it("the window line uses short days and the share of checkouts", () => {
    const line = windowLine(measured);
    expect(line).toMatch(
      /^29 Sept? to 28 Oct: 47 checkouts started, 41 left, 6 finished later; 25% of all checkouts left unfinished\./,
    );
    noIso(line);
  });
});

describe("the checkout funnel and the product bars", () => {
  // The funnel's words are new catalogue keys: a stub says which key and values each row asks for.
  const words: CartsWords = {
    tr: (key, values) =>
      values
        ? `${key}(${Object.entries(values)
            .map(([k, v]) => `${k}=${v}`)
            .join(",")})`
        : key,
    locale: "en",
  };

  it("draws the window line's three counts on the scale of those started", () => {
    expect(funnelRows(measured, words)).toEqual([
      { key: "started", label: "funnel.started", value: 47, display: "47", tone: "ink" },
      { key: "left", label: "funnel.left", value: 41, display: "41", tone: "hollow" },
      { key: "recovered", label: "funnel.recovered", value: 6, display: "6", tone: "ok" },
    ]);
  });

  it("names the window before only when it is compared", () => {
    const prior = { ...measured.current, started: 60, left: 52, recovered: 8 };
    const rows = funnelRows({ ...measured, prior, prior_note: null }, words);
    expect(rows.map((r) => r.note)).toEqual([
      "funnel.prior(days=30,count=60)",
      "funnel.prior(days=30,count=52)",
      "funnel.prior(days=30,count=8)",
    ]);
    expect(funnelRows(measured, words).some((r) => r.note?.includes("prior"))).toBe(false);
  });

  it("sets a product's value against the largest in its own currency, never another's", () => {
    const product = (product_ref: string, value: Measured["products"][number]["value"]) => ({
      product_ref,
      title: null,
      carts: 1,
      units: 1,
      value,
    });
    expect(
      valueBars([
        product("a", [{ currency: "EUR", amount_minor: 40_000 }]),
        product("b", [
          { currency: "EUR", amount_minor: 10_000 },
          { currency: "HUF", amount_minor: 900_000 },
        ]),
        product("c", [{ currency: "HUF", amount_minor: 450_000 }]),
      ]),
    ).toEqual([
      [{ currency: "EUR", share: 1 }],
      [
        { currency: "EUR", share: 0.25 },
        { currency: "HUF", share: 1 },
      ],
      [{ currency: "HUF", share: 0.5 }],
    ]);
    expect(valueBars([product("z", [{ currency: "EUR", amount_minor: 0 }])])).toEqual([
      [{ currency: "EUR", share: 0 }],
    ]);
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
      "15 carts carry no email I can read, so they aren't matched to anyone. Shopify only says who left a cart to an app that may read your customers (read_customers).",
    ]);
    for (const n of notes) expect(n).not.toMatch(/@/);
  });

  // I-47b: why a cart has no email depends on what the store's last read could see.
  it("says why a cart has no email, by whether the shopper was read", () => {
    const last = (shopper: Parameters<typeof consentNotes>[1]) =>
      consentNotes(measured, shopper).at(-1);
    expect(last("read")).toMatch(/no customer email: a draft order, or one made by an app\.$/);
    expect(last("not_granted")).toMatch(/Add read_customers to the app in Shopify's Dev Dashboard/);
    expect(last("refused")).toMatch(
      /has read_customers, but Shopify still withheld customer details/,
    );
    expect(last(null)).toBe(consentNotes(measured).at(-1));
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
    expect(winBackText(measured)).toBe("€9.30 to €31");
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
      "Everyone who left a cart 1 to 7 days ago and said yes to email was proposed a reminder in the last 30 days.",
    );
    expect(proposeBlock(view({ reminder: { ...view().reminder!, emailable: 0 } }))).toBe(
      "No contact who said yes to email left a cart 1 to 7 days ago, so there is nobody to remind.",
    );
  });
});

// I-47a/I-47c: what Shopify's checkout tick did to the contacts.
describe("the checkout's yes, in words", () => {
  it("says who said yes, whose yes ended, and what was left as recorded", () => {
    expect(
      checkoutConsentNotes(view({ checkout_consent: { said_yes: 4, withdrawn: 1, differs: 2 } })),
    ).toEqual([
      "4 contacts said yes to email at Shopify's checkout, recorded with when they did. If they unsubscribe in Shopify, I stop emailing them.",
      "1 contact you recorded as a yes later unsubscribed in Shopify, so I no longer email them.",
      "Shopify lists 2 contacts as subscribed whom you recorded differently. I left those answers as you recorded.",
    ]);
  });

  it("says nothing when the tick changed nothing, or wasn't read", () => {
    expect(
      checkoutConsentNotes(
        view({ checkout_consent: { said_yes: 0, withdrawn: 0, differs: null } }),
      ),
    ).toEqual([]);
    expect(checkoutConsentNotes(view())).toEqual([]);
  });
});
