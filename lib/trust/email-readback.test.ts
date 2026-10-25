// P4-17 — per-campaign readback into the trust layer, against the database,
// a fake Resend, and recorded-shape Resend delivery events. The global fetch
// is stubbed to fail if touched: nothing here reaches the network.
//
// THE DONE-WHEN, as one test: a campaign is sent through the engine, one
// recipient unsubscribes, a later shop export shows who came back — and the
// verdict lands on the scorecard like every other proposal's.
//
// Then: the verdict arithmetic at every boundary, both ways; too_early with
// no import; the webhook's signature and idempotency (a redelivered event
// counts once); a spam complaint suppressing for good so the next campaign
// skips the address; an erased recipient's later events dropped with no
// PII; the import refreshing purchase history without moving consent; and
// the comparison group snapshotted when the send begins.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  campaignComparisons,
  campaignSends,
  connections,
  contactSuppressions,
  contacts,
  contentItems,
  decisionLog,
  executionAttempts,
  executionHalts,
  executions,
  fieldRecords,
  intakeEvents,
  modeDecisions,
  proposals,
  users,
} from "../../db/schema";
import type { DraftLlm } from "../content/draft";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { draftCampaign } from "../crm/campaign-draft";
import {
  applyDeliveryEvent,
  bounceCode,
  parseDeliveryEvent,
  sendIdTag,
} from "../crm/campaign-events";
import { approveCampaignEmail, dbCampaignBackend, sendCampaignNow } from "../crm/campaign-send";
import { campaignReviewVerdict } from "../crm/campaign-review";
import type { ConsentStatus } from "../crm/contacts";
import { addContact, eraseContact } from "../crm/contacts";
import { importContacts } from "../crm/import";
import type { LawReviewVerdict } from "../crm/law-review";
import { jurisdictionTableHash, lawReviewVerdict } from "../crm/law-review";
import { deliveryEvent } from "../crm/resend-event-fixtures";
import { proposeFromSegments } from "../crm/segment-proposals";
import { consentToCampaignEmail } from "../execution/email-consent";
import type { MailFetch } from "../execution/providers/email-campaign";
import { createEmailCampaignExecutor, sha256 } from "../execution/providers/email-campaign";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal, createProposal } from "../proposals/service";
import { signWebhook } from "../support/inbound";
import { unsubscribe } from "../unsubscribe/unsubscribe";
import type { DeliveryTally, GroupTally, Person } from "./email-readback";
import {
  EMAIL_READBACK,
  campaignKind,
  emailCampaignOutcome,
  harmBackfired,
  judgeEmailCampaign,
  tallyGroup,
} from "./email-readback";
import { judgedOn } from "./readback";
import { buildTrustView } from "./scorecard";

const DAY = 86_400_000;
const SEND = "2026-09-01T10:00:00.000Z";
const after = (days: number, ms = 0) => new Date(Date.parse(SEND) + days * DAY + ms).toISOString();

/* ── pure: the groups ── */

describe("P4-17 — who bought again, at the boundaries", () => {
  const p = (over: Partial<Person>): Person => ({
    ref_at: SEND,
    last_purchase_at: null,
    refreshed_at: after(14),
    erased: false,
    ...over,
  });

  it("an export exactly the wait after the email measures; a millisecond sooner waits", () => {
    expect(tallyGroup([p({ refreshed_at: after(14) })], 14)).toMatchObject({
      measured: 1,
      waiting: 0,
    });
    expect(tallyGroup([p({ refreshed_at: after(14, -1) })], 14)).toMatchObject({
      measured: 0,
      waiting: 1,
    });
    expect(tallyGroup([p({ refreshed_at: null })], 14)).toMatchObject({ measured: 0, waiting: 1 });
  });

  it("a purchase counts from the day after the email; the send day itself doesn't", () => {
    expect(tallyGroup([p({ last_purchase_at: "2026-09-02T00:00:00.000Z" })], 14).returned).toBe(1);
    expect(tallyGroup([p({ last_purchase_at: "2026-09-01T00:00:00.000Z" })], 14).returned).toBe(0);
    expect(tallyGroup([p({ last_purchase_at: "2025-01-01T00:00:00.000Z" })], 14).returned).toBe(0);
  });

  it("an erased person is counted as erased, never measured", () => {
    const t = tallyGroup([p({ erased: true, last_purchase_at: after(3) }), p({})], 14);
    expect(t).toMatchObject({ size: 2, erased: 1, measured: 1, returned: 0, waiting: 0 });
  });

  it("each campaign waits by its own scenario: a thank-you longer than a win-back", () => {
    expect(EMAIL_READBACK.min_days_after.vip).toBeGreaterThan(
      EMAIL_READBACK.min_days_after.winback,
    );
    const twenty = [p({ refreshed_at: after(20) })];
    expect(tallyGroup(twenty, EMAIL_READBACK.min_days_after.winback).measured).toBe(1);
    expect(tallyGroup(twenty, EMAIL_READBACK.min_days_after.vip).measured).toBe(0);
    expect(campaignKind({ detail: { segment: "vip" } })).toBe("vip");
    expect(campaignKind({ detail: { segment: "lapsed" } })).toBe("winback");
  });

  it("judgedOn: a crm customer_email proposal is judged as an email", () => {
    expect(judgedOn({ module: "crm", action: { kind: "customer_email" } })).toBe("email");
    expect(judgedOn({ module: "crm", action: { kind: "support_knowledge" } })).toBe("revenue");
  });
});

