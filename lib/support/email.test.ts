// P4-09 — inbound email becomes ticket threads tied to contacts, as tests.
//
// Against recorded-shape Resend payloads (resend-fixtures.ts); no network.
// What must hold: a delivery is filed only with a valid, fresh signature;
// the routing token picks the business and an unknown one is dropped; a
// reply joins its ticket (by References, or by the thread token in the
// reply-to address) and anything else opens one; a redelivery files
// nothing twice; an unknown sender becomes a consent-"unsure" contact, an
// existing contact's consent never moves, and a suppressed address is not
// recreated; long bodies are capped and say so.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  contactSuppressions,
  contacts,
  fieldRecords,
  intakeEvents,
  supportEmailMessages,
  supportSettings,
  supportTickets,
} from "../../db/schema";
import { addContact, emailHash } from "../crm/contacts";
import { openQuestions } from "../crm/faq";
import { ensureSupportSettings, rotateInboundToken } from "../crm/support-settings";
import { bootstrapIntake } from "../intake/service";
import {
  emailThread,
  inboundAddress,
  MAX_LOCAL_PART,
  newThreadToken,
  receiveInboundEmail,
  referencedIds,
  routingFrom,
  threadAddress,
} from "./email-tickets";
import type { InboundEmail } from "./inbound";
import {
  SUPPORT_EMAIL_BODY_MAX_CHARS,
  WEBHOOK_TOLERANCE_SECONDS,
  htmlToText,
  normaliseReceived,
  parseAddress,
  parseReceivedEvent,
  signWebhook,
  verifyWebhook,
} from "./inbound";
import type { ReceivedFixture } from "./resend-fixtures";
import { fakeResendReceiving, receivedEmail, receivedEvent } from "./resend-fixtures";
import { suppressionHash } from "./support-contact";

const DOMAIN = "inbound.syb.test";
const SECRET = `whsec_${Buffer.from("p4-09-test-secret-material-32by").toString("base64")}`;
const created: { account_id: string; profile_id: string }[] = [];

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  const settings = await ensureSupportSettings(s.profile_id);
  return {
    ...s,
    token: settings.inbound_token,
    address: inboundAddress(settings.inbound_token, DOMAIN),
  };
}

let n = 0;
function fixture(over: Partial<ReceivedFixture> & { to: string[] }): ReceivedFixture {
  n += 1;
  return {
    email_id: crypto.randomUUID(),
    from: "Ana Kovács <ana.p409@example.com>",
    subject: "Where is my order?",
    text: "Hi, I ordered a mug on Monday (order 2231). Has it shipped?\n\nAna",
    message_id: `<p409-${n}-${crypto.randomUUID()}@mail.example.com>`,
    created_at: new Date(Date.now() - 60_000 + n).toISOString(),
    ...over,
  };
}

