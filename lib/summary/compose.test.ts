// Idea 42 — the weekly summary's composer, calendar and switch rules. Pure:
// no database, no network. The watch's rule is held line by line: a quiet
// week says it was quiet, a busy week says only what is on record, money
// prints through lib/core/money, and nothing a customer wrote can appear.

import { describe, expect, it } from "vitest";

process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import type { SummaryActivity, SummaryInput, SummaryReadback } from "./compose";
import { QUIET_LINE, SECTION_CAP, composeSummary, readbackLine, summarySections } from "./compose";
import { stopToken, summaryOn, summaryPref, verifyStopToken } from "./switch";
import { dayLabel, isoWeek, summaryWindow } from "./week";

const NOW = new Date("2026-10-26T06:00:00Z");

function input(over: Partial<SummaryInput> = {}): SummaryInput {
  return {
    business: "Hair & Co",
    window: summaryWindow(NOW),
    origin: "https://app.example",
    stop_url: "https://app.example/summary/stop/token",
    activity: [],
    executed: [],
    pending: [],
    open_tickets: 0,
    readbacks: [],
    provider_labels: {},
    ...over,
  };
}

const row = (at: string, kind: string, detail: string, meta: unknown = null): SummaryActivity => ({
  at,
  kind,
  detail,
  meta,
});

describe("I-42 — a quiet week", () => {
  it("says it was quiet, and nothing else", () => {
    const c = composeSummary(input());
    expect(c.quiet).toBe(true);
    expect(c.sections).toEqual([]);
    expect(c.line_count).toBe(0);
    expect(c.subject).toBe("Your week with SYB: a quiet one");
    expect(c.text).toContain(QUIET_LINE);
    expect(c.html).toContain("A quiet week");
    // Nothing invented: no section headings at all.
    expect(c.text).not.toMatch(/WAITING FOR YOU|WHAT I DID|WHAT I NOTICED/);
  });

  it("a week whose only entry is the watch holding steady says exactly that — not quiet, not busy", () => {
    const c = composeSummary(
      input({
        activity: [
          row(
            "2026-10-26 06:00:00+00",
            "snapshot_taken",
            "Weekly check: the profile held steady — nothing changed since last week.",
          ),
        ],
      }),
    );
    expect(c.quiet).toBe(false);
    expect(c.subject).toBe("Your week with SYB: nothing needs you");
    expect(c.sections.map((s) => s.key)).toEqual(["done"]);
    expect(c.text).toContain("Mon 26 Oct · Weekly check: the profile held steady");
  });

  it("a passing case for quiet needs every source empty; one open ticket breaks it", () => {
    expect(composeSummary(input({ open_tickets: 1 })).quiet).toBe(false);
  });
});

