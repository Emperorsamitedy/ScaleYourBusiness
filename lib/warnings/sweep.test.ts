// Warnings sent at once, the sweep, against the database: which of the
// watch's warning lines become an alert. A line that is news is told by
// phone and by one email; a line said again because the week turned, a
// squeeze that carries on and a warning that cleared are not; a warning
// Monday's summary has just carried gets no second email. Clocks are pinned
// to a Tuesday in November: Budapest is UTC+1, so 09:00 UTC is mid-morning.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { warningAlerts, watchActivity, weeklySummaries } from "../../db/schema";
import type { EmailFetch } from "../auth/email";
import { fakePushService } from "../push/send";
import { business, cleanup, device } from "../push/test-fixtures";
import { raiseDueWarningAlerts } from "./sweep";

const NOW = new Date("2026-11-10T09:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const MUG = "Speckled Everyday Mug runs out in about 3 to 4 days; Midland Clay takes 10 days.";
const CASH =
  "Money could get tight in the week of 29 Dec: at the cautious end the balance is about €1,200, under your €2,000 buffer.";

afterAll(cleanup);
beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("APP_URL", "https://app.example");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function provider() {
  const sent: { to: string[]; subject: string; text: string }[] = [];
  const fetchImpl: EmailFetch = async (_url, init) => {
    sent.push(JSON.parse(String(init.body)) as (typeof sent)[number]);
    return new Response(JSON.stringify({ id: `email-${sent.length}` }), { status: 200 });
  };
  return { sent, fetchImpl };
}

type Business = Awaited<ReturnType<typeof business>>;

/** A stock warning's line as lib/stock/warnings writes it. */
const stockLine = (b: Business, at: Date, level = "tight", key = "sku:mug", detail = MUG) =>
  db.insert(watchActivity).values({
    profile_id: b.profile_id,
    at: at.toISOString(),
    kind: "stock_warning",
    detail,
    meta: { signature: `${key}|${level}|week`, key, level },
  });

/** A cash warning's line as lib/watch/job writes it; `week` null is "it cleared". */
const cashLine = (b: Business, at: Date, week: [string, string] | null) =>
  db.insert(watchActivity).values({
    profile_id: b.profile_id,
    at: at.toISOString(),
    kind: "cash_warning",
    detail: week ? CASH : "Cash: no week of the next 13 dips under your €2,000 buffer any more.",
    meta: week
      ? { signature: `${week[0]}|buffer|200000|EUR`, week_start: week[0], week_end: week[1] }
      : { signature: "", cleared: true },
  });

/** A device on the fake push host, the two fakes, and the sweep scoped to this business. */
async function setup() {
  const b = await business();
  await device(b);
  const push = fakePushService();
  const mail = provider();
  const sweep = () =>
    raiseDueWarningAlerts(NOW, {
      profileIds: [b.profile_id],
      push,
      fetchImpl: mail.fetchImpl,
    });
  const alerts = () =>
    db.select().from(warningAlerts).where(eq(warningAlerts.profile_id, b.profile_id));
  return { b, push, mail, sweep, alerts };
}

describe("a stock warning becomes an alert when it is news", () => {
  it("tells an item said for the first time, by phone and by one email, and only once", async () => {
    const { b, push, mail, sweep, alerts } = await setup();
    await stockLine(b, ago(HOUR));
    expect(await sweep()).toMatchObject({ looked: 1, news: 1, alerts: 1, emails: 1, failed: 0 });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload).toMatchObject({
      body: "Something you sell could run out before its next delivery",
      url: "/stock",
    });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.text).toContain(MUG);
    expect((await alerts())[0]).toMatchObject({ kind: "stock_warning", email_outcome: "sent" });

    // The next morning's sweep finds the alert already made.
    expect(await sweep()).toMatchObject({ looked: 0, news: 0, alerts: 0, emails: 0 });
    expect(push.sent).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
  });

  it("stays quiet when the week turned and the same warning was said again", async () => {
    const { b, push, mail, sweep, alerts } = await setup();
    await stockLine(b, ago(7 * DAY));
    await stockLine(b, ago(HOUR));
    // Last week's line is past the window; this week's is looked at and is not news.
    expect(await sweep()).toMatchObject({ looked: 1, news: 0, alerts: 0, emails: 0 });
    expect(await sweep()).toMatchObject({ looked: 1, news: 0, alerts: 0, emails: 0 });
    expect(push.sent).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
    expect(await alerts()).toHaveLength(0);
  });

  it("tells it again when it got worse, and another item on its own account", async () => {
    const { b, push, mail, sweep } = await setup();
    await stockLine(b, ago(3 * DAY), "tight");
    await stockLine(b, ago(HOUR), "before_restock");
    await stockLine(
      b,
      ago(HOUR),
      "tight",
      "sku:plate",
      "Stoneware Dinner Plate runs out in 5 days.",
    );
    expect(await sweep()).toMatchObject({ looked: 2, news: 2, alerts: 2, emails: 1 });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload).toMatchObject({
      body: "2 warnings worth knowing",
      url: "/stock",
    });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.subject).toBe("2 warnings worth knowing");
  });

  it("does not send late what is two days old", async () => {
    const { b, push, mail, sweep } = await setup();
    await stockLine(b, ago(49 * HOUR));
    expect(await sweep()).toMatchObject({ looked: 0, news: 0, alerts: 0 });
    expect(push.sent).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });
});