function normalised(f: ReceivedFixture): InboundEmail {
  const email = normaliseReceived(parseReceivedEvent(receivedEvent(f))!, receivedEmail(f));
  if (!email) throw new Error("fixture did not normalise");
  return email;
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(supportTickets).where(inArray(supportTickets.profile_id, ids));
    await db.delete(supportSettings).where(inArray(supportSettings.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) {
    await db.delete(contacts).where(eq(contacts.account_id, s.account_id));
    await db.delete(contactSuppressions).where(eq(contactSuppressions.account_id, s.account_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P4-09 — the Svix signature, verified before anything is read", () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "x" } });
  const now = new Date("2026-10-19T12:00:00Z");
  const ts = String(Math.floor(now.getTime() / 1000));

  it("accepts a valid, fresh signature — also when it is one of several", () => {
    const sig = signWebhook(body, "msg_1", ts, SECRET);
    expect(
      verifyWebhook({
        rawBody: body,
        secret: SECRET,
        now,
        headers: { id: "msg_1", timestamp: ts, signature: sig },
      }),
    ).toEqual({ ok: true });
    expect(
      verifyWebhook({
        rawBody: body,
        secret: SECRET,
        now,
        headers: { id: "msg_1", timestamp: ts, signature: `v1,AAAA ${sig}` },
      }).ok,
    ).toBe(true);
  });

  it("refuses a tampered body, a wrong secret, missing headers and a stale or future timestamp", () => {
    const sig = signWebhook(body, "msg_1", ts, SECRET);
    const h = { id: "msg_1", timestamp: ts, signature: sig };
    expect(verifyWebhook({ rawBody: `${body} `, secret: SECRET, now, headers: h }).ok).toBe(false);
    expect(
      verifyWebhook({
        rawBody: body,
        secret: `whsec_${Buffer.from("other").toString("base64")}`,
        now,
        headers: h,
      }).ok,
    ).toBe(false);
    expect(
      verifyWebhook({ rawBody: body, secret: SECRET, now, headers: { ...h, signature: null } }).ok,
    ).toBe(false);
    expect(
      verifyWebhook({ rawBody: body, secret: SECRET, now, headers: { ...h, id: "msg_2" } }).ok,
    ).toBe(false);
    // The tolerance boundary, both sides.
    const at = (s: number) => new Date(now.getTime() + s * 1000);
    expect(
      verifyWebhook({
        rawBody: body,
        secret: SECRET,
        now: at(WEBHOOK_TOLERANCE_SECONDS),
        headers: h,
      }).ok,
    ).toBe(true);
    expect(
      verifyWebhook({
        rawBody: body,
        secret: SECRET,
        now: at(WEBHOOK_TOLERANCE_SECONDS + 1),
        headers: h,
      }).ok,
    ).toBe(false);
    expect(
      verifyWebhook({
        rawBody: body,
        secret: SECRET,
        now: at(-WEBHOOK_TOLERANCE_SECONDS - 1),
        headers: h,
      }).ok,
    ).toBe(false);
  });
});

describe("P4-09 — the adapter normalises Resend's two shapes into one", () => {
  it("reads the metadata-only event and the retrieved email's body and headers", () => {
    const f = fixture({
      to: ["hello@shop.example"],
      received_for: ["s-0123456789abcdef0123456789abcdef@inbound.syb.test"],
      in_reply_to: "<prior@mail.example.com>",
      references: "<root@mail.example.com> <prior@mail.example.com>",
    });
    const event = parseReceivedEvent(receivedEvent(f));
    expect(event?.email_id).toBe(f.email_id);
    const email = normalised(f);
    expect(email.from).toEqual({ address: "ana.p409@example.com", name: "Ana Kovács" });
    expect(email.to).toContain("s-0123456789abcdef0123456789abcdef@inbound.syb.test");
    expect(email.message_id).toBe(f.message_id);
    expect(email.in_reply_to).toBe("<prior@mail.example.com>");
    expect(email.references).toBe("<root@mail.example.com> <prior@mail.example.com>");
    expect(email.text).toContain("order 2231");
  });

  it("ignores other events; falls back to the HTML, stripped; refuses an unreadable sender", () => {
    expect(parseReceivedEvent({ type: "email.sent", data: { email_id: "x" } })).toBeNull();
    expect(parseReceivedEvent({ type: "email.received", data: {} })).toBeNull();
    const html = fixture({
      to: ["x@y.example"],
      text: null,
      html: "<html><head><style>p{}</style></head><body><p>Hello&nbsp;there</p><script>alert(1)</script><div>Line two &amp; more</div></body></html>",
    });
    expect(normalised(html).text).toBe("Hello there\nLine two & more");
    expect(htmlToText("<b>a</b><br/>b")).toBe("a\nb");
    const bad = fixture({ to: ["x@y.example"], from: "not an address" });
    expect(
      normaliseReceived(parseReceivedEvent(receivedEvent(bad))!, receivedEmail(bad)),
    ).toBeNull();
    expect(parseAddress('"Kovács, Ana" <Ana@Example.COM>')).toEqual({
      address: "ana@example.com",
      name: "Kovács, Ana",
    });
  });

  it("caps a long body and says it did", () => {
    const long = fixture({
      to: ["x@y.example"],
      text: "a".repeat(SUPPORT_EMAIL_BODY_MAX_CHARS + 50),
    });
    const email = normalised(long);
    expect(email.text).toHaveLength(SUPPORT_EMAIL_BODY_MAX_CHARS);
    expect(email.truncated).toBe(true);
    expect(normalised(fixture({ to: ["x@y.example"] })).truncated).toBe(false);
  });

  it("routing and references are read from addresses and headers, for our domain only", () => {
    const t = "0123456789abcdef0123456789abcdef";
    const th = "fedcba9876543210fedcba9876543210";
    expect(routingFrom([`s-${t}@${DOMAIN}`], DOMAIN)).toEqual({ routing: t, thread: null });
    expect(routingFrom(["hello@shop.example", threadAddress(t, th, DOMAIN)], DOMAIN)).toEqual({
      routing: t,
      thread: th,
    });
    expect(routingFrom([`s-${t}@elsewhere.example`], DOMAIN)).toBeNull();
    expect(routingFrom([`s-${t.slice(1)}@${DOMAIN}`], DOMAIN)).toBeNull();
    expect(referencedIds("<a@x>", "<b@x> <a@x>")).toEqual(["<a@x>", "<b@x>"]);
  });

  it("a reply address fits RFC 5321's 64-char local part, and older 32-char threads still parse", () => {
    const t = "0123456789abcdef0123456789abcdef";
    const fresh = newThreadToken();
    const local = threadAddress(t, fresh, DOMAIN).split("@")[0]!;
    expect(local.length).toBeLessThanOrEqual(MAX_LOCAL_PART);
    expect(routingFrom([threadAddress(t, fresh, DOMAIN)], DOMAIN)).toEqual({
      routing: t,
      thread: fresh,
    });
    const old = "fedcba9876543210fedcba9876543210";
    expect(routingFrom([`s-${t}+${old}@${DOMAIN}`], DOMAIN)).toEqual({ routing: t, thread: old });
    expect(routingFrom([`s-${t}+${old.slice(1)}@${DOMAIN}`], DOMAIN)).toBeNull();
  });
});

describe("P4-09 — routing, threading and idempotency", () => {
  it("opens a ticket for a new email, ties it to a new consent-unsure contact, and files a redelivery once", async () => {
    const b = await business();
    const f = fixture({ to: ["hello@shop.example"], received_for: [b.address] });
    const out = await receiveInboundEmail(normalised(f), DOMAIN);
    expect(out).toMatchObject({ kind: "filed", created: true });
    if (out.kind !== "filed") throw new Error("not filed");
    const [ticket] = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, out.ticket_id));
    expect(ticket).toMatchObject({
      channel: "email",
      reason: "emailed",
      status: "open",
      conversation_id: null,
      summary: "Where is my order?",
      suppressed_address: false,
    });
    expect(ticket?.thread_token).toMatch(/^[0-9a-f]{24}$/);
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, ticket!.contact_id!));
    expect(contact).toMatchObject({
      email: "ana.p409@example.com",
      name: "Ana Kovács",
      consent_status: "unsure",
    });
    expect(contact?.consent_source).toMatch(
      /^emailed support \d{4}-\d{2}-\d{2} — a support request is not marketing consent$/,
    );

    // The same delivery again: acknowledged, nothing filed twice.
    expect(await receiveInboundEmail(normalised(f), DOMAIN)).toMatchObject({ kind: "duplicate" });
    expect(await emailThread(out.ticket_id)).toHaveLength(1);
    expect(
      await db.select().from(supportTickets).where(eq(supportTickets.profile_id, b.profile_id)),
    ).toHaveLength(1);
  });

  it("a reply joins its ticket by References, or by the thread token; anything else opens a new one", async () => {
    const b = await business();
    const first = fixture({ to: [b.address] });
    const opened = await receiveInboundEmail(normalised(first), DOMAIN);
    if (opened.kind !== "filed") throw new Error("not filed");

    const byRefs = fixture({
      to: [b.address],
      subject: "Re: Where is my order?",
      in_reply_to: first.message_id,
      references: first.message_id,
    });
    expect(await receiveInboundEmail(normalised(byRefs), DOMAIN)).toMatchObject({
      kind: "filed",
      created: false,
      ticket_id: opened.ticket_id,
    });

    // A mail client that drops the headers still threads by the reply-to address.
    const [t] = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, opened.ticket_id));
    // An answered ticket the customer writes back on is open again.
    await db
      .update(supportTickets)
      .set({ status: "answered" })
      .where(eq(supportTickets.id, opened.ticket_id));
    const byToken = fixture({
      to: [threadAddress(b.token, t!.thread_token!, DOMAIN)],
      subject: "one more thing",
    });
    expect(await receiveInboundEmail(normalised(byToken), DOMAIN)).toMatchObject({
      kind: "filed",
      created: false,
      ticket_id: opened.ticket_id,
    });
    const [reopened] = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, opened.ticket_id));
    expect(reopened?.status).toBe("open");
    expect((await emailThread(opened.ticket_id)).map((m) => m.subject)).toEqual([
      "Where is my order?",
      "Re: Where is my order?",
      "one more thing",
    ]);

    const fresh = fixture({
      to: [b.address],
      subject: "Do you do gift wrapping?",
      message_id: "<unrelated@mail.example.com>",
    });
    expect(await receiveInboundEmail(normalised(fresh), DOMAIN)).toMatchObject({
      kind: "filed",
      created: true,
    });

    // Another business's Message-IDs never thread into this one.
    const other = await business();
    const stray = fixture({ to: [other.address], in_reply_to: first.message_id });
    const strayOut = await receiveInboundEmail(normalised(stray), DOMAIN);
    expect(strayOut).toMatchObject({ kind: "filed", created: true });
  });

  it("an unknown or rotated token is acknowledged and dropped, logging no address", async () => {
    const b = await business();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const unknown = fixture({ to: [inboundAddress("f".repeat(32), DOMAIN)] });
      expect(await receiveInboundEmail(normalised(unknown), DOMAIN)).toEqual({ kind: "unrouted" });
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("support_inbound_unrouted"))).toBe(true);
      expect(lines.join("\n")).not.toContain("ana.p409@example.com");
      expect(lines.join("\n")).not.toContain("Where is my order");
    } finally {
      log.mockRestore();
    }
    await rotateInboundToken(b.profile_id);
    expect(await receiveInboundEmail(normalised(fixture({ to: [b.address] })), DOMAIN)).toEqual({
      kind: "unrouted",
    });
    expect(
      await db.select().from(supportTickets).where(eq(supportTickets.profile_id, b.profile_id)),
    ).toHaveLength(0);
  });
});

