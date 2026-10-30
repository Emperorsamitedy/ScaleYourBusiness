// Idea 47 — the cart arithmetic, pure, tested at its boundaries both ways.
//
//   · Rule 25: under 14 days of carts or under 10 carts left, nothing is
//     measured, and the refusal says how many and when it will be ready.
//   · Left is unfinished; the share left counts the orders the sync counted.
//   · Money per currency, never added across.
//   · The win-back range is the named rule of thumb on the emailable carts
//     only, and the window before is compared only when it passes too.

import { describe, expect, it } from "vitest";
import { shiftDay } from "../anomaly/baseline";
import type { CartFact, CartReach } from "./measure";
import { CARTS, WIN_BACK, coveredDays, dayWords, measureCarts } from "./measure";

const TODAY = "2026-10-29";
const ago = (n: number) => shiftDay(TODAY, -n);
let seq = 0;

function cart(daysAgo: number, over: Partial<CartFact> = {}): CartFact {
  seq += 1;
  return {
    ref: `c${seq}`,
    day: ago(daysAgo),
    completed: false,
    total_minor: 5_000,
    currency: "EUR",
    lines: [],
    lines_truncated: false,
    shopper: null,
    reach: "no_email",
    ...over,
  };
}

/** n left carts, one a day going back from yesterday. */
const leftCarts = (n: number, over: Partial<CartFact> = {}) =>
  Array.from({ length: n }, (_, i) => cart(1 + i, over));

describe("rule 25: refuse thin history", () => {
  it("measures at 14 days and 10 carts left", () => {
    // Ten carts over days 1..10, and the first cart read 14 days ago.
    const m = measureCarts({ today: TODAY, carts: [...leftCarts(9), cart(14)], orders: [] });
    expect(m.status).toBe("measured");
  });

  it("refuses at 13 days of carts, and says from when it will be ready", () => {
    const m = measureCarts({ today: TODAY, carts: [...leftCarts(9), cart(13)], orders: [] });
    expect(m.status).toBe("refused");
    if (m.status !== "refused") return;
    expect(m.days).toBe(13);
    expect(m.left).toBe(10);
    expect(m.ready_from).toBe("2026-10-30");
    expect(m.reason).toBe(
      "Too little to measure yet: 13 days of carts (I need 14). It will be ready from 30 Oct.",
    );
  });

  it("refuses at 9 carts left, says how many, and gives no date it can't know", () => {
    const m = measureCarts({ today: TODAY, carts: [...leftCarts(8), cart(20)], orders: [] });
    expect(m.status).toBe("refused");
    if (m.status !== "refused") return;
    expect(m.left).toBe(9);
    expect(m.ready_from).toBeNull();
    expect(m.reason).toBe(
      "Too little to measure yet: 9 carts left in the last 30 days (I need 10). It will be ready once 10 carts are left within 30 days.",
    );
  });

  it("a finished checkout isn't a cart left, so it doesn't count toward the ten", () => {
    const carts = [...leftCarts(9), cart(14, { completed: true })];
    const m = measureCarts({ today: TODAY, carts, orders: [] });
    expect(m.status).toBe("refused");
  });

  it("with nothing read it says so, never a date", () => {
    const m = measureCarts({ today: TODAY, carts: [], orders: [] });
    expect(m).toMatchObject({ status: "refused", days: 0, left: 0, ready_from: null });
    if (m.status === "refused")
      expect(m.reason).toMatch(/^Too little to measure yet: no carts read yet and 0 carts/);
  });

  it("today's carts aren't in the window: it ends yesterday", () => {
    const m = measureCarts({
      today: TODAY,
      carts: [...leftCarts(9), cart(20), cart(0)],
      orders: [],
    });
    expect(m.status).toBe("measured");
    if (m.status === "measured") expect(m.current.left).toBe(10);
    expect(coveredDays(ago(0), ago(30), ago(1))).toBe(0);
    expect(coveredDays(ago(30), ago(30), ago(1))).toBe(30);
    expect(coveredDays(ago(45), ago(30), ago(1))).toBe(30);
  });
});