describe("I-42 — a busy week", () => {
  const busy = input({
    activity: [
      row("2026-10-21 09:00:00+00", "connector_sync", "Read 1 day of Stripe payments.", {
        provider: "stripe",
        new_days: 1,
      }),
      row("2026-10-22 09:00:00+00", "connector_sync", "Read 2 days of Stripe payments.", {
        provider: "stripe",
        new_days: 2,
      }),
      row("2026-10-20 06:00:00+00", "diff_computed", "Weekly snapshot: 2 changed since last week."),
      row(
        "2026-10-23 10:00:00+00",
        "anomaly_detected",
        "Daily revenue is below its usual range for 3 days.",
      ),
      row(
        "2026-10-23 11:00:00+00",
        "anomaly_detected",
        "Daily revenue is below its usual range for 3 days.",
      ),
      row(
        "2026-10-24 06:00:00+00",
        "goal_progress",
        "Behind the path: €1,000.00 revenue per 30 days.",
        {
          goal_id: "g1",
        },
      ),
      row("2026-10-25 06:00:00+00", "goal_progress", "On track: €1,400.00 revenue per 30 days.", {
        goal_id: "g1",
      }),
      row("2026-10-24 12:00:00+00", "content_published", "Published 'Autumn' to Instagram."),
    ],
    executed: [{ at: "2026-10-24 12:00:00+00", summary: "Publish the autumn post" }],
    pending: [
      { summary: "Raise the cut price to €42" },
      { summary: "Pause the weakest ad" },
      { summary: "Clear 12 slow candles" },
      { summary: "Try opening Sunday" },
    ],
    open_tickets: 2,
    provider_labels: { stripe: "Stripe" },
  });

  it("puts what waits first, and counts it in the subject", () => {
    const c = composeSummary(busy);
    expect(c.subject).toBe("Your week with SYB: 6 waiting for you");
    expect(c.sections.map((s) => s.key)).toEqual(["waiting", "done", "noticed", "goals"]);
    const waiting = c.sections[0]!;
    expect(waiting.lines[0]!.text).toBe(
      "4 proposals wait for your decision. Nothing runs until you approve it.",
    );
    // Three named, the rest counted.
    expect(waiting.lines.map((l) => l.text)).toContain("— and 1 more.");
    expect(waiting.lines.at(-1)!.text).toBe(
      "2 customer questions wait for your answer on Support.",
    );
    expect(c.text).toContain("https://app.example/proposals");
  });

  it("adds a source's sync days into one line, and lists a change once, not twice", () => {
    const done = composeSummary(busy).sections.find((s) => s.key === "done")!;
    const texts = done.lines.map((l) => l.text);
    expect(texts).toContain("Read 3 new days from Stripe.");
    expect(texts.some((t) => t.startsWith("Read 1 day"))).toBe(false);
    expect(texts).toContain("Made a change you approved: Publish the autumn post");
    // The publishing log line echoes the execution: left out, not doubled.
    expect(texts.some((t) => t.includes("Published 'Autumn'"))).toBe(false);
  });

  it("says a repeated notice once, and each goal's latest check only", () => {
    const sections = summarySections(busy);
    const noticed = sections.find((s) => s.key === "noticed")!;
    expect(noticed.lines).toHaveLength(1);
    const goals = sections.find((s) => s.key === "goals")!;
    expect(goals.lines.map((l) => l.text)).toEqual(["On track: €1,400.00 revenue per 30 days."]);
  });

  it("caps a long section and says how many more, with the link to all of it", () => {
    const many = Array.from({ length: SECTION_CAP + 3 }, (_, i) =>
      row(`2026-10-2${i % 6} 06:00:00+00`, "competitor_first_read", `Read competitor ${i}.`),
    );
    const done = summarySections(input({ activity: many })).find((s) => s.key === "done")!;
    expect(done.lines).toHaveLength(SECTION_CAP);
    expect(done.more).toBe(3);
    const c = composeSummary(input({ activity: many }));
    expect(c.text).toContain("- and 3 more");
    expect(c.line_count).toBe(SECTION_CAP + 3);
  });

  it("is deterministic: the same week composes to the same bytes", () => {
    expect(composeSummary(busy)).toEqual(composeSummary(busy));
  });

  it("escapes everything it prints into the HTML, and carries no image or tracking", () => {
    const c = composeSummary(
      input({ business: `<b>"Bad" & co</b>`, pending: [{ summary: "<script>x</script>" }] }),
    );
    expect(c.html).not.toContain("<script>");
    expect(c.html).toContain("&lt;script&gt;");
    expect(c.html).toContain("&lt;b&gt;&quot;Bad&quot; &amp; co&lt;/b&gt;");
    expect(c.html).not.toMatch(/<img|pixel|open\.track/i);
    // The stop link rides every email, in both parts.
    expect(c.html).toContain("https://app.example/summary/stop/token");
    expect(c.text).toContain("https://app.example/summary/stop/token");
  });
});