describe("P4-09 — contacts under rule 19", () => {
  it("an existing contact's consent is never changed by emailing in", async () => {
    const b = await business();
    const c = await addContact(b.account_id, {
      email: "explicit.p409@example.com",
      name: "Already Here",
      consent: { status: "explicit_consent", source: "checkout checkbox 2026-03-12" },
    });
    const out = await receiveInboundEmail(
      normalised(fixture({ to: [b.address], from: "Someone Else <EXPLICIT.p409@example.com>" })),
      DOMAIN,
    );
    if (out.kind !== "filed") throw new Error("not filed");
    const [after] = await db.select().from(contacts).where(eq(contacts.id, c.id));
    expect(after).toMatchObject({
      consent_status: "explicit_consent",
      consent_source: "checkout checkbox 2026-03-12",
      name: "Already Here",
    });
    const [ticket] = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, out.ticket_id));
    expect(ticket?.contact_id).toBe(c.id);
    // And a no-consent contact stays no-consent.
    const none = await addContact(b.account_id, {
      email: "none.p409@example.com",
      consent: { status: "no_consent", source: "owner says" },
    });
    await receiveInboundEmail(
      normalised(fixture({ to: [b.address], from: "none.p409@example.com" })),
      DOMAIN,
    );
    const [still] = await db.select().from(contacts).where(eq(contacts.id, none.id));
    expect(still?.consent_status).toBe("no_consent");
  });

  it("a suppressed address gets no contact row back; the ticket exists and says replies are refused", async () => {
    const b = await business();
    const email = "gone.p409@example.com";
    await db
      .insert(contactSuppressions)
      .values({ account_id: b.account_id, email_hash: emailHash(email), reason: "erasure" });
    const out = await receiveInboundEmail(
      normalised(fixture({ to: [b.address], from: `Gone <${email}>` })),
      DOMAIN,
    );
    if (out.kind !== "filed") throw new Error("not filed");
    expect(await db.select().from(contacts).where(eq(contacts.email, email))).toHaveLength(0);
    const [ticket] = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, out.ticket_id));
    expect(ticket).toMatchObject({ contact_id: null, suppressed_address: true, status: "open" });
  });

  it("the support tier's suppression hash is lib/crm's, character for character", () => {
    for (const e of ["a@b.example", "  Mixed.Case@Example.COM "])
      expect(suppressionHash(e)).toBe(emailHash(e));
  });
});