// Review 2026-10-30: never a headline from a stale or partial read.
describe("freshness of the last good read", () => {
  const enough = [...leftCarts(9), cart(14)];
  const read = (ok_at: string | null, too_many = false) => [{ label: "Shopify", ok_at, too_many }];

  it("a read two days ago still measures; three days ago refuses and says when", () => {
    const fresh = measureCarts({
      today: TODAY,
      carts: enough,
      orders: [],
      reads: read(`${ago(2)}T06:00:00.000Z`),
    });
    expect(fresh.status).toBe("measured");
    const old = measureCarts({
      today: TODAY,
      carts: enough,
      orders: [],
      reads: read(`${ago(3)} 06:00:00+00`),
    });
    expect(old).toMatchObject({ status: "refused", basis: "stale", ready_from: null });
    if (old.status === "refused") {
      expect(old.reason).toBe(
        "I last read your carts from Shopify on 26 Oct, so I'm not showing a figure that may be out of date. It comes back with the next good read.",
      );
    }
  });

  it("too many checkouts to read in full refuses, naming the last full read", () => {
    const m = measureCarts({
      today: TODAY,
      carts: enough,
      orders: [],
      reads: read(`${ago(1)}T06:00:00.000Z`, true),
    });
    expect(m).toMatchObject({ status: "refused", basis: "too_many" });
    if (m.status === "refused") {
      expect(m.reason).toMatch(/more abandoned checkouts in the last 60 days than one read/);
      expect(m.reason).toMatch(/The last full read was on 28 Oct\.$/);
    }
  });

  it("thin history is still the thin refusal", () => {
    const m = measureCarts({ today: TODAY, carts: [], orders: [], reads: read(null) });
    expect(m).toMatchObject({ status: "refused", basis: "thin" });
  });
});

describe("the arithmetic", () => {
  it("left, recovered, the share left against the orders counted, and money per currency", () => {
    const carts = [
      ...leftCarts(10),
      cart(3, { completed: true, total_minor: 9_900 }),
      cart(4, { currency: "GBP", total_minor: 2_000 }),
      cart(31, { total_minor: 1 }), // the window before
    ];
    const orders = Array.from({ length: 30 }, (_, i) => ({ day: ago(1 + i), count: 1 }));
    const m = measureCarts({ today: TODAY, carts, orders });
    expect(m.status).toBe("measured");
    if (m.status !== "measured") return;
    expect(m.current).toMatchObject({
      from: "2026-09-29",
      to: "2026-10-28",
      started: 12,
      left: 11,
      recovered: 1,
      orders: 30,
    });
    expect(m.current.share_left).toBeCloseTo(11 / 41, 10);
    expect(m.current.value_left).toEqual([
      { currency: "EUR", amount_minor: 50_000 },
      { currency: "GBP", amount_minor: 2_000 },
    ]);
  });

  it("without measured orders the share is unknown, not 100%", () => {
    const m = measureCarts({ today: TODAY, carts: [...leftCarts(9), cart(20)], orders: [] });
    if (m.status !== "measured") throw new Error("expected measured");
    expect(m.current.orders).toBeNull();
    expect(m.current.share_left).toBeNull();
  });

  it("ranks products by the carts they were left in, then units, with their value", () => {
    const mug = { product_ref: "P/mug", title: "Mug", quantity: 2, unit_price_minor: 3_400 };
    const bowl = { product_ref: "P/bowl", title: "Bowl", quantity: 1, unit_price_minor: 8_900 };
    const gift = { product_ref: null, title: "Gift note", quantity: 1, unit_price_minor: 250 };
    const carts = [
      ...leftCarts(8),
      cart(2, { lines: [mug, gift] }),
      cart(3, { lines: [mug, bowl] }),
      cart(4, { lines: [bowl], completed: true }), // finished: not left behind
      cart(20),
    ];
    const m = measureCarts({ today: TODAY, carts, orders: [] });
    if (m.status !== "measured") throw new Error("expected measured");
    expect(m.products).toEqual([
      {
        product_ref: "P/mug",
        title: "Mug",
        carts: 2,
        units: 4,
        value: [{ currency: "EUR", amount_minor: 13_600 }],
      },
      {
        product_ref: "P/bowl",
        title: "Bowl",
        carts: 1,
        units: 1,
        value: [{ currency: "EUR", amount_minor: 8_900 }],
      },
    ]);
  });

  it("the window before is compared only when it passes the same tests", () => {
    const now = [...leftCarts(10)];
    const thin = measureCarts({ today: TODAY, carts: [...now, cart(40)], orders: [] });
    if (thin.status !== "measured") throw new Error("expected measured");
    expect(thin.prior).toBeNull();
    expect(thin.prior_note).toMatch(/the 30 days before have 10 days of carts and 1 left/);

    const before = Array.from({ length: 10 }, (_, i) => cart(31 + i));
    const full = measureCarts({ today: TODAY, carts: [...now, ...before, cart(50)], orders: [] });
    if (full.status !== "measured") throw new Error("expected measured");
    expect(full.prior).toMatchObject({ from: "2026-08-30", to: "2026-09-28", left: 11 });
    expect(full.prior_note).toBeNull();
  });
});

