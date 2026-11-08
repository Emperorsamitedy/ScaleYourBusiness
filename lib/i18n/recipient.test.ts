// L-6 of TASKS-LANGUAGES.md — what SYB sends or hands over, in whose
// language. Held here, against the database with fakes only (no network,
// no real email, no real push):
//   · a message to a person is in their language only while it is open to
//     them: a German reviewer reads German, a person who chose German but
//     isn't a named reviewer reads English (rule 6);
//   · a sign-in link asked for before any account holds a language uses the
//     language the link carries;
//   · the business's customers read the business's language — the
//     unsubscribe page, the campaign footer — a review language only while
//     the business is under review;
//   · English stays word for word what it was.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  campaignSends,
  executions,
  modeDecisions,
  proposals,
  users,
  weeklySummaries,
} from "../../db/schema";
import type { OwnerEmail, OwnerEmailOutcome } from "../auth/email";
import { inviteEmailContent, loginEmailContent, sendLoginEmail } from "../auth/email";
import { complianceFooter } from "../crm/campaign-draft";
import { bootstrapIntake } from "../intake/service";
import { toCsv as moneyCsv, CURRENT_COLUMNS } from "../profile/money-export";
import { createProposal } from "../proposals/service";
import { flushPushes } from "../push/flush";
import { pushWords } from "../push/plan";
import { fakePushService } from "../push/send";
import { business as pushBusiness, cleanup as pushCleanup, device } from "../push/test-fixtures";
import { composeSummary, forecastsLine } from "../summary/compose";
import type { SummaryInput } from "../summary/compose";
import { runWeeklySummaries } from "../summary/run";
import { summaryWindow } from "../summary/week";
import { tokenHash } from "../unsubscribe/unsubscribe";
import { toCsv as ledgerCsv } from "../../components/trust/ledger";
import { addressLocale } from "./people";
import { customerLocale, englishWords, personLocale, wordsFor } from "./recipient";

// These hold the review gate itself. All six languages went live on
// 2026-11-08 (the owner's override), so the gate is tested the way the
// owner would use it: with LANGUAGES_IN_REVIEW sending them back.
const IN_REVIEW = "es-ES,de-DE,fr-FR,hu-HU,ru-RU,zh-Hans";
beforeAll(() => {
  process.env.LANGUAGES_IN_REVIEW = IN_REVIEW;
});
afterAll(() => {
  delete process.env.LANGUAGES_IN_REVIEW;
});

process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const REVIEW = process.env.LANGUAGE_REVIEW_ACCOUNTS;
afterEach(() => {
  if (REVIEW === undefined) delete process.env.LANGUAGE_REVIEW_ACCOUNTS;
  else process.env.LANGUAGE_REVIEW_ACCOUNTS = REVIEW;
  vi.unstubAllGlobals();
});