describe("P4-09 — the FAQ does not cluster emailed questions (decision recorded in TASKS-PHASE4)", () => {
  it("an emailed ticket is not among the open questions", async () => {
    const b = await business();
    const out = await receiveInboundEmail(
      normalised(fixture({ to: [b.address], subject: "Do you ship to Canada?" })),
      DOMAIN,
    );
    if (out.kind !== "filed") throw new Error("not filed");
    expect((await openQuestions(b.profile_id)).map((q) => q.id)).not.toContain(out.ticket_id);
  });
});

describe("P4-09 — the webhook route, end to end against a fake Resend", () => {
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    process.env.SUPPORT_INBOUND_DOMAIN = DOMAIN;
    process.env.RESEND_API_KEY = "re_test_fixture";
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => {
    process.env = { ...saved };
  });

  async function deliver(body: string, sign = true, env: Record<string, string> = {}) {
    const { POST } = await import("../../app/api/support/inbound/route");
    const ts = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "svix-id": `msg_${crypto.randomUUID()}`,
      "svix-timestamp": ts,
      ...env,
    };
    headers["svix-signature"] = sign
      ? signWebhook(body, headers["svix-id"]!, ts, SECRET)
      : "v1,bm9wZQ==";
    const { NextRequest } = await import("next/server");
    return POST(
      new NextRequest("http://localhost/api/support/inbound", { method: "POST", body, headers }),
    );
  }

  it("a bad signature is a 401 and nothing is fetched or filed", async () => {
    const b = await business();
    const f = fixture({ to: [b.address] });
    const fake = fakeResendReceiving([f]);
    vi.stubGlobal("fetch", fake.impl);
    const res = await deliver(JSON.stringify(receivedEvent(f)), false);
    expect(res.status).toBe(401);
    expect(fake.calls).toEqual([]);
    expect(
      await db
        .select()
        .from(supportEmailMessages)
        .where(eq(supportEmailMessages.provider_id, f.email_id)),
    ).toHaveLength(0);
  });

  it("a signed delivery is fetched once from Resend and filed; unknown events are acknowledged", async () => {
    const b = await business();
    const f = fixture({ to: [b.address] });
    const fake = fakeResendReceiving([f]);
    vi.stubGlobal("fetch", fake.impl);
    const res = await deliver(JSON.stringify(receivedEvent(f)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "filed" });
    expect(fake.calls).toEqual([`GET https://api.resend.com/emails/receiving/${f.email_id}`]);
    const other = await deliver(JSON.stringify({ type: "email.delivered", data: {} }));
    expect(await other.json()).toEqual({ ignored: true });
  });

  it("with no signing secret, every delivery is refused (503) — never filed unverified", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    try {
      const res = await deliver(
        JSON.stringify({ type: "email.received", data: { email_id: "x" } }),
      );
      expect(res.status).toBe(503);
    } finally {
      process.env.RESEND_WEBHOOK_SECRET = SECRET;
    }
  });
});
