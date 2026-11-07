import { describe, expect, it } from "vitest";
import {
  adFacts,
  effectSpan,
  activeChip,
  applyReasonChip,
  approvalNote,
  changeLines,
  changeOf,
  consequence,
  durationWord,
  evidenceLines,
  isSameDay,
  originWord,
  rangeAxis,
  reviewStats,
  shortReversibility,
  chipPhrase,
  dayWord,
  effectRange,
  executeNotBefore,
  isTypingTarget,
  moveFocus,
  nextAfterDecision,
  reversibilityLabel,
  shortRef,
  signedMoney,
  stampText,
  lapsedSentence,
} from "./queue-model";

const NB = ",";

describe("changeOf — before → after only where both are stated", () => {
  it("reads text, numbers and money", () => {
    expect(changeOf({ before: "active", after: "paused" })).toEqual({
      before: "active",
      after: "paused",
    });
    expect(
      changeOf({
        before: { amount_minor: 2900, currency: "EUR" },
        after: { amount_minor: 3400, currency: "EUR" },
      }),
    ).toEqual({ before: "€29", after: "€34" });
  });

  it("refuses to invent a side that isn't there", () => {
    expect(changeOf({ before: "active" })).toBeNull();
    expect(changeOf({ rationale: "x" })).toBeNull();
    expect(changeOf(null)).toBeNull();
    expect(changeOf({ before: "", after: "paused" })).toBeNull();
  });
});

describe("effectRange — a range, never a point", () => {
  const eur = (m: number) => ({
    statement: "s",
    profit_delta_monthly: { amount_minor: m, currency: "EUR" },
  });

  it("orders the ends and signs them", () => {
    const r = effectRange(eur(34000), eur(-12000));
    expect(r?.text).toBe("−€120 to +€340");
    expect(r?.low.amount_minor).toBe(-12000);
  });

  it("is null when an end is missing or currencies differ", () => {
    expect(effectRange(eur(100), { statement: "s", profit_delta_monthly: null })).toBeNull();
    expect(effectRange(undefined, eur(100))).toBeNull();
    expect(
      effectRange(eur(100), {
        statement: "s",
        profit_delta_monthly: { amount_minor: 100, currency: "HUF" },
      }),
    ).toBeNull();
  });

  it("signs money with a true minus and leaves zero unsigned", () => {
    expect(signedMoney({ amount_minor: 0, currency: "EUR" })).toBe("€0");
    expect(signedMoney({ amount_minor: -409000, currency: "HUF" })).toBe(`−4${NB}090 HUF`);
  });
});

describe("reversibilityLabel — absent means permanent", () => {
  it("names the level when one is declared", () => {
    const r = reversibilityLabel({ level: "moderate", if_you_change_your_mind: "Undo it." });
    expect(r.reversible).toBe(true);
    expect(r.word).toBe("REVERSIBLE · MODERATE TO UNDO");
    expect(r.note).toBe("Undo it.");
  });

  it("is IRREVERSIBLE when null or unrecognised", () => {
    expect(reversibilityLabel(null).word).toBe("IRREVERSIBLE");
    expect(reversibilityLabel({ level: "sometimes" }).reversible).toBe(false);
    expect(reversibilityLabel(undefined).note).toMatch(/permanent/);
  });
});

describe("dates and the stamp", () => {
  it("puts the weekday in a deadline", () => {
    expect(dayWord("2026-10-19T12:00:00Z", "UTC")).toBe("Monday 19 October");
  });

  it("stamps with the recorded time, or labels the device clock", () => {
    const id = "3f2a9c1b-0000-4000-8000-000000000000";
    expect(shortRef(id)).toBe("3f2a9c1b");
    expect(
      stampText(id, { decision: "approved", at: "2026-10-17T14:02:00Z", clientTime: false }, "UTC"),
    ).toBe("APPROVED 14:02 · ref 3f2a9c1b");
    expect(
      stampText(id, { decision: "rejected", at: "2026-10-17T09:05:00Z", clientTime: true }, "UTC"),
    ).toBe("DECLINED 09:05 (this device's clock) · ref 3f2a9c1b");
  });
});

