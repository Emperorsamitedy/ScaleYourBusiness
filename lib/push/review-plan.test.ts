// I-45d: review alerts in pushPlan. Pure: no database. A review alert keeps
// the same rules as a proposal's (the stop, no device, quiet hours, one a
// day) and shares the day's one alert; its words are the platform and the
// stars, never the reviewer or the review's words.
// Budapest is UTC+1 on 2026-11-10.

import { describe, expect, it } from "vitest";
import { wordsFor } from "../i18n/recipient";
import type { QueuedItem, QueuedReview } from "./plan";
import { REVIEW_PUSH_FRESH_DAYS, pushPlan, pushWords, reviewWords } from "./plan";

const ZONE = "Europe/Budapest";
const P = "11111111-1111-4111-8111-111111111111";
const R1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const R2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MORNING = new Date("2026-11-10T09:00:00Z"); // 10:00 in Budapest
const EVENING = new Date("2026-11-10T21:30:00Z"); // 22:30

const proposal: QueuedItem = {
  proposal_id: P,
  status: "pending",
  kind: "price_increase",
  expires_at: "2026-12-31T00:00:00.000Z",
};
const review = (id: string, over: Partial<QueuedReview> = {}): QueuedReview => ({
  review_id: id,
  platform: "google",
  stars: 2,
  source: "email",
  alerted_at: "2026-11-10T08:30:00.000Z",
  ...over,
});
const base = { zone: ZONE, halted: false, devices: 1, lastSentAt: null, queued: [] };

describe("I-45d — a review alert's own alert", () => {
  it("goes alone as the platform and the stars, and taps through to /reviews", () => {
    const plan = pushPlan({ ...base, now: MORNING, reviews: [review(R1)] });
    expect(plan).toMatchObject({
      act: "send",
      send: [],
      reviews_done: [R1],
      payload: { title: "SYB", body: "A 2-star review on Google", url: "/reviews" },
    });
  });

  it("words an unrated one, another site, and several", () => {
    expect(reviewWords(review(R1, { stars: null, platform: "trustpilot" }))).toBe(
      "A review worth reading on Trustpilot",
    );
    expect(reviewWords(review(R1, { stars: 1, platform: "other" }))).toBe(
      "A 1-star review on another site",
    );
    expect(pushWords([], undefined, [review(R1), review(R2)])).toMatchObject({
      body: "2 reviews worth knowing",
      url: "/reviews",
    });
  });

  it("shares the day's one alert with proposals: one alert for both", () => {
    const plan = pushPlan({ ...base, now: MORNING, queued: [proposal], reviews: [review(R1)] });
    expect(plan).toMatchObject({
      act: "send",
      send: [P],
      reviews_done: [R1],
      payload: {
        body: "1 thing waits for your yes, and a review worth knowing",
        url: "/proposals",
      },
    });
  });

  it("holds through quiet hours and behind the day's alert, settling nothing", () => {
    expect(pushPlan({ ...base, now: EVENING, reviews: [review(R1)] })).toMatchObject({
      act: "hold",
      why: "quiet_hours",
      reviews_done: [],
    });
    expect(
      pushPlan({
        ...base,
        now: MORNING,
        lastSentAt: "2026-11-10T07:30:00.000Z",
        reviews: [review(R1)],
      }),
    ).toMatchObject({ act: "hold", why: "daily_cap", reviews_done: [] });
  });

  it("is dropped, not held, under the emergency stop or with no device", () => {
    expect(pushPlan({ ...base, now: MORNING, halted: true, reviews: [review(R1)] })).toEqual({
      act: "drop",
      why: "halted",
      drop: [],
      reviews_done: [R1],
    });
    expect(pushPlan({ ...base, now: MORNING, devices: 0, reviews: [review(R1)] })).toMatchObject({
      act: "drop",
      why: "no_devices",
      reviews_done: [R1],
    });
  });

  it("a pasted review, or one waiting too long, is settled without an alert", () => {
    const old = new Date(MORNING.getTime() - (REVIEW_PUSH_FRESH_DAYS + 1) * 86_400_000);
    const plan = pushPlan({
      ...base,
      now: MORNING,
      reviews: [review(R1, { source: "paste" }), review(R2, { alerted_at: old.toISOString() })],
    });
    expect(plan).toEqual({
      act: "drop",
      why: "nothing_waiting",
      drop: [],
      reviews_done: [R1, R2],
    });
    // Held overnight, the stale one is still settled so it never goes late.
    const held = pushPlan({
      ...base,
      now: EVENING,
      reviews: [review(R1), review(R2, { alerted_at: old.toISOString() })],
    });
    expect(held).toMatchObject({ act: "hold", reviews_done: [R2] });
  });

  it("without reviews, the plan is exactly as before", () => {
    const plan = pushPlan({ ...base, now: MORNING, queued: [proposal] });
    expect(plan).not.toHaveProperty("reviews_done");
    expect(plan).not.toHaveProperty("reviews");
    expect(pushPlan({ ...base, now: MORNING, halted: true, queued: [proposal] })).toEqual({
      act: "drop",
      why: "halted",
      drop: [P],
    });
  });

  it("speaks the person's language (L-6)", async () => {
    const de = await wordsFor("de-DE", "reviewPush");
    const push = await wordsFor("de-DE", "push");
    expect(pushWords([], push, [review(R1)], de).body).toBe(
      "Eine Bewertung mit 2 Sternen auf Google",
    );
    const ru = await wordsFor("ru-RU", "reviewPush");
    expect(reviewWords(review(R1, { stars: 1 }), ru)).toBe("Отзыв на 1 звезду на Google");
  });
});
