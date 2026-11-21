// Warnings sent at once (2026-11-20): a warning that looks ahead in pushPlan.
// Pure: no database. A warning keeps the same rules as a proposal's alert
// (the stop, no device, quiet hours, one a day) and shares the day's one
// alert; its words are fixed, never a figure or an item's name.
// Budapest is UTC+1 on 2026-11-10.

import { describe, expect, it } from "vitest";
import { wordsFor } from "../i18n/recipient";
import type { QueuedItem, QueuedReview, QueuedWarning } from "./plan";
import { WARNING_PUSH_FRESH_DAYS, isWarningKind, pushPlan, pushWords } from "./plan";

const ZONE = "Europe/Budapest";
const P = "11111111-1111-4111-8111-111111111111";
const R = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MORNING = new Date("2026-11-10T09:00:00Z"); // 10:00 in Budapest
const EVENING = new Date("2026-11-10T21:30:00Z"); // 22:30

const proposal: QueuedItem = {
  proposal_id: P,
  status: "pending",
  kind: "price_increase",
  expires_at: "2026-12-31T00:00:00.000Z",
};
const review: QueuedReview = {
  review_id: R,
  platform: "google",
  stars: 2,
  source: "email",
  alerted_at: "2026-11-10T08:30:00.000Z",
};
const warning = (id: string, over: Partial<QueuedWarning> = {}): QueuedWarning => ({
  alert_id: id,
  kind: "cash_warning",
  created_at: "2026-11-10T08:30:00.000Z",
  ...over,
});
const base = { zone: ZONE, halted: false, devices: 1, lastSentAt: null, queued: [] };

describe("a warning's own phone alert", () => {
  it("goes alone in fixed words, and taps through to its own screen", () => {
    const plan = pushPlan({ ...base, now: MORNING, warnings: [warning(W1)] });
    expect(plan).toMatchObject({ act: "send", send: [], warnings_done: [W1] });
    expect(plan.act === "send" && plan.payload).toMatchObject({
      body: "Your cash could get tight in the weeks ahead",
      url: "/cash",
    });
    const stock = pushPlan({
      ...base,
      now: MORNING,
      warnings: [warning(W1, { kind: "stock_warning" })],
    });
    expect(stock.act === "send" && stock.payload).toMatchObject({
      body: "Something you sell could run out before its next delivery",
      url: "/stock",
    });
  });

  it("counts several, and opens Home when they are of more than one kind", () => {
    const two = [warning(W1, { kind: "stock_warning" }), warning(W2, { kind: "stock_warning" })];
    expect(pushWords([], undefined, [], undefined, two)).toMatchObject({
      body: "2 warnings worth knowing",
      url: "/stock",
    });
    const mixed = [warning(W1), warning(W2, { kind: "stock_warning" })];
    expect(pushWords([], undefined, [], undefined, mixed)).toMatchObject({
      body: "2 warnings worth knowing",
      url: "/home",
    });
  });

  it("carries no figure and no name: the lock screen is public", () => {
    for (const kind of ["cash_warning", "stock_warning"]) {
      const { body } = pushWords([], undefined, [], undefined, [warning(W1, { kind })]);
      expect(body).not.toMatch(/\d|€|\$/);
    }
  });

  it("shares the day's one alert: one more sentence on the proposals' and the reviews'", () => {
    const plan = pushPlan({
      ...base,
      now: MORNING,
      queued: [proposal],
      reviews: [review],
      warnings: [warning(W1), warning(W2, { kind: "stock_warning" })],
    });
    expect(plan).toMatchObject({
      act: "send",
      send: [P],
      reviews_done: [R],
      warnings_done: [W1, W2],
    });
    expect(plan.act === "send" && plan.payload).toMatchObject({
      body: "1 thing waits for your yes, and a review worth knowing, and 2 warnings worth knowing",
      // The tap still goes to what waits for a yes.
      url: "/proposals",
    });
    const withOne = pushWords([proposal], undefined, [], undefined, [warning(W1)]);
    expect(withOne.body).toBe(
      "1 thing waits for your yes: a price change, and a warning worth knowing",
    );
    expect(withOne.url).toBe(`/proposals/${P}`);
  });

  it("holds through quiet hours and behind the day's alert, settling nothing", () => {
    const quiet = pushPlan({ ...base, now: EVENING, warnings: [warning(W1)] });
    expect(quiet).toMatchObject({ act: "hold", why: "quiet_hours", warnings_done: [] });
    const capped = pushPlan({
      ...base,
      now: MORNING,
      lastSentAt: "2026-11-10T07:30:00.000Z", // 08:30 the same local day
      warnings: [warning(W1)],
    });
    expect(capped).toMatchObject({ act: "hold", why: "daily_cap", warnings_done: [] });
  });

  it("is dropped, not held, under the emergency stop or with no device", () => {
    expect(
      pushPlan({ ...base, now: MORNING, halted: true, warnings: [warning(W1)] }),
    ).toMatchObject({ act: "drop", why: "halted", warnings_done: [W1] });
    expect(pushPlan({ ...base, now: MORNING, devices: 0, warnings: [warning(W1)] })).toMatchObject({
      act: "drop",
      why: "no_devices",
      warnings_done: [W1],
    });
  });

  it("one waiting too long, or of a kind that raises no alert, is settled without one", () => {
    const old = new Date(
      MORNING.getTime() - (WARNING_PUSH_FRESH_DAYS * 24 + 1) * 3_600_000,
    ).toISOString();
    const plan = pushPlan({
      ...base,
      now: MORNING,
      warnings: [warning(W1, { created_at: old }), warning(W2, { kind: "goal_alert" })],
    });
    expect(plan).toMatchObject({ act: "drop", why: "nothing_waiting", warnings_done: [W1, W2] });
    // Held for quiet hours, the stale one is settled and the fresh one keeps waiting.
    const held = pushPlan({
      ...base,
      now: EVENING,
      warnings: [warning(W1, { created_at: old }), warning(W2)],
    });
    expect(held).toMatchObject({ act: "hold", warnings_done: [W1] });
    expect(isWarningKind("cash_warning")).toBe(true);
    expect(isWarningKind("goal_alert")).toBe(false);
  });

  it("without warnings, the plan is exactly as before", () => {
    const plan = pushPlan({ ...base, now: MORNING, queued: [proposal] });
    expect(plan).not.toHaveProperty("warnings_done");
    expect(plan).not.toHaveProperty("warnings");
    expect(plan.act === "send" && plan.payload.body).toBe(
      "1 thing waits for your yes: a price change",
    );
  });

  it("speaks the person's language (L-6)", async () => {
    const hu = await wordsFor("hu-HU", "warningPush");
    const { body } = pushWords([], undefined, [], undefined, [warning(W1)], hu);
    expect(body).toBe("A következő hetekben szűkös lehet a pénze");
  });
});