describe("decline reason chips", () => {
  it("fills an empty reason", () => {
    expect(applyReasonChip("", "WRONG DATA")).toBe("Wrong data");
    expect(chipPhrase("NOT MY STRATEGY")).toBe("Not my strategy");
  });

  it("swaps the chip and keeps what the owner typed", () => {
    expect(applyReasonChip("Wrong data — the stock is off", "TOO RISKY")).toBe(
      "Too risky — the stock is off",
    );
    expect(applyReasonChip("Wrong timing", "TOO RISKY")).toBe("Too risky");
    expect(applyReasonChip("we're closed in August", "WRONG TIMING")).toBe(
      "Wrong timing — we're closed in August",
    );
  });

  it("knows which chip leads", () => {
    expect(activeChip("Too risky — x")).toBe("TOO RISKY");
    expect(activeChip("Too risky business")).toBeNull();
    expect(activeChip("")).toBeNull();
  });
});

describe("keyboard and advance", () => {
  it("ignores keys typed into fields", () => {
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "SECTION" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("moves J/K within the list without wrapping", () => {
    const ids = ["a", "b", "c"];
    expect(moveFocus(ids, "a", 1)).toBe("b");
    expect(moveFocus(ids, "c", 1)).toBe("c");
    expect(moveFocus(ids, "a", -1)).toBe("a");
    expect(moveFocus(ids, null, 1)).toBe("a");
    expect(moveFocus(ids, null, -1)).toBe("c");
    expect(moveFocus([], null, 1)).toBeNull();
  });

  it("advances to the next pending below, else above, else nothing", () => {
    const order = ["a", "b", "c", "d"];
    expect(nextAfterDecision(order, ["b"], new Set(["a", "c", "d"]))).toBe("c");
    expect(nextAfterDecision(order, ["d"], new Set(["a", "c"]))).toBe("c");
    expect(nextAfterDecision(order, ["b", "c"], new Set(["a"]))).toBe("a");
    expect(nextAfterDecision(order, ["a"], new Set())).toBeNull();
  });
});

describe("schedule", () => {
  it("sends nothing for now and a floor otherwise", () => {
    const now = Date.parse("2026-10-17T10:00:00Z");
    expect(executeNotBefore("now", now)).toBeNull();
    expect(executeNotBefore("tomorrow", now)).toBe("2026-10-18T10:00:00.000Z");
    expect(executeNotBefore("next_week", now)).toBe("2026-10-24T10:00:00.000Z");
    expect(executeNotBefore("bogus", now)).toBeNull();
  });
});

describe("the design's derived lines — only from the action's own data", () => {
  const pause = {
    summary: "Pause it",
    detail: {
      change: "pause",
      campaign_name: "Autumn menu",
      spend_minor: 35000,
      measured_days: 14,
      currency: "EUR",
    },
  };
  const raise = {
    summary: "Raise it",
    detail: {
      change: "raise_budget",
      share: 0.2,
      campaign_name: "Brand awareness",
      spend_minor: 25200,
      measured_days: 21,
      currency: "EUR",
    },
  };

  it("an ad pause: average daily spend before, paused after", () => {
    expect(changeLines(pause)).toEqual([
      {
        line: "Campaign “Autumn menu”",
        sub: "daily spend, average over 14 measured days",
        before: "€25 a day",
        after: "paused · nothing spent",
      },
    ]);
  });

  it("a budget raise: the same average, then the raised one", () => {
    expect(changeLines(raise)?.[0]?.after).toBe("about €14.40 a day (+20 %)");
    expect(changeLines(raise)?.[0]?.before).toBe("€12 a day");
  });

  it("a site wording change shows the page's text before and after, in full", () => {
    const find = "dipped in our oatmeal speckle glaze. Every one is slightly different.";
    const replace =
      "dipped in our oatmeal speckle glaze. Dishwasher and microwave safe. Every one is slightly different.";
    const lines = changeLines({
      kind: "operations_change",
      summary: "On fernhill-ceramics.example: …",
      detail: { url: "https://fernhill-ceramics.example/products/mug", find, replace },
    });
    expect(lines).toEqual([
      {
        line: "The change",
        sub: "fernhill-ceramics.example/products/mug",
        before: find,
        after: replace,
      },
    ]);
  });

  it("a customer email: who gets it, with comma thousands", () => {
    const ids = Array.from({ length: 1398 }, (_, i) => `c${i}`);
    const lines = changeLines({
      summary: "Email them",
      detail: { contact_ids: ids, label: "lapsed", what: "a win-back note" },
    });
    expect(lines?.[0]).toEqual({
      line: "Audience",
      sub: "lapsed",
      before: "nobody",
      after: `1${NB}398 people`,
    });
    expect(lines?.[1]?.after).toBe("a win-back note");
  });

  it("a stated before/after wins; nothing stated means no lines", () => {
    expect(changeLines({ summary: "x", detail: { before: "on", after: "off" } })).toEqual([
      { line: "The change", sub: null, before: "on", after: "off" },
    ]);
    expect(changeLines({ summary: "x", detail: { rationale: "r" } })).toBeNull();
    expect(changeLines({ summary: "x" })).toBeNull();
    // An ad change without its measured spend is not guessed at.
    expect(
      changeLines({ summary: "x", detail: { change: "pause", campaign_name: "A" } }),
    ).toBeNull();
  });

  it("the primary button states the consequence, else APPROVE", () => {
    expect(consequence(pause)).toBe("Pause “Autumn menu”");
    expect(consequence(raise)).toBe("Raise “Brand awareness” by 20 %");
    expect(consequence({ summary: "x", detail: { contact_ids: ["a", "b"] } })).toBe(
      "Send to 2 customers",
    );
    expect(
      consequence({ summary: "x", detail: { platform: "instagram", publish_at: "2026-10-20" } }),
    ).toBe("Publish to instagram");
    expect(consequence({ summary: "x", detail: { contact_ids: [] } })).toBe("Approve");
    expect(consequence({ summary: "x" })).toBe("Approve");
  });

  it("names the origin, and falls back to the raw ref", () => {
    expect(originWord("report:abc:rec:0")).toBe("report recommendation 1");
    expect(originWord("ads:1200:pause:2026-10")).toBe("the ad review");
    expect(originWord("mystery:1")).toBe("mystery:1");
    expect(originWord(null)).toBeNull();
  });

  it("short reversibility: absent is irreversible", () => {
    expect(shortReversibility({ level: "easy" })).toBe("easy to undo");
    expect(shortReversibility(null)).toBe("irreversible");
    expect(shortReversibility({ level: "whenever" })).toBe("irreversible");
  });
});

describe("evidenceLines — source and basis from the record", () => {
  it("a recorded field gives its basis and source; no field is ASSUMED", () => {
    const lines = evidenceLines(
      [
        { statement: "Average order €67.40", source_field: "economics.aov", sensitivity: "high" },
        { statement: "A benchmark", source_field: null, sensitivity: "low" },
      ],
      { "economics.aov": { status: "answered", source_kind: "connector" } },
    );
    expect(lines[0]).toEqual({
      statement: "Average order €67.40",
      source: "measured · economics.aov",
      basis: "OBSERVED",
      leansHard: true,
    });
    expect(lines[1]).toMatchObject({ source: "no source field", basis: "ASSUMED" });
  });

  it("a named field with no current record is NOT RECORDED, never a guess", () => {
    const [line] = evidenceLines([{ statement: "x", source_field: "a.b" }], {});
    expect(line).toMatchObject({ source: "a.b", basis: "NOT RECORDED" });
    const [gap] = evidenceLines([{ statement: "x", source_field: "a.b" }], {
      "a.b": { status: "unknown", source_kind: "owner_input" },
    });
    expect(gap?.basis).toBe("NOT RECORDED");
  });
});

describe("rangeAxis — the effect on a scale through zero", () => {
  it("steps nicely and contains both ends and zero", () => {
    expect(rangeAxis(61000, 148000)).toEqual({
      scale: [0, 150000],
      ticks: [0, 50000, 100000, 150000],
    });
    const neg = rangeAxis(-12000, 30000);
    expect(neg.scale[0]).toBeLessThanOrEqual(-12000);
    expect(neg.scale[1]).toBeGreaterThanOrEqual(30000);
    expect(neg.ticks).toContain(0);
  });

  it("still has a width when both ends are zero", () => {
    const z = rangeAxis(0, 0);
    expect(z.scale[1]).toBeGreaterThan(z.scale[0]);
  });
});

describe("reviewStats — this month's decisions only", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  const row = (status: string, created: string, decided: string | null) => ({
    status,
    created_at: created,
    decided_at: decided,
  });

  it("median drafted→decided and approved of decided, this month", () => {
    const stats = reviewStats(
      [
        row("approved", "2026-10-01T10:00:00Z", "2026-10-01T10:02:00Z"), // 2 m
        row("executed", "2026-10-02T10:00:00Z", "2026-10-02T10:04:00Z"), // 4 m
        row("rejected", "2026-10-03T10:00:00Z", "2026-10-03T11:00:00Z"), // 60 m
        row("approved", "2026-09-20T10:00:00Z", "2026-09-29T10:00:00Z"), // last month
        row("expired", "2026-10-01T10:00:00Z", null), // silence is not a decision
        row("pending", "2026-10-16T10:00:00Z", null),
      ],
      now,
      "UTC",
    );
    expect(stats).toEqual({ medianMs: 4 * 60_000, approved: 2, decided: 3 });
  });

  it("is null when nothing was decided this month", () => {
    expect(reviewStats([row("expired", "2026-10-01T10:00:00Z", null)], now, "UTC")).toBeNull();
    expect(reviewStats([], now, "UTC")).toBeNull();
  });

  it("words durations at the right grain", () => {
    expect(durationWord(40_000)).toBe("40 s");
    expect(durationWord(160_000)).toBe("2 m 40 s");
    expect(durationWord(3 * 3_600_000 + 5 * 60_000)).toBe("3 h 05 m");
    expect(durationWord(52 * 3_600_000)).toBe("2 d 4 h");
  });

  it("same day is calendar-day, in the given zone", () => {
    expect(isSameDay("2026-10-17T23:30:00Z", now, "UTC")).toBe(true);
    expect(isSameDay("2026-10-16T23:30:00Z", now, "UTC")).toBe(false);
  });
});

describe("approvalNote — never promises an undo window that doesn't exist", () => {
  it("scheduled: names the time and says there is no un-approve", () => {
    const note = approvalNote({ runAt: "2026-10-19T15:00:00Z", timeZone: "UTC" });
    expect(note).toContain("no earlier than Monday 19 October, 15:00");
    expect(note).toContain("no un-approve");
    expect(note).not.toMatch(/undo until/i);
  });

  it("unscheduled: says it doesn't run by itself, and carries the proposal's own sending note", () => {
    const note = approvalNote({ runAt: null, sending: "Nothing sends on approval." });
    expect(note).toContain("doesn't run by itself");
    expect(note).toContain("Nothing sends on approval.");
  });
});

describe("the third answer's stamp", () => {
  it("reads CHANGES REQUESTED", () => {
    expect(
      stampText(
        "3f2a9c1b-0000",
        { decision: "changes_requested", at: "2026-10-17T14:02:00Z", clientTime: false },
        "UTC",
      ),
    ).toBe("CHANGES REQUESTED 14:02 · ref 3f2a9c1b");
  });
});

describe("evidenceLines — P3-23c, a line computed from measured rows", () => {
  it("shows a measured evidence line as DERIVED with its source, not ASSUMED", () => {
    const [line] = evidenceLines(
      [{ statement: "Your three Reels…", source_field: null, measured: "measured per post · x" }],
      {},
    );
    expect(line).toMatchObject({ basis: "DERIVED", source: "measured per post · x" });
    const [plain] = evidenceLines([{ statement: "a guess", source_field: null }], {});
    expect(plain?.basis).toBe("ASSUMED");
  });
});

describe("review 2026-10-23, Session D #1 — lapsedSentence", () => {
  it("an approval that lapsed says so, with its reason; an undecided expiry gets nothing", () => {
    expect(
      lapsedSentence({
        status: "expired",
        decided_at: "2026-10-01T09:00:00Z",
        execution_result: { lapsed: true, sentence: "I didn't post this." },
      }),
    ).toBe(
      "You approved this, but it lapsed before it could run — nothing ran. I didn't post this.",
    );
    expect(lapsedSentence({ status: "expired", decided_at: null })).toBeNull();
    expect(lapsedSentence({ status: "approved", decided_at: "2026-10-01T09:00:00Z" })).toBeNull();
  });
});

describe("P3-54 — an ad created paused, and its separate go-live", () => {
  const runAd = {
    kind: "paid_ads_start_or_increase",
    summary: 'Run "Autumn menu" as a Meta ad',
    detail: {
      change: "run_ad",
      ad: { name: "Autumn menu" },
      budget: { daily_minor: 500, currency: "EUR", run_days: 7, total_minor: 3_500 },
      audience: {
        location: "everyone in Hungary",
        age: "18–65+",
        interests: "left broad — Meta finds the people",
        placements: "Facebook feed, Instagram feed",
      },
      goal: "visits to your website",
      special_ad_categories: [],
      creates: ["campaign", "ad set", "creative", "ad"],
      paused_note:
        "Creates paused; going live is a separate approval; created objects can't be deleted, only paused.",
    },
  };
  it("the card states budget, duration, audience, and what can't be undone", () => {
    const ad = adFacts(runAd)!;
    expect(ad.facts.map((f) => f.label)).toEqual([
      "Budget",
      "Duration",
      "Audience",
      "Interests",
      "Placements",
      "Optimised for",
    ]);
    expect(ad.facts[0]!.value).toMatch(/5.*a day · at most .*35/);
    expect(ad.note).toBe(
      "Creates paused; going live is a separate approval; created objects can't be deleted, only paused.",
    );
    expect(changeLines(runAd)).toEqual([
      {
        line: "Ad “Autumn menu”",
        sub: "creates its campaign, ad set, creative, ad",
        before: "no ad",
        after: "on Meta, paused · spends nothing",
      },
    ]);
    expect(consequence(runAd)).toBe("Create the ad, paused");
    // Its "hard" level is the engine's irreversibility label: the card says IRREVERSIBLE.
    expect(
      reversibilityLabel({ level: "hard", if_you_change_your_mind: "x" }, { irreversible: true })
        .word,
    ).toBe("IRREVERSIBLE");
    expect(reversibilityLabel({ level: "hard" }, {}).word).toBe("REVERSIBLE · HARD TO UNDO");
    expect(effectSpan(runAd)).toBe("over 7 days");
  });
  it("going live is its own proposal: paused → live, and a plain change keeps 'a month'", () => {
    const live = {
      ...runAd,
      detail: { ...runAd.detail, change: "go_live", campaign_name: "Autumn menu" },
    };
    expect(changeLines(live)?.[0]).toMatchObject({
      before: "paused · spends nothing",
      after: /live · up to/,
    });
    expect(consequence(live)).toBe("Put the ad live");
    expect(adFacts({ summary: "x", detail: { change: "pause" } })).toBeNull();
    expect(effectSpan({ summary: "x", detail: {} })).toBe("a month");
  });
});