/* ── pure: the verdict ── */

const delivery = (over: Partial<DeliveryTally> = {}): DeliveryTally => ({
  sent: 100,
  unknown: 0,
  delivered: 100,
  bounced: 0,
  complained: 0,
  unsubscribed: 0,
  harmed: 0,
  ...over,
});
const group = (measured: number, returned: number, waiting = 0, erased = 0): GroupTally => ({
  size: measured + waiting + erased,
  erased,
  measured,
  returned,
  waiting,
  measured_through: measured > 0 ? after(20) : null,
});
const judge = (d: DeliveryTally, r: GroupTally, c: GroupTally) =>
  judgeEmailCampaign({
    kind: "winback",
    delivery: d,
    recipients: r,
    comparison: c,
    sent_on: "2026-09-01",
  });

describe("P4-17 — the verdict arithmetic, every boundary both ways", () => {
  it("harm: unsubscribes + complaints at exactly 2% with two people backfires; just under doesn't", () => {
    expect(harmBackfired(delivery({ sent: 100, harmed: 2, unsubscribed: 2 }))).toBe("harm");
    expect(harmBackfired(delivery({ sent: 101, harmed: 2, unsubscribed: 2 }))).toBeNull();
    // One person is never "harm", whatever the rate.
    expect(harmBackfired(delivery({ sent: 10, harmed: 1, unsubscribed: 1 }))).toBeNull();
  });

  it("complaints: one at exactly 0.3% backfires; one at just under doesn't; none never does", () => {
    expect(harmBackfired(delivery({ sent: 1000, complained: 3, harmed: 3 }))).toBe("complaints");
    expect(harmBackfired(delivery({ sent: 1001, complained: 3, harmed: 3 }))).toBeNull();
    expect(harmBackfired(delivery({ sent: 333, complained: 1, harmed: 1 }))).toBe("complaints");
    expect(harmBackfired(delivery({ sent: 334, complained: 1, harmed: 1 }))).toBeNull();
    expect(harmBackfired(delivery({ sent: 1, complained: 0 }))).toBeNull();
  });

  it("harm backfires before any import, with the arithmetic in it", () => {
    const j = judge(
      delivery({ sent: 50, harmed: 3, unsubscribed: 3 }),
      group(0, 0, 50),
      group(0, 0),
    );
    expect(j.verdict).toBe("backfired");
    expect(j.arithmetic).toContain("3 recipients unsubscribed or marked it as spam");
    expect(j.arithmetic).toContain("6.0%");
  });

  it("controlled lift: exactly +5 points helps, +4 does nothing; exactly −5 backfires, −4 does nothing", () => {
    expect(judge(delivery(), group(100, 30), group(100, 25)).verdict).toBe("helped");
    expect(judge(delivery(), group(100, 30), group(100, 26)).verdict).toBe("did_nothing");
    expect(judge(delivery(), group(100, 20), group(100, 25)).verdict).toBe("backfired");
    expect(judge(delivery(), group(100, 21), group(100, 25)).verdict).toBe("did_nothing");
    // Unequal groups land exactly too: 6/20 = 30% against 25/100 = 25%.
    const j = judge(delivery(), group(20, 6), group(100, 25));
    expect(j).toMatchObject({ verdict: "helped", lift_pp: 5, controlled: true });
    expect(j.arithmetic).toContain("not randomised");
  });

  it("too_early with no import since the send, said plainly", () => {
    const j = judge(delivery({ sent: 40 }), group(0, 0, 40), group(0, 0, 30));
    expect(j.verdict).toBe("too_early");
    expect(j.arithmetic).toContain("no customer export covering them has come in at least 14 days");
  });

  it("recipients: exactly the minimum measured is judged; one fewer waits — or can never be judged", () => {
    expect(judge(delivery(), group(5, 3), group(5, 0)).verdict).toBe("helped");
    expect(judge(delivery(), group(4, 3, 1), group(5, 0)).verdict).toBe("too_early");
    expect(judge(delivery({ sent: 4 }), group(4, 3), group(5, 0)).verdict).toBe("unmeasured");
  });

  it("uncontrolled: a lift alone is never 'helped'; nobody returning is 'did nothing'", () => {
    // Four comparison customers measured, none waiting: no comparison, ever.
    const lift = judge(delivery(), group(20, 8), group(4, 0));
    expect(lift.verdict).toBe("unmeasured");
    expect(lift.arithmetic).toContain('a lift alone is never "helped"');
    expect(judge(delivery(), group(20, 0), group(4, 0)).verdict).toBe("did_nothing");
    // The comparison could still be measured by the next export: wait for it.
    expect(judge(delivery(), group(20, 8), group(4, 0, 1)).verdict).toBe("too_early");
    // Exactly the minimum comparison counts as controlled.
    expect(judge(delivery(), group(20, 8), group(5, 0)).controlled).toBe(true);
  });

  it("nothing sent is unmeasured", () => {
    expect(judge(delivery({ sent: 0 }), group(0, 0), group(0, 0)).verdict).toBe("unmeasured");
  });
});

