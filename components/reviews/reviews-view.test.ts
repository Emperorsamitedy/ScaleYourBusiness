// Idea 45 (I-45.4) — the /reviews screen's words. Pure.

import { describe, expect, it } from "vitest";
import {
  GOOGLE_NEEDS,
  GOOGLE_NOT_SET_UP,
  GOOGLE_READ_NOTE,
  GOOGLE_WHAT_IT_CAN_DO,
} from "../../lib/google-business/words";
import { englishTr } from "../../lib/i18n/tr";
import type { ReviewItem } from "../../lib/review-desk/view";
import { PLATFORM_LABELS } from "../../lib/reviews/parse";
import {
  GOOGLE_NEED_KEYS,
  SETUP_STEPS,
  asideLine,
  dayLabel,
  gmailConfirmationLine,
  monthName,
  readNote,
  reviewsHeadline,
  starKey,
  starSpread,
  starTone,
  starsWords,
  thisMonth,
} from "./reviews-view";

const TODAY = "2026-10-29";

function item(
  stars: number | null,
  reviewed_at: string,
  over: Partial<ReviewItem> = {},
): ReviewItem {
  return {
    id: crypto.randomUUID(),
    platform: "google",
    platform_label: "Google",
    stars,
    reviewer: null,
    text: null,
    link: null,
    reviewed_at,
    read_by: "parser",
    source: "email",
    worth_knowing: stars !== null && stars <= 3,
    draft: null,
    drafts_left: 3,
    ...over,
  };
}

describe("the head states the month's main fact", () => {
  it("counts this month's reviews of 3 stars or fewer, of all this month's", () => {
    const reviews = [
      item(2, "2026-10-27T10:00:00Z"),
      item(3, "2026-10-12T10:00:00Z"),
      item(5, "2026-10-02T10:00:00Z"),
      item(1, "2026-09-30T10:00:00Z"), // last month: not counted
    ];
    expect(reviewsHeadline({ reviews, today: TODAY })).toBe(
      "2 reviews of 3 stars or fewer this month, of 3.",
    );
    expect(thisMonth(reviews, TODAY)).toHaveLength(3);
  });

  it("singular, none poor, none this month, none at all", () => {
    expect(reviewsHeadline({ reviews: [item(1, "2026-10-01T00:00:00Z")], today: TODAY })).toBe(
      "1 review of 3 stars or fewer this month, of 1.",
    );
    expect(
      reviewsHeadline({
        reviews: [item(5, "2026-10-01T00:00:00Z"), item(null, "2026-10-02T00:00:00Z")],
        today: TODAY,
      }),
    ).toBe("None of this month's 2 reviews is 3 stars or fewer.");
    expect(reviewsHeadline({ reviews: [item(4, "2026-10-01T00:00:00Z")], today: TODAY })).toBe(
      "This month's one review isn't 3 stars or fewer.",
    );
    expect(reviewsHeadline({ reviews: [item(4, "2026-09-01T00:00:00Z")], today: TODAY })).toBe(
      "No new reviews this month.",
    );
    expect(reviewsHeadline({ reviews: [], today: TODAY })).toBe("No reviews here yet.");
  });
});

