// Idea 53 (I-53.4): pushPlan at its boundaries. Pure: no database.
// Budapest is UTC+1 on 2026-11-10 (winter) and UTC+2 on 2026-07-10 (summer).

import { describe, expect, it } from "vitest";
import type { QueuedItem } from "./plan";
import { inQuietHours, kindWords, nextMorning, pushPlan, pushWords } from "./plan";

const ZONE = "Europe/Budapest";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const item = (id: string, over: Partial<QueuedItem> = {}): QueuedItem => ({
  proposal_id: id,
  status: "pending",
  kind: "price_increase",
  expires_at: "2026-12-31T00:00:00.000Z",
  ...over,
});

const at = (iso: string) => new Date(iso);
const base = {
  zone: ZONE,
  halted: false,
  devices: 1,
  lastSentAt: null,
  queued: [item(A)],
};

describe("quiet hours, 21:00 to 08:00 in the business's zone", () => {
  it("07:59 local is quiet, 08:00 is not", () => {
    expect(inQuietHours(at("2026-11-10T06:59:00Z"), ZONE)).toBe(true);
    expect(inQuietHours(at("2026-11-10T07:00:00Z"), ZONE)).toBe(false);
  });

  it("20:59 local is not quiet, 21:00 is", () => {
    expect(inQuietHours(at("2026-11-10T19:59:00Z"), ZONE)).toBe(false);
    expect(inQuietHours(at("2026-11-10T20:00:00Z"), ZONE)).toBe(true);
  });

  it("follows daylight saving: 08:00 in July is 06:00 UTC", () => {
    expect(inQuietHours(at("2026-07-10T05:59:00Z"), ZONE)).toBe(true);
    expect(inQuietHours(at("2026-07-10T06:00:00Z"), ZONE)).toBe(false);
  });

  it("holds an evening proposal until 08:00 the next morning", () => {
    const plan = pushPlan({ ...base, now: at("2026-11-10T20:30:00Z") });
    expect(plan).toMatchObject({ act: "hold", why: "quiet_hours", keep: [A] });
    expect(plan.act === "hold" && plan.until).toBe("2026-11-11T07:00:00.000Z");
  });

  it("holds a 03:00 proposal until 08:00 the same morning", () => {
    expect(nextMorning(at("2026-11-11T02:00:00Z"), ZONE).toISOString()).toBe(
      "2026-11-11T07:00:00.000Z",
    );
  });

  it("sends a held proposal at 08:00", () => {
    const plan = pushPlan({ ...base, now: at("2026-11-11T07:00:00Z") });
    expect(plan.act).toBe("send");
  });

  it("uses the zone it is given, not the server's", () => {
    // 20:30 UTC is 15:30 in New York: not quiet there.
    expect(
      pushPlan({ ...base, zone: "America/New_York", now: at("2026-11-10T20:30:00Z") }).act,
    ).toBe("send");
  });
});

describe("at most one alert a day (ux-spec §9)", () => {
  it("holds a second alert the same local day until the next 08:00", () => {
    const plan = pushPlan({
      ...base,
      now: at("2026-11-10T15:00:00Z"),
      lastSentAt: "2026-11-10T07:05:00Z",
    });
    expect(plan).toMatchObject({ act: "hold", why: "daily_cap" });
    expect(plan.act === "hold" && plan.until).toBe("2026-11-11T07:00:00.000Z");
  });

  it("sends once the local day has turned, even under 24 hours later", () => {
    const plan = pushPlan({
      ...base,
      now: at("2026-11-11T07:00:00Z"),
      lastSentAt: "2026-11-10T19:30:00Z",
    });
    expect(plan.act).toBe("send");
  });

  it("counts the day in the business's zone: 23:30 UTC is already tomorrow in Budapest", () => {
    // Last sent 23:30 UTC on the 10th = 00:30 on the 11th locally (quiet, so it can't have been
    // sent then in practice, but the day arithmetic must still be the zone's).
    const plan = pushPlan({
      ...base,
      now: at("2026-11-11T09:00:00Z"),
      lastSentAt: "2026-11-10T23:30:00Z",
    });
    expect(plan).toMatchObject({ act: "hold", why: "daily_cap" });
  });
});

describe("grouping, and what the alert says", () => {
  it("one proposal: its kind in a few words, and its own card", () => {
    const plan = pushPlan({ ...base, now: at("2026-11-10T10:00:00Z") });
    expect(plan).toMatchObject({
      act: "send",
      send: [A],
      payload: {
        title: "SYB",
        body: "1 thing waits for your yes: a price change",
        url: `/proposals/${A}`,
      },
    });
  });

  it("several made in one run: one alert, a count, and the queue", () => {
    const plan = pushPlan({
      ...base,
      now: at("2026-11-10T10:00:00Z"),
      queued: [item(A), item(B, { kind: "customer_email" }), item(C)],
    });
    expect(plan).toMatchObject({
      act: "send",
      send: [A, B, C],
      payload: { body: "3 things wait for your yes", url: "/proposals" },
    });
  });

  it("never puts a proposal's own words on the lock screen", () => {
    const body = pushWords([item(A, { kind: "customer_email" })]).body;
    expect(body).toBe("1 thing waits for your yes: an email to customers");
    expect(body).not.toMatch(/\d{2,}|€|Ft|\$|@/);
  });

  it("names an unknown kind 'a proposal', never its free text", () => {
    expect(kindWords("something_new")).toBe("a proposal");
    expect(kindWords(null)).toBe("a proposal");
  });
});

describe("what is never sent", () => {
  it("nothing while the emergency stop is on, and the queue is dropped, not held", () => {
    const plan = pushPlan({ ...base, now: at("2026-11-10T10:00:00Z"), halted: true });
    expect(plan).toEqual({ act: "drop", why: "halted", drop: [A] });
  });

  it("nothing for a blocked proposal", () => {
    const plan = pushPlan({
      ...base,
      now: at("2026-11-10T10:00:00Z"),
      queued: [item(A, { status: "blocked" })],
    });
    expect(plan).toEqual({ act: "drop", why: "nothing_waiting", drop: [A] });
  });

  it("drops what was decided or expired meanwhile, and sends the rest", () => {
    const plan = pushPlan({
      ...base,
      now: at("2026-11-10T10:00:00Z"),
      queued: [
        item(A, { status: "approved" }),
        item(B, { expires_at: "2026-11-10T09:59:59.000Z" }),
        item(C),
      ],
    });
    expect(plan).toMatchObject({ act: "send", send: [C], drop: [A, B] });
    expect(plan.act === "send" && plan.payload.url).toBe(`/proposals/${C}`);
  });

  it("an expiry exactly now counts as expired", () => {
    const plan = pushPlan({
      ...base,
      now: at("2026-11-10T10:00:00Z"),
      queued: [item(A, { expires_at: "2026-11-10T10:00:00.000Z" })],
    });
    expect(plan.act).toBe("drop");
  });

  it("no device: dropped, so a phone switched on later doesn't get old alerts", () => {
    const plan = pushPlan({ ...base, now: at("2026-11-10T10:00:00Z"), devices: 0 });
    expect(plan).toEqual({ act: "drop", why: "no_devices", drop: [A] });
  });

  it("quiet hours hold the pending ones but still drop the stale ones", () => {
    const plan = pushPlan({
      ...base,
      now: at("2026-11-10T22:00:00Z"),
      queued: [item(A), item(B, { status: "rejected" })],
    });
    expect(plan).toMatchObject({ act: "hold", keep: [A], drop: [B] });
  });
});