/* ── pure: the events ── */

describe("P4-17 — Resend's delivery events, read defensively", () => {
  it("reads the four kept kinds, and drops opens, clicks and anything malformed", () => {
    const at = "2026-10-19T08:00:00.000Z";
    expect(parseDeliveryEvent(deliveryEvent("email.delivered", "e-1", { at }))).toEqual({
      kind: "delivered",
      email_id: "e-1",
      at,
      bounce: null,
      send_id: null,
    });
    // Review #14: the send-row tag, either shape Resend uses, uuids only.
    const sid = "0B6F3A52-6A1E-4C55-9D8E-2F0A1C3B4D5E";
    expect(
      parseDeliveryEvent(deliveryEvent("email.complained", "e-1", { sendId: sid }))?.send_id,
    ).toBe(sid.toLowerCase());
    expect(sendIdTag([{ name: "syb_send", value: sid }])).toBe(sid.toLowerCase());
    expect(sendIdTag({ syb_send: "not-a-uuid" })).toBeNull();
    expect(sendIdTag({ other: sid })).toBeNull();
    expect(sendIdTag("syb_send")).toBeNull();
    expect(parseDeliveryEvent(deliveryEvent("email.bounced", "e-1"))?.bounce).toBe("permanent");
    expect(
      parseDeliveryEvent(deliveryEvent("email.bounced", "e-1", { bounceType: "Temporary" }))
        ?.bounce,
    ).toBe("temporary");
    expect(parseDeliveryEvent(deliveryEvent("email.suppressed", "e-1"))?.bounce).toBe("suppressed");
    expect(parseDeliveryEvent(deliveryEvent("email.complained", "e-1"))?.kind).toBe("complained");
    expect(parseDeliveryEvent(deliveryEvent("email.opened", "e-1"))).toBeNull();
    expect(parseDeliveryEvent(deliveryEvent("email.clicked", "e-1"))).toBeNull();
    expect(parseDeliveryEvent({ type: "email.delivered", data: { email_id: "../x" } })).toBeNull();
    expect(parseDeliveryEvent({ type: "email.delivered" })).toBeNull();
    expect(parseDeliveryEvent(null)).toBeNull();
    expect(bounceCode("Undetermined")).toBe("other");
    expect(bounceCode(undefined)).toBe("other");
  });
});

/* ── against the database ── */