describe("the list's words", () => {
  it("stars as words, never drawn", () => {
    expect(starsWords(2)).toBe("2 of 5");
    expect(starsWords(null)).toBe("No rating");
  });
  it("dates are short, with the year only when it isn't this one", () => {
    expect(dayLabel("2026-10-27T10:00:00Z", TODAY)).toBe("27 Oct");
    expect(dayLabel("2025-12-03T10:00:00Z", TODAY)).toBe("3 Dec 2025");
    expect(dayLabel("not a date", TODAY)).toBe("");
  });
  it("says how a review was read when it isn't plain", () => {
    expect(readNote({ read_by: "unread", source: "email" })).toMatch(/couldn't read/);
    expect(readNote({ read_by: "model", source: "email" })).toMatch(/check it/);
    expect(readNote({ read_by: "owner", source: "paste" })).toBe("You pasted this one.");
    expect(readNote({ read_by: "api", source: "google" })).toBe(
      "Read from your Google Business Profile.",
    );
    expect(readNote({ read_by: "parser", source: "email" })).toBeNull();
  });
  it("the aside counts what's on file and how long it's kept", () => {
    expect(asideLine({ reviews: [item(2, "2026-10-01T00:00:00Z")], retention_days: 365 })).toBe(
      "1 review on file · kept 365 days",
    );
  });
  it("setup steps exist for Google and Trustpilot, in plain words", () => {
    expect(SETUP_STEPS.map((s) => s.platform)).toEqual(["Google", "Trustpilot"]);
    for (const s of SETUP_STEPS) {
      for (const step of s.steps) expect(step).not.toMatch(/MX|webhook|API|DNS/);
    }
    // Review 2026-10-30: Gmail's confirmation step is spelled out.
    expect(SETUP_STEPS[0]!.steps.join(" ")).toMatch(/Gmail sends a confirmation code/);
  });

  it("Gmail's confirmation, said plainly; nothing when none came", () => {
    expect(gmailConfirmationLine({ code: "123456789", link: null })).toBe(
      "Gmail sent a confirmation code: 123456789. Enter it in Gmail's forwarding settings.",
    );
    expect(gmailConfirmationLine({ code: null, link: "https://mail-settings.google.com/x" })).toBe(
      "Gmail sent a confirmation link: open it to switch on the forwarding.",
    );
    expect(gmailConfirmationLine(null)).toBeNull();
  });
});

describe("the star spread", () => {
  const at = "2026-10-01T00:00:00Z";

  it("counts the listed reviews per rating, 5 down to 1", () => {
    const spread = starSpread([item(5, at), item(5, at), item(4, at), item(2, at), item(1, at)]);
    expect(spread.map((s) => [s.key, s.count])).toEqual([
      ["5", 2],
      ["4", 1],
      ["3", 0],
      ["2", 1],
      ["1", 1],
    ]);
    expect(spread.map((s) => starTone(s.stars))).toEqual(["ok", "ok", "soft", "alarm", "alarm"]);
  });

  it("adds a row for reviews with no rating only when there are any", () => {
    const spread = starSpread([item(null, at), item(3, at), item(null, at)]);
    expect(spread).toHaveLength(6);
    expect(spread.at(-1)).toEqual({ key: "none", stars: null, count: 2 });
    expect(starTone(null)).toBe("hollow");
    expect(starKey(null)).toBe("none");
    expect(starSpread([])).toHaveLength(5);
    expect(starSpread([]).every((s) => s.count === 0)).toBe(true);
  });
});

describe("L-3b: the words come from the catalogue, English unchanged", () => {
  it("says the Google card's fixed lines in English exactly as lib/google-business/words does", () => {
    const tr = englishTr("reviews");
    expect(tr("google.whatItCanDo")).toBe(GOOGLE_WHAT_IT_CAN_DO);
    expect(tr("google.notSetUp")).toBe(GOOGLE_NOT_SET_UP);
    expect(GOOGLE_NEED_KEYS.map((k) => tr(`google.needs.${k}`))).toEqual([...GOOGLE_NEEDS]);
    expect(tr("google.readNote")).toBe(GOOGLE_READ_NOTE);
    expect(tr("platform.other")).toBe(PLATFORM_LABELS.other);
  });

  it("writes dates, months and star counts the reader's way outside English", () => {
    expect(dayLabel("2026-10-27T10:00:00Z", TODAY, "de-DE")).toBe("27. Okt.");
    expect(dayLabel("2025-12-03T10:00:00Z", TODAY, "de-DE")).toBe("3. Dez. 2025");
    expect(monthName(TODAY, englishTr("reviews"), "ru-RU")).toBe("октябрь");
    expect(monthName(TODAY)).toBe("October");
    expect(monthName("")).toBe("this month");
    expect(starsWords(2, englishTr("reviews"), "zh-Hans")).toBe("2 of 5");
  });
});
