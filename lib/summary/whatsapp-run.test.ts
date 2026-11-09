// P6-07 — the weekly summary on WhatsApp, against the database. A fake
// Twilio (fake HTTP: a fetch that records and answers) stands in for the
// Messages API, and a fake sender for Resend: nothing touches the network.
// Held here: no send without a live opt-in (rule 19); withdrawing stops the
// next week; one claim per (account, week) however many channels; a
// refusal is recorded and never retried; the template falls back to
// English; erasure forgets the number (rule 22); and no log line carries
// the number or a word of the message.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  modeDecisions,
  users,
  weeklySummaries,
  whatsappOptins,
} from "../../db/schema";
import type { OwnerEmail, OwnerEmailOutcome } from "../auth/email";
import { removeMember } from "../auth/members";
import { bootstrapIntake } from "../intake/service";
import { setSummaryChannel } from "./prefs";
import type { SummaryChannel } from "./switch";
import { runWeeklySummaries } from "./run";
import { isoWeek } from "./week";
import { DIGEST_SEPARATOR, variableProblems } from "./whatsapp";
import {
  consentSentence,
  eraseWhatsAppNumbers,
  liveOptin,
  optIn,
  sha256Hex,
  withdrawOptin,
} from "./whatsapp-optin";

process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const EN_SID = `HX${"e".repeat(32)}`;
const DE_SID = `HX${"d".repeat(32)}`;
const KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_FROM",
  "TWILIO_WHATSAPP_SUMMARY_TEMPLATES",
  "LANGUAGES_IN_REVIEW",
] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.TWILIO_ACCOUNT_SID = `AC${"a1".repeat(16)}`;
  process.env.TWILIO_AUTH_TOKEN = "fake-twilio-auth-token";
  process.env.TWILIO_WHATSAPP_FROM = "+447700900001";
  process.env.TWILIO_WHATSAPP_SUMMARY_TEMPLATES = JSON.stringify({ en: EN_SID, "de-DE": DE_SID });
  delete process.env.LANGUAGES_IN_REVIEW;
});

afterAll(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  const accountIds = created.map((c) => c.account_id);
  const profileIds = created.map((c) => c.profile_id);
  if (accountIds.length === 0) return;
  await db.delete(weeklySummaries).where(inArray(weeklySummaries.account_id, accountIds));
  await db.delete(whatsappOptins).where(inArray(whatsappOptins.account_id, accountIds));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, profileIds));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

afterEach(() => vi.restoreAllMocks());

const created: { account_id: string; profile_id: string; user_id: string }[] = [];

const number = () => `+4477009${String(Math.floor(Math.random() * 100_000)).padStart(5, "0")}`;