describe("who can be emailed, and the win-back range", () => {
  const reach = (r: CartReach, shopper: string | null, total = 10_000): Partial<CartFact> => ({
    reach: r,
    shopper,
    total_minor: total,
  });

  it("counts shoppers by hash and carts without one, and takes the range from the emailable carts only", () => {
    const carts = [
      cart(1, reach("emailable", "h:a", 10_000)),
      cart(2, reach("emailable", "h:a", 5_000)), // the same shopper twice
      cart(3, reach("emailable", "h:b", 20_000)),
      cart(4, reach("no_consent", "h:c")),
      cart(5, reach("suppressed", "h:d")),
      cart(6, reach("not_contact", "h:e")),
      cart(7, reach("no_email", null)),
      cart(8, reach("no_email", null)),
      cart(9, reach("no_email", null)),
      cart(10, reach("no_email", null)),
      cart(20, reach("no_email", null)),
    ];
    const m = measureCarts({ today: TODAY, carts, orders: [] });
    if (m.status !== "measured") throw new Error("expected measured");
    expect(m.reach).toEqual({
      shoppers: 5 + 5, // five hashes, five carts without an address
      emailable_shoppers: 2,
      carts: { emailable: 3, no_consent: 1, suppressed: 1, not_contact: 1, no_email: 5 },
    });
    expect(m.win_back).toEqual([
      {
        currency: "EUR",
        base_minor: 35_000,
        low_minor: 35_000 * WIN_BACK.low,
        high_minor: 35_000 * WIN_BACK.high,
      },
    ]);
  });

  it("no emailable shopper: no range at all, rather than a zero that looks measured", () => {
    const m = measureCarts({ today: TODAY, carts: [...leftCarts(9), cart(20)], orders: [] });
    if (m.status !== "measured") throw new Error("expected measured");
    expect(m.reach.emailable_shoppers).toBe(0);
    expect(m.win_back).toEqual([]);
  });

  it("the rule of thumb is named and labelled, and rounds to whole minor units", () => {
    expect(WIN_BACK.label).toBe("ASSUMED");
    expect(WIN_BACK.statement).toMatch(/not your number/);
    const m = measureCarts({
      today: TODAY,
      carts: [
        cart(1, reach("emailable", "h:x", 1_234)),
        ...leftCarts(8, { day: ago(2) }),
        cart(20),
      ],
      orders: [],
    });
    if (m.status !== "measured") throw new Error("expected measured");
    expect(m.win_back[0]).toMatchObject({ low_minor: 37, high_minor: 123 });
    expect(Number.isInteger(m.win_back[0]!.low_minor)).toBe(true);
  });

  it("thresholds are pinned", () => {
    expect(CARTS).toMatchObject({
      window_days: 30,
      min_days: 14,
      min_carts: 10,
      retention_days: 90,
    });
    expect(dayWords("2026-11-06")).toBe("6 Nov");
  });
});