const created: { account_id: string; profile_id: string }[] = [];
const SECRET = `whsec_${Buffer.from("p4-17-events-secret").toString("base64")}`;
const CURRENT: LawReviewVerdict = lawReviewVerdict(
  { table_sha256: jurisdictionTableHash(), reviewed_on: "2026-10-18" },
  jurisdictionTableHash(),
);
const ENV_KEYS = [
  "SESSION_D_REAL_WRITES",
  "RESEND_API_KEY",
  "APP_URL",
  "EMAIL_FROM",
  "RESEND_EVENTS_WEBHOOK_SECRET",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.SESSION_D_REAL_WRITES = "on";
  process.env.RESEND_API_KEY = "re_test_campaigns";
  process.env.APP_URL = "https://syb.test";
  process.env.EMAIL_FROM = "SYB <hello@send.syb.test>";
  process.env.RESEND_EVENTS_WEBHOOK_SECRET = SECRET;
  vi.stubGlobal("fetch", async () => {
    throw new Error("the network was touched");
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  await db.delete(campaignComparisons).where(inArray(campaignComparisons.profile_id, ids));
  await db.delete(campaignSends).where(inArray(campaignSends.profile_id, ids));
  const runs = await db
    .select({ id: executions.id })
    .from(executions)
    .where(inArray(executions.profile_id, ids));
  if (runs.length > 0) {
    await db.delete(executionAttempts).where(
      inArray(
        executionAttempts.execution_id,
        runs.map((r) => r.id),
      ),
    );
  }
  await db.delete(executions).where(inArray(executions.profile_id, ids));
  await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(contacts).where(inArray(contacts.account_id, accountIds));
  await db.delete(contactSuppressions).where(inArray(contactSuppressions.account_id, accountIds));
  await db.delete(connections).where(inArray(connections.account_id, accountIds));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(executionHalts).where(inArray(executionHalts.account_id, accountIds));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

async function owner(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

const limitsLlm: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });
const draftLlm: DraftLlm = async () => ({
  text: "It's been a while. The winter range is on the shelf this week, and we'd love to see you back.",
});

interface Business {
  account_id: string;
  profile_id: string;
  user_id: string;
  tag: string;
}

async function business(): Promise<Business> {
  const s = await bootstrapIntake();
  created.push(s);
  await owner(s.profile_id, "identity.legal_name", "Emberworks");
  await owner(s.profile_id, "legal.country", "Hungary");
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: "instant",
    watch_weeks: null,
    inputs: { reasons: ["test fixture"] },
    reasoning: "test fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 42 * DAY).toISOString(),
  });
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p4-17-${crypto.randomUUID()}@test.local`,
      display_name: "P4-17 owner",
      role: "owner",
    })
    .returning({ id: users.id });
  return { ...s, user_id: u!.id, tag: crypto.randomUUID().slice(0, 8) };
}

async function person(b: Business, label: string, status: ConsentStatus = "explicit_consent") {
  return addContact(b.account_id, {
    email: `${label}-${b.tag}@customers.test`,
    name: `${label} Person`,
    consent: { status, source: `test: ${label}` },
  });
}

async function connect(b: Business) {
  const live = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, b.account_id),
        eq(connections.provider, "email_campaign"),
        eq(connections.status, "connected"),
      ),
    );
  if (live.length === 0) {
    await consentToCampaignEmail({
      accountId: b.account_id,
      senderName: "Emberworks",
      replyTo: "hello@emberworks.test",
      confirmation: "allow campaign email",
    });
  }
}

/** Approve a campaign proposal, draft it, grant campaign email and approve the email itself. */
async function readyToSend(b: Business, proposalId: string) {
  await approveProposal({ proposalId, userId: b.user_id, profileId: b.profile_id });
  const { draft } = await draftCampaign(proposalId, { draftLlm, limitLlm: limitsLlm });
  await connect(b);
  await approveCampaignEmail({
    profileId: b.profile_id,
    proposalId,
    userId: b.user_id,
    subject: "A note from Emberworks",
    bodySha256: sha256(draft.body),
  });
}

/** A hand-made campaign proposal for these contact ids, ready to send. */
async function campaign(b: Business, contactIds: string[]) {
  const p = await createProposal({
    profile_id: b.profile_id,
    module: "crm",
    originating_finding: `crm:test:${crypto.randomUUID()}`,
    action: {
      kind: "customer_email",
      summary: `Win back ${contactIds.length} lapsed customers`,
      detail: { segment: "lapsed", label: "Lapsed customers", contact_ids: contactIds },
    },
    scenario: {} as never,
    reversibility: {
      level: "hard",
      if_you_change_your_mind: "Irreversible once sent: a sent email can't be recalled.",
    },
    expires_at: new Date(Date.now() + DAY).toISOString(),
  });
  await readyToSend(b, p.id);
  return p.id;
}

interface FakeCall {
  body: { to: string[]; text: string };
}

function fakeResend() {
  const calls: FakeCall[] = [];
  const fetchImpl: MailFetch = async (_url, init) => {
    calls.push({ body: JSON.parse(String(init.body)) as FakeCall["body"] });
    return new Response(JSON.stringify({ id: `re_${calls.length}_${crypto.randomUUID()}` }), {
      status: 200,
    });
  };
  return { calls, fetchImpl };
}

async function send(b: Business, proposalId: string, fake: { fetchImpl: MailFetch }) {
  return sendCampaignNow({
    profileId: b.profile_id,
    proposalId,
    provider: createEmailCampaignExecutor({
      fetch: fake.fetchImpl,
      sleep: async () => undefined,
      backend: dbCampaignBackend({
        lawReview: async () => CURRENT,
        campaignReview: async () => campaignReviewVerdict({ reviewed_on: "2026-10-20" }),
      }),
    }),
  });
}

async function sendsOf(proposalId: string) {
  return db.select().from(campaignSends).where(eq(campaignSends.proposal_id, proposalId));
}

const tokenIn = (text: string): string => /\/u\/([A-Za-z0-9_-]{43})/.exec(text)![1]!;

/** Deliver one signed webhook to the events route. */
async function deliver(body: unknown, opts: { sign?: boolean; svixId?: string } = {}) {
  const { POST } = await import("../../app/api/email/events/route");
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const id = opts.svixId ?? `msg_${crypto.randomUUID()}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": ts,
    "svix-signature": opts.sign === false ? "v1,bm9wZQ==" : signWebhook(raw, id, ts, SECRET),
  };
  return POST(
    new NextRequest("http://localhost/api/email/events", { method: "POST", body: raw, headers }),
  );
}

