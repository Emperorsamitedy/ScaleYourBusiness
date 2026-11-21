// Warnings sent at once, against the database: a line the watch has just
// written is told at once, by phone (through the fake push service, no
// network) and by one email (through a fetch that answers as the provider
// would), and never twice. Clocks are pinned to a Tuesday in November:
// Budapest is UTC+1.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { users, warningAlerts, watchActivity } from "../../db/schema";
import type { EmailFetch } from "../auth/email";
import { flushHeldPushes } from "../push/flush";
import { fakePushService } from "../push/send";
import { business, cleanup, device } from "../push/test-fixtures";
import { raiseWarningAlerts } from "./alerts";
import { WARNING_PREF_KEY } from "./switch";

const MORNING = new Date("2026-11-10T09:00:00Z"); // 10:00 in Budapest
const EVENING = new Date("2026-11-10T21:30:00Z"); // 22:30
const NEXT_MORNING = new Date("2026-11-11T07:05:00Z"); // 08:05

const CASH =
  "Money could get tight this week: at the cautious end the balance is about €7,770, under the €9,600 you want to keep.";

afterAll(cleanup);
beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("APP_URL", "https://app.example");
});
afterEach(() => vi.unstubAllEnvs());

/** The provider as a test sees it: every request kept, each answered with an id. */
function provider() {
  const sent: { to: string[]; subject: string; text: string }[] = [];
  const fetchImpl: EmailFetch = async (_url, init) => {
    sent.push(JSON.parse(String(init.body)) as (typeof sent)[number]);
    return new Response(JSON.stringify({ id: `email-${sent.length}` }), { status: 200 });
  };
  return { sent, fetchImpl };
}

/** A line as the watch writes it. */
async function logged(b: { profile_id: string }, kind: string, detail: string) {
  const [row] = await db
    .insert(watchActivity)
    .values({ profile_id: b.profile_id, kind, detail, meta: {} })
    .returning({ id: watchActivity.id });
  return { id: row!.id, kind, detail };
}

const alertsOf = (profileId: string) =>
  db.select().from(warningAlerts).where(eq(warningAlerts.profile_id, profileId));

