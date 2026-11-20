import { describe, expect, it } from "vitest";
import type { FeedProposal, LogLike } from "./activity-model";
import { ago, answerOf, mergeFeed, newKeys, remember, stackFeed } from "./activity-model";

const log = (at: string, kind: string, detail: string, subject?: string): LogLike => ({
  at,
  kind,
  detail,
  subject: subject ?? null,
});
const proposal = (id: string, status: string, over: Partial<FeedProposal> = {}): FeedProposal => ({
  id,
  status,
  action: { summary: `do ${id}` },
  created_at: "2026-11-17 09:00:00+00",
  ...over,
});

// docs/DASHBOARD-OVERHAUL.md C6: one live feed, newest first.
describe("Home's activity feed: one list from the watch's log and the queue", () => {
  it("orders everything newest first and says what each row is", () => {
    const rows = mergeFeed(
      [
        log("2026-11-17 13:33:35.5+00", "connector_sync", "Read 22 days of Shopify orders."),
        log("2026-11-17 13:34:00.9+00", "cash_warning", "Money could get tight this week."),
        log("2026-11-16 10:00:00+00", "something_new", "A line of a kind nobody mapped."),
      ],
      [
        proposal("price", "approved", { decided_at: "2026-11-17 13:37:17+00" }),
        proposal("wait", "pending", { created_at: "2026-11-17 13:34:05+00" }),
      ],
    );
    expect(rows.map((r) => `${r.tag}:${r.proposal ?? r.href}`)).toEqual([
      "approved:price",
      "proposed:wait",
      "noticed:/cash",
      "read:/connections",
      "proposed:price",
      "watch:/watch", // an unknown kind is the watch's, never dropped
    ]);
    expect(rows[0]?.text).toBe("do price");
  });

  it("gives an answered proposal two rows, and one held back a single row", () => {
    const rows = mergeFeed(
      [],
      [
        proposal("no", "rejected", {
          decided_at: "2026-11-17 10:00:00+00",
          rejection_reason: "  Too risky this month.  ",
        }),
        proposal("held", "blocked"),
        proposal("late", "expired", { expires_at: "2026-11-17 11:00:00+00" }),
        proposal("redo", "changes_requested", {
          decided_at: "2026-11-17 12:00:00+00",
          change_request: "Smaller rise.",
        }),
      ],
    );
    expect(rows.map((r) => `${r.proposal}:${r.tag}`)).toEqual([
      "redo:changes",
      "late:expired",
      "no:declined",
      "held:blocked",
      "late:proposed",
      "no:proposed",
      "redo:proposed",
    ]);
    expect(rows.find((r) => r.tag === "declined")?.said).toBe("Too risky this month.");
    expect(rows.find((r) => r.tag === "changes")?.said).toBe("Smaller rise.");
    expect(rows.find((r) => r.tag === "blocked")?.said).toBeNull();
  });

  it("leaves out a row whose time can't be read, rather than placing it by guess", () => {
    const rows = mergeFeed(
      [log("not a time", "connector_sync", "Read something.")],
      [proposal("x", "approved", { created_at: null, decided_at: null })],
    );
    expect(rows).toEqual([]);
  });

  it("keeps one row when the same line is said twice within a minute, and both when a day apart", () => {
    const line = "Read 22 days of Shopify orders.";
    const rows = mergeFeed(
      [
        log("2026-11-17 13:33:40+00", "connector_sync", line),
        log("2026-11-17 13:33:10+00", "connector_sync", line),
        log("2026-11-16 13:33:10+00", "connector_sync", line),
      ],
      [],
    );
    expect(rows.map((r) => r.ms)).toEqual([
      Date.parse("2026-11-17T13:33:40Z"),
      Date.parse("2026-11-16T13:33:10Z"),
    ]);
  });

  it("keeps three goals checked in one instant apart by what each is about", () => {
    const at = "2026-11-17 13:34:05+00";
    const rows = mergeFeed(
      [
        log(at, "goal_progress", "Too early to judge.", "Reach 750 orders a month"),
        log(at, "goal_progress", "Too early to judge.", "Grow online revenue"),
        log(at, "goal_progress", "Too early to judge.", "Grow online revenue"),
      ],
      [],
    );
    expect(rows.map((r) => r.subject).sort()).toEqual([
      "Grow online revenue",
      "Reach 750 orders a month",
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(rows.every((r) => r.tag === "checked" && r.href === "/progress")).toBe(true);
  });
});

// docs/DASHBOARD-OVERHAUL.md, the review's second round: "Activity's Checked
// rows are many and alike; they want grouping by day".
describe("Home's activity feed: a day's routine lines are one entry", () => {
  const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const rows = mergeFeed(
    [
      log("2026-11-17 13:34:05+00", "goal_progress", "Too early to judge.", "Reach 750 orders"),
      log("2026-11-17 13:34:05+00", "goal_progress", "On track.", "Grow online revenue"),
      log("2026-11-17 13:34:00+00", "cash_warning", "Money could get tight this week."),
      log("2026-11-17 13:33:35+00", "connector_sync", "Read 1 day of Shopify orders."),
      log("2026-11-17 13:33:20+00", "connector_sync", "Read 1 day of Stripe payments."),
      log("2026-11-17 06:00:00+00", "goal_progress", "On track.", "Grow online revenue"),
      log("2026-11-16 13:33:35+00", "connector_sync", "Read 1 day of Shopify orders."),
      log("2026-11-16 13:34:05+00", "goal_progress", "Too early to judge.", "Reach 750 orders"),
    ],
    [proposal("price", "pending", { created_at: "2026-11-17 13:34:10+00" })],
  );
  const entries = stackFeed(rows, utcDay);

  it("shows the newest of a day's reads and of its checks, with the others behind it", () => {
    expect(entries.map((e) => `${e.row.tag}+${e.rest.length}`)).toEqual([
      "proposed+0",
      "checked+2", // the two goals of 13:34 and the morning's check
      "noticed+0",
      "read+1",
      "checked+0", // the day before: a line alone is a plain row
      "read+0",
    ]);
    // The entry sits where its newest line was, and the rest stay newest first.
    const checked = entries[1]!;
    expect(checked.row.ms).toBe(Date.parse("2026-11-17T13:34:05Z"));
    expect(checked.rest.map((r) => r.ms)).toEqual([
      Date.parse("2026-11-17T13:34:05Z"),
      Date.parse("2026-11-17T06:00:00Z"),
    ]);
  });

  it("drops nothing: every row is in exactly one entry", () => {
    const listed = entries.flatMap((e) => [e.row, ...e.rest]).map((r) => r.key);
    expect(listed.sort()).toEqual(rows.map((r) => r.key).sort());
  });

  it("never stacks what was noticed, proposed or answered, however alike", () => {
    const alike = mergeFeed(
      [
        log("2026-11-17 13:00:00+00", "cash_warning", "Money could get tight this week."),
        log("2026-11-17 09:00:00+00", "cash_warning", "Money could get tight next week."),
      ],
      [
        proposal("a", "approved", { decided_at: "2026-11-17 12:00:00+00" }),
        proposal("b", "approved", { decided_at: "2026-11-17 11:00:00+00" }),
      ],
    );
    expect(stackFeed(alike, utcDay).every((e) => e.rest.length === 0)).toBe(true);
    expect(stackFeed(alike, utcDay)).toHaveLength(alike.length);
  });

  it("keeps an entry's key while its day's stack grows, so an open one stays open", () => {
    const before = stackFeed(rows, utcDay)[3]!; // the 17th's reads
    const grown = stackFeed(
      mergeFeed(
        [
          log("2026-11-17 18:00:00+00", "connector_sync", "Read 1 day of Meta ads."),
          log("2026-11-17 13:33:35+00", "connector_sync", "Read 1 day of Shopify orders."),
          log("2026-11-17 13:33:20+00", "connector_sync", "Read 1 day of Stripe payments."),
        ],
        [],
      ),
      utcDay,
    )[0]!;
    expect(grown.key).toBe(before.key);
    expect(grown.row.text).toBe("Read 1 day of Meta ads.");
    expect(grown.rest).toHaveLength(2);
    // A plain row keeps the row's own key.
    expect(entries[0]!.key).toBe(entries[0]!.row.key);
  });
});

describe("Home's activity feed: what is new, and how long ago", () => {
  const rows = mergeFeed(
    [log("2026-11-17 13:33:35+00", "connector_sync", "Read 22 days of Shopify orders.")],
    [proposal("price", "approved", { decided_at: "2026-11-17 13:37:17+00" })],
  );

  const both = { log: true, proposals: true };
  const later = mergeFeed(
    [
      log("2026-11-17 14:00:00+00", "connector_sync", "Read 23 days of Shopify orders."),
      log("2026-11-17 13:33:35+00", "connector_sync", "Read 22 days of Shopify orders."),
    ],
    [proposal("price", "approved", { decided_at: "2026-11-17 13:37:17+00" })],
  );

  it("marks nothing on the first read, and only the rows that were not there before after it", () => {
    expect(newKeys(null, rows)).toEqual([]);
    const before = remember(null, rows, both, true);
    expect(newKeys(before, rows)).toEqual([]);
    expect(newKeys(before, later)).toEqual([later[0]!.key]);
  });

  it("takes a read that has only now come back as what was there, not as news", () => {
    // The queue answered first; the watch's log a moment later, with the feed open.
    const queueOnly = mergeFeed([], [proposal("price", "pending")]);
    const seen = remember(null, queueOnly, { log: false, proposals: true }, true);
    const withLog = mergeFeed(
      [log("2026-11-17 13:33:35+00", "connector_sync", "Read 22 days of Shopify orders.")],
      [proposal("price", "pending")],
    );
    expect(newKeys(seen, withLog)).toEqual([]);
    // Once the log is in, its next line is news.
    const then = remember(seen, withLog, both, true);
    const next = mergeFeed(
      [
        log("2026-11-17 14:00:00+00", "connector_sync", "Read 23 days of Shopify orders."),
        log("2026-11-17 13:33:35+00", "connector_sync", "Read 22 days of Shopify orders."),
      ],
      [proposal("price", "pending")],
    );
    expect(newKeys(then, next)).toEqual([next[0]!.key]);
  });

  it("keeps what arrives while the feed is closed as news for when it opens", () => {
    // Closed: the first rows of each read are what was there.
    const closed = remember(null, rows, both, false);
    expect([...closed.keys].sort()).toEqual(rows.map((r) => r.key).sort());
    // A line arrives while it is still closed: not taken in, so still news on opening.
    const stillClosed = remember(closed, later, both, false);
    expect(stillClosed.keys.has(later[0]!.key)).toBe(false);
    expect(newKeys(stillClosed, later)).toEqual([later[0]!.key]);
    // Opened and looked at: nothing is news a second time.
    expect(newKeys(remember(stillClosed, later, both, true), later)).toEqual([]);
  });

  it("says how long ago in one unit, and gives up past four weeks", () => {
    const now = Date.parse("2026-11-17T14:00:00Z");
    const s = 1000;
    expect(ago(now - 10 * s, now)).toEqual({ value: 0, unit: "second" });
    expect(ago(now - 50 * s, now)).toEqual({ value: -1, unit: "minute" });
    expect(ago(now - 59 * 60 * s, now)).toEqual({ value: -59, unit: "minute" });
    expect(ago(now - 2 * 3600 * s, now)).toEqual({ value: -2, unit: "hour" });
    expect(ago(now - 3 * 86_400 * s, now)).toEqual({ value: -3, unit: "day" });
    expect(ago(now - 15 * 86_400 * s, now)).toEqual({ value: -2, unit: "week" });
    expect(ago(now - 29 * 86_400 * s, now)).toBeNull();
    expect(ago(now + 5 * s, now)).toEqual({ value: 0, unit: "second" }); // a clock ahead is "now"
  });

  it("names a recorded answer and nothing else", () => {
    expect(answerOf("executed")).toBe("done");
    expect(answerOf("rejected")).toBe("declined");
    expect(answerOf("pending")).toBeNull();
    expect(answerOf("mystery")).toBeNull();
  });
});