/** Move a sent campaign back in time, as if it went out `days` ago. */
async function backdate(proposalId: string, days: number) {
  const at = new Date(Date.now() - days * DAY).toISOString();
  await db
    .update(campaignSends)
    .set({ sent_at: at, created_at: at })
    .where(and(eq(campaignSends.proposal_id, proposalId), eq(campaignSends.status, "sent")));
  await db
    .update(campaignSends)
    .set({ created_at: at })
    .where(eq(campaignSends.proposal_id, proposalId));
  await db
    .update(campaignComparisons)
    .set({ snapshot_at: at })
    .where(eq(campaignComparisons.proposal_id, proposalId));
  await db
    .update(executions)
    .set({ finished_at: at })
    .where(eq(executions.proposal_id, proposalId));
}

const ymd = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);

describe("P4-17 — THE DONE-WHEN", () => {
  it("a sent campaign, a later export showing returns, an unsubscribe — and the verdict lands on the scorecard", async () => {
    const b = await business();
    // The shop export: ten lapsed customers who ticked "email me", ten who never did.
    const rows = (prefix: string) =>
      Array.from(
        { length: 10 },
        (_, i) => `${prefix}${i}-${b.tag}@customers.test,${prefix} ${i},2025-01-15,2`,
      );
    const header = "email,name,last order date,orders";
    await importContacts(b.account_id, [header, ...rows("yes")].join("\n"), {
      status: "explicit_consent",
      statement: "ticked 'email me news' at checkout",
    });
    await importContacts(b.account_id, [header, ...rows("no")].join("\n"), {
      status: "unsure",
      statement: "studio receipts, no newsletter box",
    });

    const proposed = await proposeFromSegments(b.profile_id, { limitLlm: limitsLlm });
    const winback = proposed.created.find(
      (p) => (p.action as { detail?: { segment?: string } }).detail?.segment === "lapsed",
    )!;
    expect(winback).toBeDefined();
    await readyToSend(b, winback.id);
    const fake = fakeResend();
    const run = await send(b, winback.id, fake);
    expect(run.result).toBe("sent");
    expect(fake.calls).toHaveLength(10);
    // The not-emailed half of the segment is the comparison, snapshotted as the send began.
    const comparison = await db
      .select()
      .from(campaignComparisons)
      .where(eq(campaignComparisons.proposal_id, winback.id));
    expect(comparison).toHaveLength(10);

    // One recipient unsubscribes (picked by address: send order is not row order), and
    // Resend reports deliveries.
    const toNine = fake.calls.find((c) => c.body.to[0] === `yes9-${b.tag}@customers.test`)!;
    await unsubscribe(tokenIn(toNine.body.text));
    for (const s of await sendsOf(winback.id)) {
      expect((await deliver(deliveryEvent("email.delivered", s.provider_message_id!))).status).toBe(
        200,
      );
    }

    // Right after the send: too early, and it says why.
    const early = await emailCampaignOutcome(winback);
    expect(early.verdict).toBe("too_early");
    expect(early.delivery).toMatchObject({ sent: 10, delivered: 10, unsubscribed: 1, harmed: 1 });

    // Twenty days on, the next shop export: four recipients came back, one of the others did.
    await backdate(winback.id, 20);
    const back = (prefix: string, i: number, returned: boolean) =>
      `${prefix}${i}-${b.tag}@customers.test,${prefix} ${i},${returned ? ymd(3) : "2025-01-15"},${returned ? 3 : 2}`;
    const later = [
      header,
      ...Array.from({ length: 10 }, (_, i) => back("yes", i, i < 4)),
      ...Array.from({ length: 10 }, (_, i) => back("no", i, i === 0)),
    ].join("\n");
    const refreshed = await importContacts(b.account_id, later, {
      status: "implied_consent",
      statement: "the October export",
    });
    // All twenty refreshed — the unsubscriber too: suppressed from email, still a customer.
    expect(refreshed.purchase.refreshed).toBe(20);
    expect(refreshed.skipped.suppressed).toBe(1);
    expect(refreshed.imported).toBe(0);

    const outcome = await emailCampaignOutcome(winback);
    expect(outcome.recipients).toMatchObject({ measured: 10, returned: 4 });
    expect(outcome.comparison).toMatchObject({ measured: 10, returned: 1 });
    expect(outcome).toMatchObject({ verdict: "helped", lift_pp: 30, controlled: true });

    const trust = await buildTrustView(b.profile_id);
    expect(trust.scorecard.outcomes.helped).toBe(1);
    const scored = trust.history.find((h) => h.proposal.id === winback.id)!;
    expect(scored.outcome).toMatchObject({ verdict: "helped", judged_on: "email" });
    expect(scored.outcome!.arithmetic).toContain("4 of 10 measured recipients (40.0%)");
    expect(scored.outcome!.predicted).toContain("Some of them come back");
  });
});

