// P4-11 — escalation to a human, end to end, as tests: the handover
// states the owner's reply time only when one is set; the customer may
// leave an address, which becomes a consent-"unsure" contact tied to the
// ticket (a suppressed one is not recreated, and the customer can't tell
// the difference); and the owner's notice goes only to the owner, with no
// customer text, at most once an hour, and never without the key.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  contactSuppressions,
  contacts,
  fieldRecords,
  intakeEvents,
  supportConversations,
  supportSettings,
  supportTickets,
  users,
} from "../../db/schema";
import { emailHash } from "../crm/contacts";
import { ensureSupportSettings, setNotifyOwner, setReplyHours } from "../crm/support-settings";
import { bootstrapIntake } from "../intake/service";
import { postCustomerMessage, startConversation } from "./chat";
import {
  ADDRESS_SAVED,
  SUPPORT_MAX_ADDRESSES_PER_CLIENT_PER_DAY,
  SUPPORT_MAX_ADDRESSES_PER_DAY,
  leaveAddress,
} from "./handover";
import { notifyOwnerOfEmailTicket } from "./notify-owner";

const created: { account_id: string; profile_id: string }[] = [];
const saved = { ...process.env };

afterAll(async () => {
  process.env = { ...saved };
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length > 0) {
    await db.delete(supportTickets).where(inArray(supportTickets.profile_id, ids));
    await db.delete(supportConversations).where(inArray(supportConversations.profile_id, ids));
    await db.delete(supportSettings).where(inArray(supportSettings.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(contacts).where(inArray(contacts.account_id, accountIds));
    await db.delete(contactSuppressions).where(inArray(contactSuppressions.account_id, accountIds));
    await db.delete(users).where(inArray(users.account_id, accountIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  const settings = await ensureSupportSettings(s.profile_id);
  return { ...s, site_key: settings.site_key };
}

/** A conversation handed to a person — "a real person, please" escalates before any model. */
async function handedOver(siteKey: string) {
  const started = await startConversation(siteKey);
  const out = await postCustomerMessage(started.token, "Can I talk to a real person please?");
  return { token: started.token, out };
}

describe("P4-11 — the handover promises only what the owner stated", () => {
  it("with no reply time set it promises nothing; with one, it states it", async () => {
    const b = await business();
    const none = await handedOver(b.site_key);
    expect(none.out).toMatchObject({
      escalated: true,
      reason: "customer_asked",
      ask_address: true,
    });
    expect(none.out.reply.text).toContain("A person will reply; I can't promise when.");
    expect(none.out.reply.text).not.toMatch(/within \d+/);

    await setReplyHours(b.profile_id, 24);
    const set = await handedOver(b.site_key);
    expect(set.out.reply.text).toContain("A person usually replies within 24 hours.");
  });

  it("a reply time is the owner's: whole hours, 1 to 720, stored with when; cleared is null", async () => {
    const b = await business();
    await expect(setReplyHours(b.profile_id, 0)).rejects.toMatchObject({ status: 422 });
    await expect(setReplyHours(b.profile_id, 721)).rejects.toMatchObject({ status: 422 });
    await expect(setReplyHours(b.profile_id, 2.5)).rejects.toMatchObject({ status: 422 });
    const row = await setReplyHours(b.profile_id, 720);
    expect(row.reply_hours).toBe(720);
    expect(row.reply_hours_set_at).not.toBeNull();
    const cleared = await setReplyHours(b.profile_id, null);
    expect(cleared).toMatchObject({ reply_hours: null, reply_hours_set_at: null });
  });
});

describe("P4-11 — the optional address", () => {
  it("becomes a consent-unsure contact tied to the ticket, with provenance that says why", async () => {
    const b = await business();
    const { token, out } = await handedOver(b.site_key);
    expect(await leaveAddress(token, "  Petra.P411@Example.com ")).toEqual({
      message: ADDRESS_SAVED,
    });
    expect(ADDRESS_SAVED).toContain("not for marketing");
    const [ticket] = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, out.ticket_id!));
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, ticket!.contact_id!));
    expect(contact).toMatchObject({ email: "petra.p411@example.com", consent_status: "unsure" });
    expect(contact?.consent_source).toMatch(/website chat .* not marketing consent/);
    // Once is enough; a second address is refused, and asking again no longer offers it.
    await expect(leaveAddress(token, "other@example.com")).rejects.toMatchObject({ status: 409 });
    const again = await postCustomerMessage(token, "Speak to a human please");
    expect(again.ask_address).toBe(false);
  });

  it("refuses junk, a conversation with nobody waiting, and an unknown token", async () => {
    const b = await business();
    const { token } = await handedOver(b.site_key);
    await expect(leaveAddress(token, "not-an-address")).rejects.toMatchObject({ status: 422 });
    const quiet = await startConversation(b.site_key);
    await expect(leaveAddress(quiet.token, "a@b.example")).rejects.toMatchObject({ status: 409 });
    await expect(leaveAddress("f".repeat(48), "a@b.example")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("a suppressed address is not recreated, the ticket says replies are refused, and the customer hears the same", async () => {
    const b = await business();
    const email = "erased.p411@example.com";
    await db
      .insert(contactSuppressions)
      .values({ account_id: b.account_id, email_hash: emailHash(email), reason: "erasure" });
    const { token, out } = await handedOver(b.site_key);
    expect(await leaveAddress(token, email)).toEqual({ message: ADDRESS_SAVED });
    expect(await db.select().from(contacts).where(eq(contacts.email, email))).toHaveLength(0);
    const [ticket] = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, out.ticket_id!));
    expect(ticket).toMatchObject({ contact_id: null, suppressed_address: true });
  });

  it("review #19: parallel posts on one ticket create one contact and tie exactly one address", async () => {
    const b = await business();
    const { token, out } = await handedOver(b.site_key);
    const emails = Array.from({ length: 6 }, (_, i) => `race${i}.p411@example.com`);
    const results = await Promise.allSettled(emails.map((e) => leaveAddress(token, e)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    }
    const made = await db.select().from(contacts).where(eq(contacts.account_id, b.account_id));
    expect(made).toHaveLength(1);
    const [ticket] = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, out.ticket_id!));
    expect(ticket?.contact_id).toBe(made[0]!.id);
  });

  it("review #19: one visitor can leave only a few addresses a day; another visitor still can", async () => {
    const b = await business();
    const visitor = async (ip: string) => {
      const started = await startConversation(b.site_key, { clientIp: ip });
      await postCustomerMessage(started.token, "Can I talk to a real person please?");
      return started.token;
    };
    for (let i = 0; i < SUPPORT_MAX_ADDRESSES_PER_CLIENT_PER_DAY; i += 1) {
      expect(await leaveAddress(await visitor("203.0.113.7"), `v${i}.p411@example.com`)).toEqual({
        message: ADDRESS_SAVED,
      });
    }
    await expect(
      leaveAddress(await visitor("203.0.113.7"), "one-more.p411@example.com"),
    ).rejects.toMatchObject({ status: 429 });
    expect(
      await db.select().from(contacts).where(eq(contacts.email, "one-more.p411@example.com")),
    ).toHaveLength(0);
    // The passing case: someone else, the same day.
    expect(await leaveAddress(await visitor("198.51.100.9"), "other.p411@example.com")).toEqual({
      message: ADDRESS_SAVED,
    });
    expect(SUPPORT_MAX_ADDRESSES_PER_DAY).toBeGreaterThan(SUPPORT_MAX_ADDRESSES_PER_CLIENT_PER_DAY);
  });
});

describe("P4-11 — the owner's notice", () => {
  async function owned() {
    const b = await business();
    const [user] = await db
      .insert(users)
      .values({
        account_id: b.account_id,
        email: `owner-${crypto.randomUUID().slice(0, 8)}@syb.test`,
        display_name: "Owner",
        role: "owner",
      })
      .returning();
    return { ...b, owner_email: user!.email };
  }
  function fake() {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const impl = async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: "re_x" }), { status: 200 });
    };
    return { impl, calls };
  }

  it("without the key nothing is sent and nothing claims it was", async () => {
    const b = await owned();
    const f = fake();
    delete process.env.RESEND_API_KEY;
    expect(
      await notifyOwnerOfEmailTicket({
        profileId: b.profile_id,
        ticketId: crypto.randomUUID(),
        fetchImpl: f.impl,
      }),
    ).toBe("not_configured");
    expect(f.calls).toHaveLength(0);
  });

  it("goes to the owner's own address only, carries no customer text, and at most once an hour", async () => {
    process.env.RESEND_API_KEY = "re_test_fixture";
    const b = await owned();
    const f = fake();
    const t0 = new Date("2026-10-19T09:00:00Z");
    expect(
      await notifyOwnerOfEmailTicket({
        profileId: b.profile_id,
        ticketId: crypto.randomUUID(),
        fetchImpl: f.impl,
        now: t0,
      }),
    ).toBe("sent");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.body.to).toEqual([b.owner_email]);
    expect(String(f.calls[0]!.body.text)).not.toMatch(/@example\.com|Subject|order/i);
    expect(String(f.calls[0]!.body.text)).toContain("Nothing has been sent to them");

    const later = (min: number) => new Date(t0.getTime() + min * 60_000);
    expect(
      await notifyOwnerOfEmailTicket({
        profileId: b.profile_id,
        ticketId: crypto.randomUUID(),
        fetchImpl: f.impl,
        now: later(59),
      }),
    ).toBe("recently_sent");
    expect(
      await notifyOwnerOfEmailTicket({
        profileId: b.profile_id,
        ticketId: crypto.randomUUID(),
        fetchImpl: f.impl,
        now: later(61),
      }),
    ).toBe("sent");
    expect(f.calls).toHaveLength(2);

    await setNotifyOwner(b.profile_id, false);
    expect(
      await notifyOwnerOfEmailTicket({
        profileId: b.profile_id,
        ticketId: crypto.randomUUID(),
        fetchImpl: f.impl,
        now: later(200),
      }),
    ).toBe("off");
    expect(f.calls).toHaveLength(2);
  });

  it("a business with no owner account gets no notice at all", async () => {
    process.env.RESEND_API_KEY = "re_test_fixture";
    const b = await business();
    const f = fake();
    expect(
      await notifyOwnerOfEmailTicket({
        profileId: b.profile_id,
        ticketId: crypto.randomUUID(),
        fetchImpl: f.impl,
      }),
    ).toBe("no_owner");
    expect(f.calls).toHaveLength(0);
  });

  it("review #24: a Resend that never answers is abandoned — the notice fails, the webhook isn't held", async () => {
    process.env.RESEND_API_KEY = "re_test_fixture";
    const b = await owned();
    const signals: (AbortSignal | null | undefined)[] = [];
    const hanging = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        signals.push(init.signal);
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const started = Date.now();
    expect(
      await notifyOwnerOfEmailTicket({
        profileId: b.profile_id,
        ticketId: crypto.randomUUID(),
        fetchImpl: hanging,
        timeoutMs: 50,
      }),
    ).toBe("failed");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    // The passing case carries a signal too, by default.
    const c = await owned();
    const seen: (AbortSignal | null | undefined)[] = [];
    expect(
      await notifyOwnerOfEmailTicket({
        profileId: c.profile_id,
        ticketId: crypto.randomUUID(),
        fetchImpl: async (_url, init) => {
          seen.push(init.signal);
          return new Response(JSON.stringify({ id: "re_x" }), { status: 200 });
        },
      }),
    ).toBe("sent");
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});