async function business(opts: { channel?: SummaryChannel; language?: string } = {}) {
  const s = await bootstrapIntake();
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p607-${crypto.randomUUID()}@test.local`,
      display_name: "WhatsApp owner",
      role: "owner",
      language: opts.language ?? null,
    })
    .returning({ id: users.id });
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: "watching",
    watch_weeks: 6,
    inputs: { reasons: [] },
    reasoning: "test",
    confidence: "0.750",
    review_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  if (opts.channel) await setSummaryChannel(u!.id, opts.channel);
  const entry = { ...s, user_id: u!.id };
  created.push(entry);
  return entry;
}

async function yes(b: { account_id: string; user_id: string }, phone = number()) {
  const r = await optIn({
    accountId: b.account_id,
    userId: b.user_id,
    number: phone,
    locale: "en",
    shown: await consentSentence("en"),
  });
  if (!r.ok) throw new Error(r.reason);
  return { ...r.optin, phone };
}

interface TwilioCall {
  url: string;
  form: URLSearchParams;
  auth: string | null;
}

/** A fake Twilio Messages API: records each POST and answers as told. */
function fakeTwilio(answer: { status: number; body: unknown } = { status: 201, body: null }) {
  const calls: TwilioCall[] = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({
        url,
        form: new URLSearchParams(String(init.body)),
        auth: (init.headers as Record<string, string>).Authorization ?? null,
      });
      const body =
        answer.body ??
        ({ sid: `SM${crypto.randomUUID().replace(/-/g, "")}`, status: "queued" } as const);
      return new Response(JSON.stringify(body), { status: answer.status });
    },
  };
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
const NEXT_WEEK = new Date(NOW.getTime() + 7 * 86_400_000);

async function rows(accountId: string) {
  return db.select().from(weeklySummaries).where(eq(weeklySummaries.account_id, accountId));
}

describe("P6-07 — rule 19: no send without a live yes", () => {
  it("WhatsApp chosen but no opt-in: not configured, nothing claimed, Twilio untouched", async () => {
    const b = await business({ channel: "whatsapp" });
    const twilio = fakeTwilio();
    const email = fakeSender();
    const run = await runWeeklySummaries(NOW, {
      accountIds: [b.account_id],
      origin: ORIGIN,
      send: email.send,
      twilioFetch: twilio.fetch,
    });
    expect(run).toMatchObject({ sent: 0, not_configured: 1 });
    expect(twilio.calls).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(await rows(b.account_id)).toHaveLength(0);
  });

  it("with the yes: one WhatsApp message, its SID on the claimed row, no email", async () => {
    const b = await business({ channel: "whatsapp" });
    const optin = await yes(b);
    const twilio = fakeTwilio();
    const email = fakeSender();
    const scope = {
      accountIds: [b.account_id],
      origin: ORIGIN,
      send: email.send,
      twilioFetch: twilio.fetch,
    };
    expect(await runWeeklySummaries(NOW, scope)).toMatchObject({ sent: 1 });
    expect(await runWeeklySummaries(NOW, scope)).toMatchObject({ sent: 0, already_sent: 1 });
    expect(twilio.calls).toHaveLength(1);
    expect(email.sent).toHaveLength(0);

    const call = twilio.calls[0]!;
    expect(call.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    );
    expect(call.auth).toMatch(/^Basic /);
    expect(call.form.get("To")).toBe(`whatsapp:${optin.phone}`);
    expect(call.form.get("From")).toBe("whatsapp:+447700900001");
    expect(call.form.get("ContentSid")).toBe(EN_SID);
    const vars = JSON.parse(call.form.get("ContentVariables")!) as Record<string, string>;
    expect(Object.keys(vars).sort()).toEqual(["1", "2", "3", "4"]);
    expect(variableProblems(vars as never)).toEqual([]);
    expect(vars["4"]).toBe(`${ORIGIN}/watch`);

    const [row] = await rows(b.account_id);
    expect(row).toMatchObject({
      iso_week: isoWeek(NOW),
      status: null,
      provider_id: null,
      whatsapp_status: "sent",
      whatsapp_optin_id: optin.id,
    });
    expect(row?.whatsapp_sid).toMatch(/^SM[0-9a-f]{32}$/);
  });

  it("a withdrawn yes stops the next week's message", async () => {
    const b = await business({ channel: "whatsapp" });
    await yes(b);
    const twilio = fakeTwilio();
    const scope = { accountIds: [b.account_id], origin: ORIGIN, twilioFetch: twilio.fetch };
    expect(await runWeeklySummaries(NOW, scope)).toMatchObject({ sent: 1 });
    expect(await withdrawOptin(b.user_id, b.account_id)).toBe(true);
    expect(await withdrawOptin(b.user_id, b.account_id)).toBe(false); // idempotent
    expect(await runWeeklySummaries(NEXT_WEEK, scope)).toMatchObject({ not_configured: 1 });
    expect(twilio.calls).toHaveLength(1);
    expect(await rows(b.account_id)).toHaveLength(1);
  });

  it("with both chosen, a withdrawn yes leaves the email going on its own", async () => {
    const b = await business({ channel: "both" });
    await yes(b);
    await withdrawOptin(b.user_id, b.account_id);
    const twilio = fakeTwilio();
    const email = fakeSender();
    await runWeeklySummaries(NOW, {
      accountIds: [b.account_id],
      origin: ORIGIN,
      send: email.send,
      twilioFetch: twilio.fetch,
    });
    expect(email.sent).toHaveLength(1);
    expect(twilio.calls).toHaveLength(0);
    const [row] = await rows(b.account_id);
    expect(row).toMatchObject({ status: "sent", whatsapp_status: null, whatsapp_optin_id: null });
  });

  it("review 2026-11-08: a yes withdrawn while the week is being sent stops the message", async () => {
    const b = await business({ channel: "both" });
    await yes(b);
    const twilio = fakeTwilio();
    // The email goes first; the owner withdraws while it is on its way.
    const send = async (): Promise<OwnerEmailOutcome> => {
      await withdrawOptin(b.user_id, b.account_id);
      return { kind: "sent", provider_id: "re_withdrawn" };
    };
    await runWeeklySummaries(NOW, {
      accountIds: [b.account_id],
      origin: ORIGIN,
      send,
      twilioFetch: twilio.fetch,
    });
    expect(twilio.calls).toHaveLength(0);
    const [row] = await rows(b.account_id);
    expect(row).toMatchObject({ status: "sent", whatsapp_status: "refused", whatsapp_sid: null });
  });

  it("review 2026-11-08: a yes replaced by another number mid-run sends to neither", async () => {
    const b = await business({ channel: "both" });
    await yes(b);
    const twilio = fakeTwilio();
    const send = async (): Promise<OwnerEmailOutcome> => {
      await yes(b); // a new number: the old yes is withdrawn with it
      return { kind: "sent", provider_id: "re_replaced" };
    };
    await runWeeklySummaries(NOW, {
      accountIds: [b.account_id],
      origin: ORIGIN,
      send,
      twilioFetch: twilio.fetch,
    });
    expect(twilio.calls).toHaveLength(0);
    const [row] = await rows(b.account_id);
    expect(row).toMatchObject({ whatsapp_status: "refused" });
  });

  it("not configured on the server: the yes alone sends nothing and claims nothing", async () => {
    const b = await business({ channel: "whatsapp" });
    await yes(b);
    const keep = process.env.TWILIO_WHATSAPP_SUMMARY_TEMPLATES;
    delete process.env.TWILIO_WHATSAPP_SUMMARY_TEMPLATES;
    const twilio = fakeTwilio();
    try {
      const run = await runWeeklySummaries(NOW, {
        accountIds: [b.account_id],
        origin: ORIGIN,
        twilioFetch: twilio.fetch,
      });
      expect(run).toMatchObject({ not_configured: 1 });
    } finally {
      process.env.TWILIO_WHATSAPP_SUMMARY_TEMPLATES = keep;
    }
    expect(twilio.calls).toHaveLength(0);
    expect(await rows(b.account_id)).toHaveLength(0);
  });
});

describe("P6-07 — one claim a week, never retried", () => {
  it("both channels: one row, the email and the message each once", async () => {
    const b = await business({ channel: "both" });
    await yes(b);
    const twilio = fakeTwilio();
    const email = fakeSender();
    const scope = {
      accountIds: [b.account_id],
      origin: ORIGIN,
      send: email.send,
      twilioFetch: twilio.fetch,
    };
    expect(await runWeeklySummaries(NOW, scope)).toMatchObject({ sent: 1 });
    expect(await runWeeklySummaries(NOW, scope)).toMatchObject({ already_sent: 1 });
    // Two racing runs: still nothing more.
    await Promise.all([runWeeklySummaries(NOW, scope), runWeeklySummaries(NOW, scope)]);
    expect(email.sent).toHaveLength(1);
    expect(twilio.calls).toHaveLength(1);
    const all = await rows(b.account_id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "sent", provider_id: "re_1", whatsapp_status: "sent" });
  });

  it("a Twilio refusal is recorded with its code, counted, and never retried", async () => {
    const b = await business({ channel: "whatsapp" });
    await yes(b);
    const twilio = fakeTwilio({
      status: 400,
      body: { code: 63016, message: "outside the window", status: 400 },
    });
    const scope = { accountIds: [b.account_id], origin: ORIGIN, twilioFetch: twilio.fetch };
    expect(await runWeeklySummaries(NOW, scope)).toMatchObject({ sent: 0, failed: 1 });
    expect(await runWeeklySummaries(NOW, scope)).toMatchObject({ already_sent: 1 });
    expect(twilio.calls).toHaveLength(1);
    const [row] = await rows(b.account_id);
    expect(row).toMatchObject({
      whatsapp_status: "refused",
      whatsapp_sid: null,
      whatsapp_error_code: 63016,
    });
    expect(row?.settled_at).not.toBeNull();
  });

  it("a 5xx may have gone out: unknown, and never sent again", async () => {
    const b = await business({ channel: "whatsapp" });
    await yes(b);
    const twilio = fakeTwilio({ status: 503, body: {} });
    const scope = { accountIds: [b.account_id], origin: ORIGIN, twilioFetch: twilio.fetch };
    await runWeeklySummaries(NOW, scope);
    await runWeeklySummaries(NOW, scope);
    expect(twilio.calls).toHaveLength(1);
    expect((await rows(b.account_id))[0]?.whatsapp_status).toBe("unknown");
  });
});

describe("P6-07 — the owner's language", () => {
  it("a language with its own template uses it, in that language", async () => {
    const b = await business({ channel: "whatsapp", language: "de-DE" });
    await yes(b);
    const twilio = fakeTwilio();
    await runWeeklySummaries(NOW, {
      accountIds: [b.account_id],
      origin: ORIGIN,
      twilioFetch: twilio.fetch,
    });
    const form = twilio.calls[0]!.form;
    expect(form.get("ContentSid")).toBe(DE_SID);
    const vars = JSON.parse(form.get("ContentVariables")!) as Record<string, string>;
    expect(vars["1"]).toBe("Ihr Unternehmen");
  });

  it("a language without one falls back to English's template, and English words", async () => {
    const b = await business({ channel: "whatsapp", language: "fr-FR" });
    await yes(b);
    const twilio = fakeTwilio();
    await runWeeklySummaries(NOW, {
      accountIds: [b.account_id],
      origin: ORIGIN,
      twilioFetch: twilio.fetch,
    });
    const form = twilio.calls[0]!.form;
    expect(form.get("ContentSid")).toBe(EN_SID);
    const vars = JSON.parse(form.get("ContentVariables")!) as Record<string, string>;
    expect(vars["1"]).toBe("your business");
    expect(vars["3"]).toMatch(/^A quiet week/);
    expect(vars["3"]).not.toContain(DIGEST_SEPARATOR); // a quiet week is one sentence
  });
});

describe("P6-07 — the yes as a recorded fact, and erasable", () => {
  it("records the version, language and hash of the exact sentence shown", async () => {
    const b = await business();
    const o = await yes(b);
    const [row] = await db.select().from(whatsappOptins).where(eq(whatsappOptins.id, o.id));
    expect(row).toMatchObject({
      phone_number: o.phone,
      consent_version: "whatsapp-summary-v1",
      consent_locale: "en",
      consent_sha256: sha256Hex(await consentSentence("en")),
      withdrawn_at: null,
    });
  });

  it("refuses words other than the ones shown, and a number that isn't one", async () => {
    const b = await business();
    const base = { accountId: b.account_id, userId: b.user_id, locale: "en" as const };
    expect(await optIn({ ...base, number: number(), shown: "Send me anything" })).toEqual({
      ok: false,
      reason: "consent_mismatch",
    });
    expect(
      await optIn({ ...base, number: "07700 900", shown: await consentSentence("en") }),
    ).toEqual({ ok: false, reason: "invalid_number" });
    // The German sentence is the German screen's, not the English one.
    expect(
      await optIn({
        ...base,
        locale: "de-DE",
        number: number(),
        shown: await consentSentence("en"),
      }),
    ).toEqual({ ok: false, reason: "consent_mismatch" });
    expect(await liveOptin(b.user_id)).toBeNull();
  });

  it("a typed number is stored as E.164; a new yes withdraws the old one", async () => {
    const b = await business();
    const first = await optIn({
      accountId: b.account_id,
      userId: b.user_id,
      number: "+44 (0) 7700-900123",
      locale: "en",
      shown: await consentSentence("en"),
    });
    expect(first.ok && first.optin.phone_number).toBe("+447700900123");
    const second = await yes(b);
    expect((await liveOptin(b.user_id))?.id).toBe(second.id);
    const all = await db.select().from(whatsappOptins).where(eq(whatsappOptins.user_id, b.user_id));
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.withdrawn_at === null)).toHaveLength(1);
  });

  it("erasure forgets the number for good, keeps the record, and stops the sends", async () => {
    const b = await business({ channel: "whatsapp" });
    const o = await yes(b);
    expect(await eraseWhatsAppNumbers(b.user_id)).toBe(1);
    const [row] = await db.select().from(whatsappOptins).where(eq(whatsappOptins.id, o.id));
    expect(row?.phone_number).toBeNull();
    expect(row?.erased_at).not.toBeNull();
    expect(row?.withdrawn_at).not.toBeNull();
    expect(row?.consent_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await liveOptin(b.user_id)).toBeNull();
    const twilio = fakeTwilio();
    const run = await runWeeklySummaries(NOW, {
      accountIds: [b.account_id],
      origin: ORIGIN,
      twilioFetch: twilio.fetch,
    });
    expect(run).toMatchObject({ not_configured: 1 });
    expect(twilio.calls).toHaveLength(0);
  });
});

describe("P6-07 — removing a person takes their number with them (rule 22)", () => {
  it("removeMember erases the WhatsApp number they gave", async () => {
    const b = await business();
    const [m] = await db
      .insert(users)
      .values({
        account_id: b.account_id,
        email: `p607-m-${crypto.randomUUID()}@test.local`,
        display_name: "Manager",
        role: "manager",
      })
      .returning({ id: users.id });
    const o = await yes({ account_id: b.account_id, user_id: m!.id });
    await removeMember({
      accountId: b.account_id,
      profileId: b.profile_id,
      targetUserId: m!.id,
      byUserId: b.user_id,
    });
    const [row] = await db.select().from(whatsappOptins).where(eq(whatsappOptins.id, o.id));
    expect(row).toMatchObject({ phone_number: null });
    expect(row?.erased_at).not.toBeNull();
  });
});

describe("P6-07 — logs: ids and counts only, and a cost line per send (rule 34)", () => {
  it("never logs the number or the message's words; says the cost is unknown", async () => {
    const b = await business({ channel: "whatsapp" });
    const o = await yes(b);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const twilio = fakeTwilio();
    await runWeeklySummaries(NOW, {
      accountIds: [b.account_id],
      origin: ORIGIN,
      twilioFetch: twilio.fetch,
    });
    const vars = JSON.parse(twilio.calls[0]!.form.get("ContentVariables")!) as Record<
      string,
      string
    >;
    const all = lines.join("\n");
    expect(all).not.toContain(o.phone);
    expect(all).not.toContain(o.phone.slice(1));
    expect(all).not.toContain(vars["3"]);
    const parsed = lines.flatMap((l): Record<string, unknown>[] => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const cost = parsed.find((l) => l.event === "weekly_summary_whatsapp");
    expect(cost).toMatchObject({
      workload: "weekly_summary_whatsapp",
      provider: "twilio",
      account_id: b.account_id,
      outcome: "sent",
      cost: null,
      cost_known: false,
    });
  });
});