describe("P4-17 — the delivery webhook", () => {
  it("a bad signature is a 401 and nothing is recorded; no secret refuses everything (503)", async () => {
    const b = await business();
    const ann = await person(b, "ann");
    const pid = await campaign(b, [ann.id]);
    await send(b, pid, fakeResend());
    const [row] = await sendsOf(pid);
    const bad = await deliver(deliveryEvent("email.delivered", row!.provider_message_id!), {
      sign: false,
    });
    expect(bad.status).toBe(401);
    expect((await sendsOf(pid))[0]!.delivered_at).toBeNull();
    delete process.env.RESEND_EVENTS_WEBHOOK_SECRET;
    const off = await deliver(deliveryEvent("email.delivered", row!.provider_message_id!));
    expect(off.status).toBe(503);
    expect((await sendsOf(pid))[0]!.delivered_at).toBeNull();
  });

  it("a redelivered event is counted once; a bounce keeps a code, never the server's words; opens are dropped", async () => {
    const b = await business();
    const [ann, ben] = [await person(b, "ann"), await person(b, "ben")];
    const pid = await campaign(b, [ann.id, ben.id]);
    await send(b, pid, fakeResend());
    const rows = await sendsOf(pid);
    const annRow = rows.find((r) => r.contact_id === ann.id)!;
    const benRow = rows.find((r) => r.contact_id === ben.id)!;
    const event = deliveryEvent("email.delivered", annRow.provider_message_id!, {
      at: "2026-10-19T08:00:00.000Z",
    });
    const first = await deliver(event, { svixId: "msg_same" });
    const again = await deliver(event, { svixId: "msg_same" });
    const later = await deliver({ ...event, created_at: "2026-10-19T09:00:00.000Z" });
    for (const r of [first, again, later]) expect(r.status).toBe(200);
    const bounce = await deliver(
      deliveryEvent("email.bounced", benRow.provider_message_id!, {
        to: `ben-${b.tag}@customers.test`,
      }),
    );
    expect(await bounce.json()).toEqual({ outcome: "recorded" });
    const opened = await deliver(deliveryEvent("email.opened", annRow.provider_message_id!));
    expect(await opened.json()).toEqual({ ignored: true });

    const after = await sendsOf(pid);
    const a = after.find((r) => r.id === annRow.id)!;
    expect(new Date(a.delivered_at!).toISOString()).toBe("2026-10-19T08:00:00.000Z");
    const bn = after.find((r) => r.id === benRow.id)!;
    expect(bn.bounce_type).toBe("permanent");
    expect(JSON.stringify(bn)).not.toContain("does not exist");
    expect(JSON.stringify(bn)).not.toContain("customers.test");
    const outcome = await emailCampaignOutcome({
      id: pid,
      action: { detail: { segment: "lapsed" } },
    });
    expect(outcome.delivery).toMatchObject({ sent: 2, delivered: 1, bounced: 1 });
    // A bounce is not a person saying no: it is counted, not suppressed.
    expect(
      await db
        .select()
        .from(contactSuppressions)
        .where(eq(contactSuppressions.account_id, b.account_id)),
    ).toHaveLength(0);
  });

  it("a spam complaint suppresses the address for good, and the next campaign skips it", async () => {
    const b = await business();
    const [ann, ben] = [await person(b, "ann"), await person(b, "ben")];
    const first = await campaign(b, [ann.id, ben.id]);
    await send(b, first, fakeResend());
    const annRow = (await sendsOf(first)).find((r) => r.contact_id === ann.id)!;

    const res = await deliver(deliveryEvent("email.complained", annRow.provider_message_id!));
    expect(await res.json()).toEqual({ outcome: "recorded" });
    await deliver(deliveryEvent("email.complained", annRow.provider_message_id!));
    const suppressions = await db
      .select()
      .from(contactSuppressions)
      .where(eq(contactSuppressions.account_id, b.account_id));
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]).toMatchObject({ email_hash: annRow.email_hash, reason: "complained" });
    const logged = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.kind, "complaint"), eq(decisionLog.ref_id, annRow.id)));
    expect(logged).toHaveLength(1);

    // The next campaign: Ben gets it, Ann provably does not.
    const fake = fakeResend();
    const second = await campaign(b, [ann.id, ben.id]);
    await send(b, second, fake);
    expect(fake.calls.map((c) => c.body.to[0])).toEqual([`ben-${b.tag}@customers.test`]);
    const annSecond = (await sendsOf(second)).find((r) => r.contact_id === ann.id)!;
    expect(annSecond).toMatchObject({ status: "refused" });
    expect(annSecond.refused_reasons).toContain("suppressed");
    // And a re-import bounces off the suppression.
    const again = await importContacts(b.account_id, `email\nann-${b.tag}@customers.test`, {
      status: "explicit_consent",
      statement: "re-added from an old list",
    });
    expect(again.skipped.suppressed).toBe(1);
  });

  it("review #14: a complaint on an `unknown` row finds it by the send's tag and suppresses", async () => {
    const b = await business();
    const ann = await person(b, "ann");
    const pid = await campaign(b, [ann.id]);
    // Resend took the email but its answer was lost: the row is `unknown`, no provider id.
    const calls: { tags: unknown }[] = [];
    const lost: MailFetch = async (_url, init) => {
      calls.push(JSON.parse(String(init.body)) as { tags: unknown });
      return new Response("upstream timeout", { status: 504 });
    };
    await send(b, pid, { fetchImpl: lost });
    const [row] = await sendsOf(pid);
    expect(row).toMatchObject({ status: "unknown", provider_message_id: null });
    expect(calls[0]!.tags).toEqual([{ name: "syb_send", value: row!.id }]);

    // Without the tag (the failing case): nothing to attach it to.
    const untagged = await deliver(deliveryEvent("email.complained", "re_never_seen"));
    expect(await untagged.json()).toEqual({ outcome: "unmatched" });
    // With it: recorded, and the address is suppressed for good.
    const tagged = await deliver(
      deliveryEvent("email.complained", "re_never_seen", { sendId: row!.id }),
    );
    expect(await tagged.json()).toEqual({ outcome: "recorded" });
    const [after] = await sendsOf(pid);
    expect(after!.complained_at).not.toBeNull();
    expect(after!.status).toBe("unknown");
    const sup = await db
      .select()
      .from(contactSuppressions)
      .where(eq(contactSuppressions.account_id, b.account_id));
    expect(sup).toEqual([
      expect.objectContaining({ email_hash: row!.email_hash, reason: "complained" }),
    ]);
    // A tag naming a row that already has its provider id is not a second door.
    const other = await campaign(b, [(await person(b, "ben")).id]);
    await send(b, other, fakeResend());
    const [benRow] = await sendsOf(other);
    const stray = await deliver(
      deliveryEvent("email.complained", "re_someone_else", { sendId: benRow!.id }),
    );
    expect(await stray.json()).toEqual({ outcome: "unmatched" });
  });

  it("an erased recipient's later events are dropped, with nothing personal anywhere", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const b = await business();
    const ann = await person(b, "ann");
    const pid = await campaign(b, [ann.id]);
    await send(b, pid, fakeResend());
    const [row] = await sendsOf(pid);
    const resendId = row!.provider_message_id!;
    await eraseContact(b.account_id, ann.id);
    logs.length = 0;

    for (const type of ["email.delivered", "email.complained", "email.bounced"] as const) {
      const res = await deliver(
        deliveryEvent(type, resendId, { to: `ann-${b.tag}@customers.test`, sendId: row!.id }),
      );
      expect(await res.json()).toEqual({ outcome: "unmatched" });
    }
    const [after] = await sendsOf(pid);
    expect(after).toMatchObject({ delivered_at: null, complained_at: null, bounced_at: null });
    // The erasure's own suppression already holds; the complaint added nothing.
    const sup = await db
      .select()
      .from(contactSuppressions)
      .where(eq(contactSuppressions.account_id, b.account_id));
    expect(sup.map((s) => s.reason)).toEqual(["erasure"]);
    const all = logs.join("\n");
    expect(all).toContain("campaign_event_unmatched");
    expect(all).not.toContain("customers.test");
    expect(all).not.toContain(resendId);
    expect(all).not.toContain(row!.email_hash!);
    // The applier on its own says the same.
    expect(
      await applyDeliveryEvent({
        kind: "complained",
        email_id: resendId,
        at: new Date().toISOString(),
        bounce: null,
        // Review #14: the tag fallback never reaches an erased recipient's row either.
        send_id: row!.id,
      }),
    ).toEqual({ kind: "unmatched" });
  });
});