const created: { account_id: string; profile_id: string }[] = [];
afterAll(async () => {
  await pushCleanup();
  const ids = created.map((c) => c.profile_id);
  const accountIds = created.map((c) => c.account_id);
  if (ids.length === 0) return;
  await db.delete(weeklySummaries).where(inArray(weeklySummaries.account_id, accountIds));
  await db.delete(campaignSends).where(inArray(campaignSends.profile_id, ids));
  await db.delete(executions).where(inArray(executions.profile_id, ids));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

/** A business in care, with an owner who chose `language`. */
async function ownedBusiness(language: string | null, businessLanguage = "en") {
  const s = await bootstrapIntake();
  created.push(s);
  const email = `l6-${crypto.randomUUID()}@test.local`;
  const [u] = await db
    .insert(users)
    .values({ account_id: s.account_id, email, display_name: "L-6 owner", role: "owner", language })
    .returning({ id: users.id });
  await db
    .update(businessProfiles)
    .set({ language: businessLanguage })
    .where(eq(businessProfiles.id, s.profile_id));
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: "watching",
    watch_weeks: 6,
    inputs: { reasons: [] },
    reasoning: "test",
    confidence: "0.750",
    review_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  return { ...s, email, user_id: u!.id };
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

describe("L-6 — the gate, pure", () => {
  it("a person's language only while it is open to them", () => {
    const who = { email: "Rev@Example.test", account_id: "acc-1" };
    expect(personLocale("de-DE", who, "rev@example.test")).toBe("de-DE");
    expect(personLocale("de-DE", who, "acc-1")).toBe("de-DE");
    expect(personLocale("de-DE", who, "someone@else.test")).toBe("en");
    expect(personLocale("de-DE", who, "")).toBe("en");
    expect(personLocale("xx", who, "rev@example.test")).toBe("en");
    expect(personLocale(null, who, "rev@example.test")).toBe("en");
  });

  it("the business's customers: a review language only while the business is under review", () => {
    const biz = { account_id: "acc-2", owner_email: "owner@shop.test" };
    expect(customerLocale("fr-FR", biz, "owner@shop.test")).toBe("fr-FR");
    expect(customerLocale("fr-FR", biz, "acc-2")).toBe("fr-FR");
    expect(customerLocale("fr-FR", biz, "")).toBe("en");
    expect(customerLocale("fr-FR", { ...biz, owner_email: null }, "owner@shop.test")).toBe("en");
  });
});

describe("L-6 — the weekly summary", () => {
  const input = (over: Partial<SummaryInput> = {}): SummaryInput => ({
    business: "Hair & Co",
    window: summaryWindow(new Date("2026-10-26T06:00:00Z")),
    origin: "https://app.example",
    stop_url: "https://app.example/summary/stop/token",
    activity: [],
    executed: [],
    pending: [{ summary: "Raise the cut price" }, { summary: null }],
    open_tickets: 1,
    readbacks: [
      {
        summary: "Raise the cut price",
        verdict: "helped",
        judged_on: "revenue",
        currency: "EUR",
        before_minor: 110000,
        after_minor: 124000,
        delta_pct: 12.7,
      },
    ],
    provider_labels: {},
    ...over,
  });

  it("in German: the frame, the dates, money and percent in German; content as recorded", async () => {
    const de = await wordsFor("de-DE", "emails.summary");
    const c = composeSummary(input(), de);
    expect(c.subject).toBe(de.t("subjectWaiting", { count: 3 }));
    expect(c.subject).not.toMatch(/waiting for you/);
    expect(c.heading).toContain("Hair & Co");
    expect(c.period).toBe("19.–26. Okt. 2026");
    expect(c.text).toMatch(/1\.240,00\s€/);
    expect(c.text).toMatch(/\+12,7\s%/);
    expect(c.text).toContain("Raise the cut price"); // a proposal's own words, as recorded
    expect(c.text).toContain(`— ${de.t("aProposal")}`);
    expect(c.html).toContain('<html lang="de-DE">');
    expect(c.html).toContain('href="https://app.example/summary/stop/token"');
    for (const english of ["Nothing runs until you approve it", "WAITING FOR YOU", "measured"]) {
      expect(c.text).not.toContain(english);
    }
  });

  it("English is unchanged by the words parameter", () => {
    const c = composeSummary(input(), englishWords("emails.summary"));
    expect(c).toEqual(composeSummary(input()));
    expect(c.subject).toBe("Your week with SYB: 3 waiting for you");
    expect(c.text).toContain("— A proposal");
    expect(c.html).toContain('<html lang="en">');
  });

  it("Russian forecasts use each plural form", async () => {
    const ru = await wordsFor("ru-RU", "emails.summary");
    const one = forecastsLine({ inside: 1, above: 0, below: 0, cant_tell: 0 }, ru)!;
    const few = forecastsLine({ inside: 3, above: 0, below: 0, cant_tell: 0 }, ru)!;
    const many = forecastsLine({ inside: 5, above: 0, below: 0, cant_tell: 0 }, ru)!;
    expect(new Set([one, few, many]).size).toBe(3);
    expect(one).not.toMatch(/[A-Za-z]{3}/);
  });

  it("sent to a German reviewer: German; to someone who chose German but isn't a reviewer: English", async () => {
    const reviewer = await ownedBusiness("de-DE");
    const other = await ownedBusiness("de-DE");
    process.env.LANGUAGE_REVIEW_ACCOUNTS = reviewer.email;
    const fake = fakeSender();
    const out = await runWeeklySummaries(new Date(), {
      accountIds: [reviewer.account_id, other.account_id],
      send: fake.send,
      origin: "https://app.example",
    });
    expect(out.sent).toBe(2);
    const de = await wordsFor("de-DE", "emails.summary");
    const toReviewer = fake.sent.find((m) => m.to === reviewer.email)!;
    const toOther = fake.sent.find((m) => m.to === other.email)!;
    expect(toReviewer.subject).toBe(de.t("subjectQuiet"));
    expect(toReviewer.text).toContain(de.t("quiet"));
    expect(toOther.subject).toBe("Your week with SYB: a quiet one");
    expect(toOther.html).toContain('<html lang="en">');
  });
});

describe("L-6 — phone alerts", () => {
  it("each device gets the alert in its person's language, through the gate", async () => {
    const b = await pushBusiness();
    await db.update(users).set({ language: "de-DE" }).where(eq(users.id, b.user_id));
    const [owner] = await db.select().from(users).where(eq(users.id, b.user_id));
    await device(b);
    const draft = {
      profile_id: b.profile_id,
      module: "diagnosis",
      action: { kind: "price_increase", summary: "Raise the espresso for Anna Kovács" },
      scenario: {
        assumptions: [],
        base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
        downside_case: {
          case: "downside",
          statement: "t",
          profit_delta_monthly: null,
          formula: null,
        },
        upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
        breakeven_condition: "none — test fixture",
      },
      reversibility: { level: "easy" as const, if_you_change_your_mind: "change it back" },
      expires_at: "2027-01-31T00:00:00.000Z",
    } as const;
    const morning = new Date("2026-11-10T09:00:00Z");

    process.env.LANGUAGE_REVIEW_ACCOUNTS = owner!.email;
    await createProposal(draft as never);
    const fake = fakePushService();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await flushPushes(b.profile_id, { service: fake, now: morning });
    const de = await wordsFor("de-DE", "push");
    expect(fake.sent.map((s) => s.payload.body)).toEqual([
      de.t("one", { count: 1, what: de.t("kinds.price_increase") }),
    ]);
    expect(fake.sent[0]!.payload.body).not.toContain("Anna");

    // Not a reviewer any more: the next alert (next day) is English.
    process.env.LANGUAGE_REVIEW_ACCOUNTS = "";
    await createProposal(draft as never);
    await flushPushes(b.profile_id, { service: fake, now: new Date("2026-11-11T09:00:00Z") });
    expect(fake.sent.at(-1)!.payload.body).toBe("1 thing waits for your yes: a price change");
    vi.restoreAllMocks();
  });

  it("English words are as before", () => {
    const item = { proposal_id: "p", status: "pending", kind: null, expires_at: "2027-01-01" };
    expect(pushWords([item]).body).toBe("1 thing waits for your yes: a proposal");
    expect(pushWords([item, { ...item, proposal_id: "q" }]).body).toBe(
      "2 things wait for your yes",
    );
  });
});

describe("L-6 — sign-in and invite emails", () => {
  it("German words for a German reader; English exactly as before", async () => {
    const de = loginEmailContent("https://x.test/l", await wordsFor("de-DE", "emails.signIn"));
    expect(de.subject).not.toBe("Your sign-in link — SYB");
    expect(de.text).toContain("https://x.test/l");
    expect(de.text).not.toMatch(/expires in/);
    expect(loginEmailContent("https://x.test/l")).toEqual({
      subject: "Your sign-in link — SYB",
      text:
        "Click to sign in to SYB:\n\nhttps://x.test/l\n\nThe link works once and expires in 15 minutes. " +
        "If you didn't ask for it, ignore this email — nothing happens without the link.",
    });
    const invite = {
      to: "a@b.test",
      link: "https://x.test/i",
      business: "Emberworks",
      role: "manager" as const,
    };
    expect(inviteEmailContent(invite).text).toBe(
      "You've been invited to join Emberworks on SYB as a manager.\n\nOpen this link to accept:\n\nhttps://x.test/i\n\n" +
        "It works once and expires in 7 days. You'll sign in with this address, a@b.test. " +
        "If you weren't expecting it, ignore this email — nothing happens without you.",
    );
    expect(inviteEmailContent({ ...invite, business: null, role: "owner" }).subject).toBe(
      "You're invited to a business on SYB",
    );
    const fr = inviteEmailContent(invite, await wordsFor("fr-FR", "emails.invite"));
    expect(fr.subject).toContain("Emberworks");
    expect(fr.text).not.toMatch(/invited|expires/);
  });

  it("a link asked for before any account: the link's language, through the gate", async () => {
    const fresh = `l6-new-${crypto.randomUUID()}@test.local`;
    process.env.LANGUAGE_REVIEW_ACCOUNTS = fresh;
    expect(await addressLocale(fresh, "hu-HU")).toBe("hu-HU");
    process.env.LANGUAGE_REVIEW_ACCOUNTS = "";
    expect(await addressLocale(fresh, "hu-HU")).toBe("en");
    // With an account that holds a language, theirs wins over the link's.
    const b = await ownedBusiness("es-ES");
    process.env.LANGUAGE_REVIEW_ACCOUNTS = b.account_id;
    expect(await addressLocale(b.email, "hu-HU")).toBe("es-ES");
  });

  it("the email that goes out (a stubbed Resend) is in that language", async () => {
    const calls: { body: string }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push({ body: String(init.body) });
      return new Response(JSON.stringify({ id: "re_test" }), { status: 200 });
    });
    const key = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "test-not-a-key";
    try {
      await sendLoginEmail({ to: "a@b.test", link: "https://x.test/l", locale: "de-DE" });
    } finally {
      if (key === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = key;
    }
    const sent = JSON.parse(calls[0]!.body) as { subject: string; text: string };
    const de = await wordsFor("de-DE", "emails.signIn");
    expect(sent.subject).toBe(de.t("subject"));
  });
});

describe("L-6 — the business's customers", () => {
  async function sentRow(language: string) {
    const b = await ownedBusiness(null, language);
    const p = await createProposal({
      profile_id: b.profile_id,
      module: "crm",
      action: { kind: "customer_email", summary: "test" },
      scenario: {} as never,
      reversibility: { level: "hard", if_you_change_your_mind: "can't be recalled" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const [run] = await db
      .insert(executions)
      .values({
        proposal_id: p.id,
        profile_id: b.profile_id,
        account_id: b.account_id,
        provider: "email_campaign",
        op: "send_campaign",
        status: "succeeded",
      })
      .returning();
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const id = crypto.randomUUID();
    await db.insert(campaignSends).values({
      id,
      proposal_id: p.id,
      execution_id: run!.id,
      profile_id: b.profile_id,
      account_id: b.account_id,
      contact_id: null,
      email_hash: `h1:${"cd".repeat(32)}`,
      status: "sent",
      idempotency_key: `syb-campaign-${id}`,
      unsubscribe_token_hash: tokenHash(token),
      sender_name: "Emberworks",
      claimed_at: new Date().toISOString(),
      sent_at: new Date().toISOString(),
    });
    return { ...b, token };
  }

  const page = async (token: string) => {
    const { default: UnsubscribePage } = await import("../../app/u/[token]/page");
    return renderToStaticMarkup(await UnsubscribePage({ params: Promise.resolve({ token }) }));
  };

  it("the unsubscribe page speaks the business's language while it is under review", async () => {
    const r = await sentRow("fr-FR");
    const fr = await wordsFor("fr-FR", "unsubscribe");
    process.env.LANGUAGE_REVIEW_ACCOUNTS = r.email;
    const html = await page(r.token);
    expect(html).toContain('lang="fr-FR"');
    expect(html).toContain(fr.t("campaign.button"));
    expect(html).toContain("Emberworks");
    expect(html).not.toContain("Stop marketing email");

    process.env.LANGUAGE_REVIEW_ACCOUNTS = "";
    const english = await page(r.token);
    expect(english).toContain("Stop marketing email from Emberworks?");
    expect(english).toContain('lang="en"');
  });

  it("the campaign footer in the business's language; English as before", async () => {
    const es = complianceFooter("Emberworks", null, await wordsFor("es-ES", "emails.campaign"));
    expect(es).toContain("{{unsubscribe_url}}");
    expect(es).not.toContain("You're getting this");
    expect(complianceFooter(null, null)).toBe(
      "—\nThis business\nYou're getting this because you agreed to hear from This business. Unsubscribe: {{unsubscribe_url}}",
    );
  });
});

describe("L-6 — exports: headings in the reader's language, cells machine-readable", () => {
  it("the accountant export and the history CSV", async () => {
    const de = await wordsFor("de-DE", "exports.money");
    const row = {
      field: "revenue.monthly_revenue",
      label: "",
      amount: "4990.00",
      currency: "EUR",
      status: "answered",
      source: "owner",
      source_detail: "",
      confidence: "high",
      observed_at: "2026-10-01T00:00:00.000Z",
      recorded_at: "2026-10-01T00:00:00.000Z",
      derived_from: "",
      formula: "",
    };
    const csv = moneyCsv(CURRENT_COLUMNS, [row], (c) => de.t(c));
    const [head, line] = csv.slice(1).split("\r\n");
    expect(head).not.toBe(CURRENT_COLUMNS.join(","));
    expect(head!.split(",")).toHaveLength(CURRENT_COLUMNS.length);
    expect(line).toBe(
      "revenue.monthly_revenue,,4990.00,EUR,answered,owner,,high,2026-10-01T00:00:00.000Z,2026-10-01T00:00:00.000Z,,",
    );
    expect(moneyCsv(["field", "amount"], [row])).toBe(
      "﻿field,amount\r\nrevenue.monthly_revenue,4990.00\r\n",
    );
    const zh = await wordsFor("zh-Hans", "exports.history");
    expect(ledgerCsv([], (c) => zh.t(c))).not.toContain("when");
    expect(ledgerCsv([])).toBe("when,kind,entry,reference,detail,by,note");
  });
});
