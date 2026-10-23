// Review 2026-10-23, Session D #1 — approvals that went stale. Pure: the
// windows, both sides of each boundary, and the sentences the owner reads.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { ADS } from "../ads/proposals";
import { realWritesOffSentence } from "./engine";
import {
  AD_APPROVAL_MAX_AGE_DAYS,
  PUBLISH_STALE_AFTER_MS,
  STALE_NOTE,
  dayWord,
  staleAdChange,
  stalePublish,
} from "./stale";

const due = "2026-10-31T09:00:00.000Z"; // 10:00 in Budapest
const at = (ms: number) => new Date(Date.parse(due) + ms);
const publish = (over: Record<string, unknown> = {}) => ({
  decided_at: "2026-10-20T08:00:00.000Z",
  execute_not_before: due,
  action: { kind: "content_publishing", detail: { publish_at: due, zone: "Europe/Budapest" } },
  ...over,
});

describe("Review D #1 — a publish far past its time is not posted late", () => {
  it("in time up to 30 hours after its time; one millisecond later it lapses, in words", () => {
    expect(stalePublish(publish(), at(PUBLISH_STALE_AFTER_MS))).toBeNull();
    expect(stalePublish(publish(), at(-3_600_000))).toBeNull();
    expect(stalePublish(publish(), at(PUBLISH_STALE_AFTER_MS + 1))).toBe(
      "I didn't post this — it was due on 31 October; propose it again if it still fits.",
    );
  });

  it("the owner's own time wins over the proposal's; the date is the business's own", () => {
    const later = publish({ execute_not_before: "2026-11-02T23:30:00.000Z" });
    expect(stalePublish(later, at(PUBLISH_STALE_AFTER_MS + 1))).toBeNull();
    // 23:30 UTC on 2 November is 00:30 on 3 November in Budapest.
    expect(stalePublish(later, new Date("2026-11-05T00:00:00Z"))).toMatch(/due on 3 November/);
    const noTime = publish({ execute_not_before: null });
    expect(stalePublish(noTime, at(PUBLISH_STALE_AFTER_MS + 1))).toMatch(/due on 31 October/);
    expect(stalePublish(publish({ execute_not_before: null, action: {} }), at(9e10))).toBeNull();
  });

  it("the window is long enough for the once-a-day runner: 05:00 UTC ± 59 min, a day apart", () => {
    // The worst gap between a post's time and the next run: just after a run at
    // 04:01, the next one as late as 05:59 the day after.
    const worst = 24 * 3_600_000 + 2 * 59 * 60_000;
    expect(PUBLISH_STALE_AFTER_MS).toBeGreaterThan(worst);
  });
});

describe("Review D #1 — an ad change approved too long ago is not made", () => {
  const approved = "2026-10-01T12:00:00.000Z";
  const ad = { decided_at: approved, execute_not_before: approved, action: { detail: {} } };
  const days = (n: number) => new Date(Date.parse(approved) + n * 86_400_000);

  it("in time for 14 days after approval; after that it lapses, in words", () => {
    expect(staleAdChange(ad, days(AD_APPROVAL_MAX_AGE_DAYS))).toBeNull();
    expect(staleAdChange(ad, new Date(days(AD_APPROVAL_MAX_AGE_DAYS).getTime() + 1))).toBe(
      "I didn't make this change — you approved it on 1 October, and the numbers behind it are more than 14 days old now. Nothing was changed; it needs proposing again on fresh numbers.",
    );
    expect(staleAdChange({ ...ad, decided_at: null }, days(400))).toBeNull();
  });

  it("the age is the same span an ad proposal lives undecided", () => {
    expect(AD_APPROVAL_MAX_AGE_DAYS).toBe(ADS.expiry_days);
  });
});

describe("Review D #1 — the gate's sentence says what really happens once it is on", () => {
  it("Meta's providers say an approval goes out only while timely; one with nothing to go stale keeps the old line", () => {
    const pub = realWritesOffSentence("Meta publishing", STALE_NOTE.meta_publish);
    expect(pub).not.toMatch(/goes out on the first run after it is switched on/);
    expect(pub).toMatch(/within 30 hours of its time; later than that it isn't posted late/);
    expect(realWritesOffSentence("Meta ad management", STALE_NOTE.meta_ads)).toMatch(
      /approved it within the last 14 days/,
    );
    expect(realWritesOffSentence("Campaign email")).toMatch(
      /this stays approved\. It goes out on the first run after it is switched on\.$/,
    );
  });

  it("a day word falls back to UTC for an unknown zone", () => {
    expect(dayWord(Date.parse("2026-10-31T23:30:00Z"), "Not/AZone")).toBe("31 October");
    expect(dayWord(Date.parse("2026-10-31T23:30:00Z"), "Europe/Budapest")).toBe("1 November");
  });
});