describe("a warning that looks ahead is told at once", () => {
  it("reaches the phone in fixed words and the owner's inbox in the watch's own sentence", async () => {
    const b = await business();
    await device(b);
    const line = await logged(b, "cash_warning", CASH);
    const push = fakePushService();
    const mail = provider();
    const out = await raiseWarningAlerts(b.profile_id, [line], {
      push,
      now: MORNING,
      fetchImpl: mail.fetchImpl,
    });
    expect(out.alert_ids).toHaveLength(1);
    expect(out.email).toBe("sent");

    // The lock screen: fixed words, no figure, and the tap goes to Cash flow.
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload).toMatchObject({
      body: "Your cash could get tight in the weeks ahead",
      url: "/cash",
    });
    expect(JSON.stringify(push.sent[0]?.payload)).not.toMatch(/7,770|9,600|€/);

    // The email: to the owner, the sentence as logged, the way to the screen.
    expect(mail.sent).toHaveLength(1);
    const [owner] = await db.select().from(users).where(eq(users.id, b.user_id));
    expect(mail.sent[0]?.to).toEqual([owner!.email]);
    expect(mail.sent[0]?.subject).toBe("Your cash could get tight in the weeks ahead");
    expect(mail.sent[0]?.text).toContain(CASH);
    expect(mail.sent[0]?.text).toContain("https://app.example/cash");

    const [row] = await alertsOf(b.profile_id);
    expect(row).toMatchObject({ kind: "cash_warning", email_outcome: "sent" });
    expect(row?.push_settled_at).not.toBeNull();
    expect(row?.email_claimed_at).not.toBeNull();
  });

  it("raises nothing twice for the same line", async () => {
    const b = await business();
    await device(b);
    const line = await logged(b, "cash_warning", CASH);
    const push = fakePushService();
    const mail = provider();
    const opts = { push, now: MORNING, fetchImpl: mail.fetchImpl };
    await raiseWarningAlerts(b.profile_id, [line], opts);
    const again = await raiseWarningAlerts(b.profile_id, [line], opts);
    expect(again).toEqual({ alert_ids: [], email: null });
    expect(push.sent).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
    expect(await alertsOf(b.profile_id)).toHaveLength(1);
  });

  it("tells three items of one run in one alert and one email", async () => {
    const b = await business();
    await device(b);
    const lines = [
      await logged(b, "stock_warning", "Speckled Everyday Mug runs out in about 3 to 4 days."),
      await logged(b, "stock_warning", "Stoneware Dinner Plate runs out in about 5 days."),
      await logged(b, "stock_warning", "Bud Vase Trio runs out in about 6 days."),
    ];
    const push = fakePushService();
    const mail = provider();
    const out = await raiseWarningAlerts(b.profile_id, lines, {
      push,
      now: MORNING,
      fetchImpl: mail.fetchImpl,
    });
    expect(out.alert_ids).toHaveLength(3);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload).toMatchObject({
      body: "3 warnings worth knowing",
      url: "/stock",
    });
    // No item's name on the lock screen.
    expect(JSON.stringify(push.sent[0]?.payload)).not.toMatch(/Mug|Plate|Vase/);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.subject).toBe("3 warnings worth knowing");
    for (const l of lines) expect(mail.sent[0]?.text).toContain(l.detail);
    expect((await alertsOf(b.profile_id)).every((r) => r.email_outcome === "sent")).toBe(true);
  });

  it("sends no email once the owner switched it off; the phone alert still goes", async () => {
    const b = await business();
    await device(b);
    await db
      .update(users)
      .set({ notification_prefs: { [WARNING_PREF_KEY]: false } })
      .where(eq(users.id, b.user_id));
    const line = await logged(b, "cash_warning", CASH);
    const push = fakePushService();
    const mail = provider();
    const out = await raiseWarningAlerts(b.profile_id, [line], {
      push,
      now: MORNING,
      fetchImpl: mail.fetchImpl,
    });
    expect(out.email).toBe("off");
    expect(mail.sent).toHaveLength(0);
    expect(push.sent).toHaveLength(1);
    const [row] = await alertsOf(b.profile_id);
    expect(row?.email_claimed_at).toBeNull();
  });

  it("says so, and claims nothing, when this server cannot send email", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const b = await business();
    const line = await logged(b, "cash_warning", CASH);
    const mail = provider();
    const out = await raiseWarningAlerts(b.profile_id, [line], {
      push: fakePushService(),
      now: MORNING,
      fetchImpl: mail.fetchImpl,
    });
    expect(out.email).toBe("not_configured");
    expect(mail.sent).toHaveLength(0);
    // No device either: the phone alert is dropped and settled, never sent late.
    const [row] = await alertsOf(b.profile_id);
    expect(row).toMatchObject({ email_outcome: "not_configured", email_claimed_at: null });
    expect(row?.push_settled_at).not.toBeNull();
  });

  it("waits through quiet hours on the phone, and the morning beat sends it", async () => {
    const b = await business();
    await device(b);
    const line = await logged(b, "stock_warning", "Bud Vase Trio runs out in about 6 days.");
    const push = fakePushService();
    await raiseWarningAlerts(b.profile_id, [line], {
      push,
      now: EVENING,
      fetchImpl: provider().fetchImpl,
    });
    expect(push.sent).toHaveLength(0);
    expect((await alertsOf(b.profile_id))[0]?.push_settled_at).toBeNull();
    await flushHeldPushes({ service: push, now: NEXT_MORNING });
    expect(push.sent.map((s) => s.payload.url)).toContain("/stock");
    expect((await alertsOf(b.profile_id))[0]?.push_settled_at).not.toBeNull();
  });

  it("raises nothing for a line that is not a warning of these kinds", async () => {
    const b = await business();
    await device(b);
    const line = await logged(b, "goal_alert", "A goal is behind its path.");
    const push = fakePushService();
    const mail = provider();
    expect(
      await raiseWarningAlerts(b.profile_id, [line], {
        push,
        now: MORNING,
        fetchImpl: mail.fetchImpl,
      }),
    ).toEqual({ alert_ids: [], email: null });
    expect(push.sent).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
    expect(await alertsOf(b.profile_id)).toHaveLength(0);
  });
});
