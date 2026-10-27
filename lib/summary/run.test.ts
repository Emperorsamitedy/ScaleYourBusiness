// Idea 42 — the weekly summary's runner, against the database. A fake
// sender stands in for Resend (no network). Held here: one email per
// account per ISO week however often the cron fires; the owner's off is
// honoured, from the screen's switch or the email's one-click stop; no key
// means nothing sent and nothing claimed; and the email reads the week that
// is actually on record, and nothing else.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  modeDecisions,
  proposals,
  users,
  watchActivity,
  weeklySummaries,
} from "../../db/schema";
import type { OwnerEmail, OwnerEmailOutcome } from "../auth/email";
import { bootstrapIntake } from "../intake/service";
import { setSummaryPref, stopSummaries, stopToken, viewStop } from "./prefs";
import { runWeeklySummaries } from "./run";
import { isoWeek } from "./week";

process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const created: { account_id: string; profile_id: string; user_id: string | null }[] = [];

async function business(opts: { owner?: boolean; decided?: boolean } = {}) {
  const s = await bootstrapIntake();
  let userId: string | null = null;
  if (opts.owner !== false) {
    const [u] = await db
      .insert(users)
      .values({
        account_id: s.account_id,
        email: `i42-${crypto.randomUUID()}@test.local`,
        display_name: "Summary owner",
        role: "owner",
      })
      .returning({ id: users.id });
    userId = u!.id;
  }
  if (opts.decided !== false) {
    await db.insert(modeDecisions).values({
      profile_id: s.profile_id,
      mode: "watching",
      watch_weeks: 6,
      inputs: { reasons: [] },
      reasoning: "test",
      confidence: "0.750",
      review_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
  }
  const entry = { ...s, user_id: userId };
  created.push(entry);
  return entry;
}

function fakeSender() {
  const sent: OwnerEmail[] = [];
  return {
    sent,
    send: async (mail: OwnerEmail): Promise<OwnerEmailOutcome> => {
      sent.push(mail);
      return { kind: "sent", provider_id: `re_${sent.length}` };
    },
  };
}

const ORIGIN = "https://app.example";
const NOW = new Date();

afterAll(async () => {
  const accountIds = created.map((c) => c.account_id);
  const profileIds = created.map((c) => c.profile_id);
  if (accountIds.length === 0) return;
  await db.delete(weeklySummaries).where(inArray(weeklySummaries.account_id, accountIds));
  await db.delete(watchActivity).where(inArray(watchActivity.profile_id, profileIds));
  await db.delete(proposals).where(inArray(proposals.profile_id, profileIds));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, profileIds));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

describe("I-42 — once per account per week", () => {
  it("a second and a third run in the same week send nothing", async () => {
    const b = await business();
    const fake = fakeSender();
    const scope = { accountIds: [b.account_id], send: fake.send, origin: ORIGIN };

    const first = await runWeeklySummaries(NOW, scope);
    expect(first).toMatchObject({ considered: 1, sent: 1 });
    const again = await runWeeklySummaries(NOW, scope);
    const later = await runWeeklySummaries(new Date(NOW.getTime() + 60_000), scope);
    expect(again).toMatchObject({ sent: 0, already_sent: 1 });
    expect(later).toMatchObject({ sent: 0, already_sent: 1 });
    expect(fake.sent).toHaveLength(1);

    const rows = await db
      .select()
      .from(weeklySummaries)
      .where(eq(weeklySummaries.account_id, b.account_id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ iso_week: isoWeek(NOW), status: "sent", provider_id: "re_1" });

    // The mail itself: to the owner, the stop link in a header and the body, keyed by week.
    const mail = fake.sent[0]!;
    expect(mail.to).toMatch(/^i42-.*@test\.local$/);
    expect(mail.idempotency_key).toBe(`syb-weekly-summary-${b.account_id}-${isoWeek(NOW)}`);
    expect(mail.headers?.["List-Unsubscribe"]).toBe(
      `<${ORIGIN}/api/summary/stop/${stopToken(b.user_id!)}>`,
    );
    expect(mail.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(mail.text).toContain(`${ORIGIN}/summary/stop/${stopToken(b.user_id!)}`);
  });

  it("the next week sends again", async () => {
    const b = await business();
    const fake = fakeSender();
    const scope = { accountIds: [b.account_id], send: fake.send, origin: ORIGIN };
    await runWeeklySummaries(NOW, scope);
    await runWeeklySummaries(new Date(NOW.getTime() + 7 * 86_400_000), scope);
    expect(fake.sent).toHaveLength(2);
  });

  it("a send that may have gone out is recorded as unknown and never retried", async () => {
    const b = await business();
    let calls = 0;
    const scope = {
      accountIds: [b.account_id],
      origin: ORIGIN,
      send: async (): Promise<OwnerEmailOutcome> => {
        calls++;
        return { kind: "unknown", why: "Resend answered 503" };
      },
    };
    expect(await runWeeklySummaries(NOW, scope)).toMatchObject({ failed: 1 });
    expect(await runWeeklySummaries(NOW, scope)).toMatchObject({ already_sent: 1 });
    expect(calls).toBe(1);
    const [row] = await db
      .select()
      .from(weeklySummaries)
      .where(eq(weeklySummaries.account_id, b.account_id));
    expect(row?.status).toBe("unknown");
  });
});

describe("I-42 — who gets it", () => {
  it("nothing without email set up: not sent, and nothing claimed for the week", async () => {
    const b = await business();
    const saved = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const run = await runWeeklySummaries(NOW, { accountIds: [b.account_id], origin: ORIGIN });
      expect(run).toMatchObject({ sent: 0, not_configured: 1 });
      // No APP_URL either: the same answer, even with a sender.
      const fake = fakeSender();
      const noOrigin = await runWeeklySummaries(NOW, {
        accountIds: [b.account_id],
        origin: null,
        send: fake.send,
      });
      expect(noOrigin).toMatchObject({ not_configured: 1 });
      expect(fake.sent).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.RESEND_API_KEY = saved;
    }
    const rows = await db
      .select()
      .from(weeklySummaries)
      .where(eq(weeklySummaries.account_id, b.account_id));
    expect(rows).toHaveLength(0);
  });

  it("a business with no mode decision yet isn't in the run; one with no owner gets nothing", async () => {
    const early = await business({ decided: false });
    const unowned = await business({ owner: false });
    const fake = fakeSender();
    const run = await runWeeklySummaries(NOW, {
      accountIds: [early.account_id, unowned.account_id],
      send: fake.send,
      origin: ORIGIN,
    });
    expect(run).toMatchObject({ considered: 1, sent: 0, off: 1 });
    expect(fake.sent).toHaveLength(0);
  });
});

describe("I-42 — the owner can turn it off and on", () => {
  it("off on the screen: no email; back on: the next run sends", async () => {
    const b = await business();
    const fake = fakeSender();
    const scope = { accountIds: [b.account_id], send: fake.send, origin: ORIGIN };
    await setSummaryPref(b.user_id!, false);
    expect(await runWeeklySummaries(NOW, scope)).toMatchObject({ off: 1, sent: 0 });
    expect(fake.sent).toHaveLength(0);
    await setSummaryPref(b.user_id!, true);
    expect(await runWeeklySummaries(NOW, scope)).toMatchObject({ sent: 1 });
  });

  it("the one-click stop switches it off and keeps the owner's other preferences", async () => {
    const b = await business();
    await db
      .update(users)
      .set({ notification_prefs: { something_else: true } })
      .where(eq(users.id, b.user_id!));
    const token = stopToken(b.user_id!);
    // Looking at the page writes nothing.
    expect(await viewStop(token)).toEqual({ stopped: false });
    expect(await viewStop(token)).toEqual({ stopped: false });

    expect(await stopSummaries(token)).toEqual({ stopped: true });
    expect(await stopSummaries(token)).toEqual({ stopped: true }); // idempotent
    expect(await viewStop(token)).toEqual({ stopped: true });
    const [u] = await db
      .select({ prefs: users.notification_prefs })
      .from(users)
      .where(eq(users.id, b.user_id!));
    expect(u?.prefs).toEqual({ something_else: true, weekly_summary: false });

    const fake = fakeSender();
    await runWeeklySummaries(NOW, { accountIds: [b.account_id], send: fake.send, origin: ORIGIN });
    expect(fake.sent).toHaveLength(0);
  });

  it("a forged or unknown token stops nothing", async () => {
    const b = await business();
    const token = stopToken(b.user_id!);
    const forged = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    expect(await stopSummaries(forged)).toBeNull();
    expect(await viewStop("garbage")).toBeNull();
    // A well-signed token for a user who doesn't exist is no link SYB sent.
    expect(await stopSummaries(stopToken(crypto.randomUUID()))).toBeNull();
    expect(await viewStop(token)).toEqual({ stopped: false });
  });
});

describe("I-42 — the email reads the week on record", () => {
  it("this week's log and what waits, not last month's", async () => {
    const b = await business();
    const old = new Date(NOW.getTime() - 20 * 86_400_000).toISOString();
    await db.insert(watchActivity).values([
      {
        profile_id: b.profile_id,
        at: NOW.toISOString(),
        kind: "snapshot_taken",
        detail: "Weekly check: the profile held steady — nothing changed since last week.",
      },
      {
        profile_id: b.profile_id,
        at: old,
        kind: "diff_computed",
        detail: "An old line from three weeks ago.",
      },
    ]);
    await db.insert(proposals).values({
      profile_id: b.profile_id,
      module: "diagnosis",
      action: { kind: "test", summary: "Raise the cut price to €42" },
      scenario: {},
      reversibility: { level: "easy", if_you_change_your_mind: "Change it back." },
      expires_at: new Date(NOW.getTime() + 14 * 86_400_000).toISOString(),
    });
    const fake = fakeSender();
    await runWeeklySummaries(NOW, { accountIds: [b.account_id], send: fake.send, origin: ORIGIN });
    const mail = fake.sent[0]!;
    expect(mail.subject).toBe("Your week with SYB: 1 waiting for you");
    expect(mail.text).toContain("Raise the cut price to €42");
    expect(mail.text).toContain("held steady");
    expect(mail.text).not.toContain("An old line");
    expect(mail.html).toContain(`${ORIGIN}/proposals`);
  });

  it("a week with nothing on record says it was quiet", async () => {
    const b = await business();
    const fake = fakeSender();
    await runWeeklySummaries(NOW, { accountIds: [b.account_id], send: fake.send, origin: ORIGIN });
    expect(fake.sent[0]?.subject).toBe("Your week with SYB: a quiet one");
    const [row] = await db
      .select()
      .from(weeklySummaries)
      .where(eq(weeklySummaries.account_id, b.account_id));
    expect(row).toMatchObject({ quiet: true, line_count: 0 });
  });
});