describe("a cash warning becomes an alert when it is news", () => {
  it("tells a tight week that has just appeared", async () => {
    const { b, push, mail, sweep } = await setup();
    await cashLine(b, ago(HOUR), ["2026-12-29", "2027-01-04"]);
    expect(await sweep()).toMatchObject({ looked: 1, news: 1, alerts: 1, emails: 1 });
    expect(push.sent[0]?.payload).toMatchObject({
      body: "Your cash could get tight in the weeks ahead",
      url: "/cash",
    });
    expect(mail.sent[0]?.subject).toBe("Your cash could get tight in the weeks ahead");
    expect(mail.sent[0]?.text).toContain("https://app.example/cash");
  });

  it("tells one that appears after the last one cleared", async () => {
    const { b, push, sweep } = await setup();
    await cashLine(b, ago(21 * DAY), ["2026-11-03", "2026-11-09"]);
    await cashLine(b, ago(14 * DAY), null);
    await cashLine(b, ago(HOUR), ["2026-12-29", "2027-01-04"]);
    expect(await sweep()).toMatchObject({ looked: 1, news: 1, alerts: 1 });
    expect(push.sent).toHaveLength(1);
  });

  it("stays quiet while the same squeeze carries on into the next week", async () => {
    const { b, push, mail, sweep, alerts } = await setup();
    await cashLine(b, ago(7 * DAY), ["2026-11-03", "2026-11-09"]);
    await cashLine(b, ago(HOUR), ["2026-11-10", "2026-11-16"]);
    expect(await sweep()).toMatchObject({ looked: 1, news: 0, alerts: 0, emails: 0 });
    expect(push.sent).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
    expect(await alerts()).toHaveLength(0);
  });

  it("never alerts for a warning that cleared", async () => {
    const { b, push, mail, sweep } = await setup();
    await cashLine(b, ago(7 * DAY), ["2026-11-03", "2026-11-09"]);
    await cashLine(b, ago(HOUR), null);
    expect(await sweep()).toMatchObject({ looked: 1, news: 0, alerts: 0 });
    expect(push.sent).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("puts stock and cash that are news the same morning into one email", async () => {
    const { b, push, mail, sweep } = await setup();
    await cashLine(b, ago(2 * HOUR), ["2026-12-29", "2027-01-04"]);
    await stockLine(b, ago(HOUR));
    expect(await sweep()).toMatchObject({ looked: 2, news: 2, alerts: 2, emails: 1 });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.subject).toBe("2 warnings worth knowing");
    expect(mail.sent[0]?.text).toContain(CASH);
    expect(mail.sent[0]?.text).toContain(MUG);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload).toMatchObject({ body: "2 warnings worth knowing", url: "/home" });
  });
});

describe("Monday's summary and the warning's own email are never both sent for one line", () => {
  const summary = (b: Business, at: Date, status: "sent" | "refused" = "sent") =>
    db.insert(weeklySummaries).values({
      account_id: b.account_id,
      iso_week: "2026-W46",
      status,
      quiet: false,
      line_count: 3,
      created_at: at.toISOString(),
    });

  it("sends no email when the summary went out after the line was written; the phone still hears", async () => {
    const { b, push, mail, sweep, alerts } = await setup();
    await stockLine(b, ago(HOUR));
    await summary(b, ago(HOUR / 2));
    expect(await sweep()).toMatchObject({ looked: 1, news: 1, alerts: 1, emails: 0 });
    expect(mail.sent).toHaveLength(0);
    expect(push.sent).toHaveLength(1);
    const [row] = await alerts();
    expect(row).toMatchObject({ email_outcome: "in_summary", email_claimed_at: null });
  });

  it("sends the email when the summary went out before the line was written", async () => {
    const { b, mail, sweep } = await setup();
    await summary(b, ago(2 * HOUR));
    await stockLine(b, ago(HOUR));
    expect(await sweep()).toMatchObject({ alerts: 1, emails: 1 });
    expect(mail.sent).toHaveLength(1);
  });

  it("sends the email when the summary was claimed but never reached the inbox", async () => {
    const { b, mail, sweep } = await setup();
    await stockLine(b, ago(HOUR));
    await summary(b, ago(HOUR / 2), "refused");
    expect(await sweep()).toMatchObject({ alerts: 1, emails: 1 });
    expect(mail.sent).toHaveLength(1);
  });
});