describe("P4-17 — the shop export refreshes purchase history, never consent", () => {
  it("updates an existing contact's purchases, keeps consent, never moves the last order backwards", async () => {
    const b = await business();
    const header = "email,last order date,orders,total spent";
    await importContacts(
      b.account_id,
      `${header}\nzoe-${b.tag}@customers.test,2026-03-01,2,40.00`,
      { status: "explicit_consent", statement: "checkout box" },
      { currency: "EUR" },
    );
    const [before] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, `zoe-${b.tag}@customers.test`));
    expect(before!.purchase_refreshed_at).not.toBeNull();

    const r = await importContacts(
      b.account_id,
      `${header}\nzoe-${b.tag}@customers.test,2026-05-02,3,55.50`,
      { status: "no_consent", statement: "a later export" },
      { currency: "EUR" },
    );
    expect(r.imported).toBe(0);
    expect(r.purchase.refreshed).toBe(1);
    const [mid] = await db.select().from(contacts).where(eq(contacts.id, before!.id));
    expect(mid).toMatchObject({
      consent_status: "explicit_consent",
      consent_source: before!.consent_source,
      orders_count: 3,
      total_spent_minor: 5550,
      spent_currency: "EUR",
    });
    expect(new Date(mid!.last_purchase_at!).toISOString().slice(0, 10)).toBe("2026-05-02");

    // An older file can't un-happen a purchase; an empty cell leaves the value alone.
    await importContacts(
      b.account_id,
      `${header}\nzoe-${b.tag}@customers.test,2026-01-01,,`,
      { status: "unsure", statement: "an old file" },
      { currency: "EUR" },
    );
    const [last] = await db.select().from(contacts).where(eq(contacts.id, before!.id));
    expect(new Date(last!.last_purchase_at!).toISOString().slice(0, 10)).toBe("2026-05-02");
    expect(last).toMatchObject({ orders_count: 3, consent_status: "explicit_consent" });

    // A file with no purchase columns refreshes nothing.
    const plain = await importContacts(b.account_id, `email\nzoe-${b.tag}@customers.test`, {
      status: "unsure",
      statement: "names only",
    });
    expect(plain.purchase.refreshed).toBe(0);
  });

  it("an erased comparison member keeps nothing but the proposal and the time", async () => {
    const b = await business();
    const header = "email,last order date";
    await importContacts(b.account_id, `${header}\nyes-${b.tag}@customers.test,2025-01-15`, {
      status: "explicit_consent",
      statement: "checkout box",
    });
    await importContacts(b.account_id, `${header}\nno-${b.tag}@customers.test,2025-01-15`, {
      status: "unsure",
      statement: "receipts",
    });
    const [yes] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, `yes-${b.tag}@customers.test`));
    const [no] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, `no-${b.tag}@customers.test`));
    const pid = await campaign(b, [yes!.id]);
    await send(b, pid, fakeResend());
    const [row] = await db
      .select()
      .from(campaignComparisons)
      .where(eq(campaignComparisons.proposal_id, pid));
    expect(row!.contact_id).toBe(no!.id);
    await eraseContact(b.account_id, no!.id);
    const [gone] = await db
      .select()
      .from(campaignComparisons)
      .where(eq(campaignComparisons.proposal_id, pid));
    expect(gone!.contact_id).toBeNull();
    const outcome = await emailCampaignOutcome({
      id: pid,
      action: { detail: { segment: "lapsed" } },
    });
    expect(outcome.comparison).toMatchObject({ size: 1, erased: 1, measured: 0 });
  });
});
