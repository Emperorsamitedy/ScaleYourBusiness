// Idea 53 (I-53.2) against the database: a subscription is sealed at rest
// (rule 10), one per browser, shown without its endpoint, removable only by
// its own account, gone on sign-out and with the account. "Send a test"
// goes through the fake push service (no network).

import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  authSessions,
  businessProfiles,
  fieldRecords,
  intakeEvents,
  pushSubscriptions,
  users,
} from "../../db/schema";
import { revokeSession } from "../auth/service";
import { sendTestPush } from "./deliver";
import { fakePushService } from "./send";
import {
  FAKE_PUSH_HOST,
  listDevices,
  openDevices,
  removeDevice,
  saveSubscription,
} from "./subscriptions";
import { browserKeys, business, cleanup, device } from "./test-fixtures";

afterAll(cleanup);

describe("subscriptions at rest (rule 10)", () => {
  it("are sealed: the row holds no endpoint or key, and opens back to the same subscription", async () => {
    const b = await business();
    const d = await device(b);
    const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, d.id));
    expect(row?.encrypted_subscription.startsWith("v1:")).toBe(true);
    expect(row?.encrypted_subscription).not.toContain(FAKE_PUSH_HOST);
    expect(row?.endpoint_hash).not.toContain(FAKE_PUSH_HOST);
    expect(row?.device_label).toBe("iPhone");
    const [open] = await openDevices(b.account_id);
    expect(open?.target.endpoint).toBe(d.endpoint);
  });

  it("one browser switching on twice is one row, not two", async () => {
    const b = await business();
    const keys = browserKeys();
    const endpoint = `https://${FAKE_PUSH_HOST}/${crypto.randomUUID()}`;
    const args = {
      accountId: b.account_id,
      userId: b.user_id,
      sessionId: null,
      userAgent: "Android",
      target: { endpoint, ...keys },
    };
    const first = await saveSubscription(args);
    const second = await saveSubscription(args);
    expect(second.id).toBe(first.id);
    expect(await listDevices(b.account_id, null)).toHaveLength(1);
  });

  it("the screen's list carries a label and dates, never the endpoint", async () => {
    const b = await business();
    await device(b);
    const list = await listDevices(b.account_id, null);
    expect(JSON.stringify(list)).not.toContain(FAKE_PUSH_HOST);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual([
      "created_at",
      "id",
      "label",
      "last_sent_at",
      "this_browser",
    ]);
  });

  it("a device is removable by its own account only", async () => {
    const b = await business();
    const other = await business();
    const d = await device(b);
    expect(await removeDevice(other.account_id, d.id)).toBe(false);
    expect(await listDevices(b.account_id, null)).toHaveLength(1);
    expect(await removeDevice(b.account_id, d.id)).toBe(true);
    expect(await listDevices(b.account_id, null)).toHaveLength(0);
  });

  it("signing out of the browser that switched it on removes it; another sign-in's device stays", async () => {
    const b = await business();
    const token = randomBytes(32).toString("base64url");
    const [session] = await db
      .insert(authSessions)
      .values({
        account_id: b.account_id,
        user_id: b.user_id,
        token_hash: createHash("sha256").update(token).digest("hex"),
        expires_at: "2027-12-31T00:00:00.000Z",
      })
      .returning({ id: authSessions.id });
    const here = await device(b, { sessionId: session?.id ?? null });
    const elsewhere = await device(b);
    expect((await listDevices(b.account_id, session?.id ?? null))[0]?.this_browser).toBe(true);
    await revokeSession(token);
    const left = await listDevices(b.account_id, null);
    expect(left.map((d) => d.id)).toEqual([elsewhere.id]);
    expect(left.map((d) => d.id)).not.toContain(here.id);
  });

  it("go with the account when it is erased", async () => {
    const b = await business();
    await device(b);
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, b.profile_id));
    await db.delete(intakeEvents).where(eq(intakeEvents.profile_id, b.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, b.profile_id));
    await db.delete(users).where(eq(users.account_id, b.account_id));
    await db.delete(accounts).where(eq(accounts.id, b.account_id));
    const rows = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.account_id, b.account_id));
    expect(rows).toHaveLength(0);
  });
});

describe("Send a test", () => {
  it("reaches every device once and doesn't count as the day's alert", async () => {
    const b = await business();
    await device(b);
    await device(b, { ua: "Android" });
    const fake = fakePushService();
    const out = await sendTestPush(b.account_id, fake);
    expect(out.map((o) => o.outcome.kind)).toEqual(["sent", "sent"]);
    expect(fake.sent[0]?.payload.body).toMatch(/test/i);
    expect((await listDevices(b.account_id, null)).map((d) => d.last_sent_at)).toEqual([
      null,
      null,
    ]);
  });

  it("a gone device found by a test is removed too", async () => {
    const b = await business();
    const d = await device(b);
    const out = await sendTestPush(b.account_id, fakePushService({ gone: new Set([d.endpoint]) }));
    expect(out[0]?.outcome).toEqual({ kind: "gone", status: 410 });
    expect(await listDevices(b.account_id, null)).toHaveLength(0);
  });
});

// Idea 52: a phone is its person's; an alert asks for a decision, so it goes
// only to owners and managers still on the team.
describe("devices on a team", () => {
  async function teammate(b: { account_id: string }, role: "owner" | "manager" | "viewer") {
    const [u] = await db
      .insert(users)
      .values({
        account_id: b.account_id,
        email: `i52-${crypto.randomUUID()}@test.local`,
        display_name: "teammate",
        role,
      })
      .returning({ id: users.id });
    if (!u) throw new Error("no user");
    return { account_id: b.account_id, user_id: u.id };
  }

  it("lists and removes only the person's own devices", async () => {
    const b = await business();
    const mine = await device(b);
    const theirs = await device(await teammate(b, "manager"));
    expect((await listDevices(b.account_id, null, b.user_id)).map((d) => d.id)).toEqual([mine.id]);
    expect(await removeDevice(b.account_id, theirs.id, b.user_id)).toBe(false);
    expect(await removeDevice(b.account_id, mine.id, b.user_id)).toBe(true);
    expect(await listDevices(b.account_id, null)).toHaveLength(1);
  });

  it("sends only to owners and managers, never a viewer or someone taken off", async () => {
    const b = await business();
    const owner = await device(b);
    const managerUser = await teammate(b, "manager");
    const manager = await device(managerUser);
    await device(await teammate(b, "viewer"));
    const gone = await teammate(b, "manager");
    await device(gone);
    await db
      .update(users)
      .set({ removed_at: new Date().toISOString() })
      .where(eq(users.id, gone.user_id));
    const ids = (await openDevices(b.account_id)).map((d) => d.id).sort();
    expect(ids).toEqual([owner.id, manager.id].sort());
    // "Send a test" reaches the presser's own devices only.
    expect((await openDevices(b.account_id, managerUser.user_id)).map((d) => d.id)).toEqual([
      manager.id,
    ]);
  });
});