describe("I-42 — money in readbacks", () => {
  const base: SummaryReadback = {
    summary: "Raise the cut price",
    verdict: "helped",
    judged_on: "revenue",
    currency: "EUR",
    before_minor: 110000,
    after_minor: 124000,
    delta_pct: 12.7,
  };

  it("prints revenue through the currency's exponent, with the basis word", () => {
    expect(readbackLine(base)).toBe(
      "Raise the cut price: helped — daily revenue averaged €1,240.00 after, against €1,100.00 before (+12.7%), measured.",
    );
  });

  it("rounds a mean to whole minor units, and a zero-decimal currency prints none", () => {
    const line = readbackLine({
      ...base,
      verdict: "backfired",
      currency: "JPY",
      before_minor: 52000.4,
      after_minor: 41000.6,
      delta_pct: -21.2,
    });
    expect(line).toBe(
      "Raise the cut price: backfired — daily revenue averaged ¥41,001 after, against ¥52,000 before (-21.2%), measured.",
    );
  });

  it("HUF keeps its two minor digits (fillér, data-model §3.3)", () => {
    const line = readbackLine({
      ...base,
      currency: "HUF",
      before_minor: 1_500_000,
      after_minor: 1_650_000,
    });
    expect(line).toContain("HUF");
    expect(line).toContain("16,500.00");
  });

  it("an unmeasured change gets no line; too early says so without a number", () => {
    expect(readbackLine({ ...base, verdict: "unmeasured" })).toBeNull();
    expect(readbackLine({ ...base, verdict: "too_early", delta_pct: null })).toBe(
      "Raise the cut price: too early to say — not enough measured days since it ran.",
    );
  });

  it("a non-revenue readback names what it was judged on, and no invented money", () => {
    const line = readbackLine({
      ...base,
      judged_on: "post",
      currency: null,
      before_minor: null,
      after_minor: null,
      delta_pct: 30,
    });
    expect(line).toBe(
      "Raise the cut price: helped — judged on reach and interactions against your previous posts (+30%), measured.",
    );
  });
});

describe("I-42 — the calendar", () => {
  it("reads a Postgres timestamp as the watch screen does, in UTC", () => {
    expect(dayLabel("2026-10-26 06:00:00.123+00")).toBe("Mon 26 Oct");
    expect(dayLabel("2026-10-26 01:00:00+02")).toBe("Sun 25 Oct");
    expect(dayLabel("2026-10-26T06:00:00.000Z")).toBe("Mon 26 Oct");
  });

  it("names the ISO week, across a year boundary both ways", () => {
    expect(isoWeek(NOW)).toBe("2026-W44");
    expect(isoWeek(new Date("2026-01-01T12:00:00Z"))).toBe("2026-W01"); // a Thursday
    expect(isoWeek(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53"); // a Friday: last year's week
    expect(isoWeek(new Date("2024-12-30T12:00:00Z"))).toBe("2025-W01"); // a Monday: next year's
  });

  it("a Monday re-run and a Sunday re-run land on different weeks; two Mondays on one", () => {
    expect(isoWeek(new Date("2026-10-26T06:00:00Z"))).toBe(
      isoWeek(new Date("2026-11-01T23:59:00Z")),
    );
    expect(isoWeek(new Date("2026-10-25T23:59:00Z"))).not.toBe(isoWeek(NOW));
  });
});

describe("I-42 — the switch and the stop token", () => {
  it("defaults on once there is a mode decision; an explicit off always wins", () => {
    expect(summaryOn(summaryPref({}), true)).toBe(true);
    expect(summaryOn(summaryPref({}), false)).toBe(false);
    expect(summaryOn(summaryPref({ weekly_summary: false }), true)).toBe(false);
    expect(summaryOn(summaryPref({ weekly_summary: true }), true)).toBe(true);
    // On, but nothing to report before the report: still nothing sent.
    expect(summaryOn(summaryPref({ weekly_summary: true }), false)).toBe(false);
    // Anything that isn't a boolean is "never said".
    expect(summaryPref({ weekly_summary: "no" })).toBeNull();
    expect(summaryPref(null)).toBeNull();
  });

  it("verifies its own token and nothing else", () => {
    const id = "6f1c2a8e-4b3d-4e5f-9a0b-1c2d3e4f5a6b";
    const token = stopToken(id);
    expect(verifyStopToken(token)).toBe(id);
    const other = "6f1c2a8e-4b3d-4e5f-9a0b-1c2d3e4f5a6c";
    // Someone else's id with this signature is refused.
    expect(verifyStopToken(`${other}${token.slice(36)}`)).toBeNull();
    // A flipped signature character is refused.
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyStopToken(flipped)).toBeNull();
    expect(verifyStopToken("not-a-token")).toBeNull();
    expect(verifyStopToken(id)).toBeNull();
  });
});
