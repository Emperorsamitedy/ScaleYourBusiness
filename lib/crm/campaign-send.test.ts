// P4-15 — the campaign send executor, against the database and a fake
// Resend. The global fetch is stubbed to fail if touched: nothing here
// reaches the network.
//
// THE DONE-WHEN, as one test: a campaign to an explicitly-consented
// segment sends exactly once through the engine (a second run sends zero),
// a non-consented contact — implied, unsure, none — provably never reaches
// the fake, and one unsubscribe suppresses permanently: the next campaign
// skips the address, re-import bounces, and it still holds after erasure.
//
// Then every gate refusing on its own, a suppression added between
// approval and send, an unknown outcome never retried, a run resuming with
// only the unsent, the erasure trail staying PII-free, and the due runner
// routing a campaign.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
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
  jurisdictionReviews,
  modeDecisions,
  proposals,
  users,
} from "../../db/schema";
import type { DraftLlm } from "../content/draft";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { haltExecutions, realWritesOffSentence, resumeExecutions } from "../execution/engine";
import { runDueExecutions } from "../execution/due";
import { consentToCampaignEmail } from "../execution/email-consent";
import type { MailFetch } from "../execution/providers/email-campaign";
import {
  SLOT,
  createEmailCampaignExecutor,
  fillSlot,
  sha256,
  unsubscribeUrls,
} from "../execution/providers/email-campaign";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal, createProposal } from "../proposals/service";
import { unsubscribe, viewUnsubscribe } from "../unsubscribe/unsubscribe";
import { draftCampaign } from "./campaign-draft";
import {
  GATE_WORDS,
  STALE_RUN_MS,
  approveCampaignEmail,
  approvedRecipients,
  campaignFromHeader,
  campaignGates,
  campaignPlanFor,
  campaignSendView,
  dbCampaignBackend,
  reclaimStaleCampaignRuns,
  sendCampaignNow,
  tallyCounts,
  unsubscribeBase,
} from "./campaign-send";
import type { ConsentStatus } from "./contacts";
import { addContact, emailHash, eraseContact } from "./contacts";
import { importContacts } from "./import";
import { consentRefusals } from "./jurisdiction";
import type { LawReviewVerdict } from "./law-review";
import { jurisdictionTableHash, lawReviewVerdict } from "./law-review";

/* ── pure ── */

describe("P4-15 — the pure parts", () => {
  it("fillSlot fills only the slot, and refuses a body without one", () => {
    const approved = `Hello.\n\nUnsubscribe: ${SLOT}`;
    const url = "https://syb.test/u/abc";
    expect(fillSlot(approved, url)).toBe("Hello.\n\nUnsubscribe: https://syb.test/u/abc");
    expect(fillSlot("Hello, no slot here.", url)).toBeNull();
    // A body that already holds the url can't be proven equal after the fill.
    expect(fillSlot(`${url} ${SLOT}`, url)).toBeNull();
  });

  it("the page and the one-click endpoint are separate, both https under the base", () => {
    expect(unsubscribeUrls("https://syb.test/", "tok")).toEqual({
      page: "https://syb.test/u/tok",
      one_click: "https://syb.test/api/u/tok",
    });
    expect(unsubscribeBase("https://app.example.com/path")).toBe("https://app.example.com");
    expect(unsubscribeBase("http://localhost:3000")).toBeNull();
    expect(unsubscribeBase(null)).toBeNull();
    expect(unsubscribeBase("not a url")).toBeNull();
  });

  it("the From header is their name via Ledgerline, at SYB's verified address", () => {
    expect(campaignFromHeader("Emberworks", "hello@send.syb.test")).toBe(
      '"Emberworks via Ledgerline" <hello@send.syb.test>',
    );
    expect(campaignFromHeader('Bad "<name>\r\n', "a@b.c")).toBe(
      '"Bad name via Ledgerline" <a@b.c>',
    );
  });

  it("the approved recipients are the proposal's ids, deduplicated, nothing else", () => {
    expect(approvedRecipients({ detail: { contact_ids: ["a", "b", "a", 3] } })).toEqual(["a", "b"]);
    expect(approvedRecipients({ detail: {} })).toEqual([]);
    expect(approvedRecipients(null)).toEqual([]);
  });

  it("the tally counts a recipient once, and once per reason", () => {
    const t = tallyCounts([
      { status: "sent", reasons: [] },
      { status: "refused", reasons: ["consent_implied", "message_incomplete"] },
      { status: "refused", reasons: ["consent_implied"] },
      { status: "unknown", reasons: [] },
    ]);
    expect(t).toMatchObject({ sent: 1, refused: 2, unknown: 1, pending: 0 });
    expect(t.refused_by_reason).toEqual({ consent_implied: 2, message_incomplete: 1 });
  });

  it("consent as codes: explicit passes, every other gradation is named", () => {
    expect(consentRefusals({ email: "a@b.c", consent_status: "explicit_consent" }, false)).toEqual(
      [],
    );
    expect(consentRefusals({ email: "a@b.c", consent_status: "implied_consent" }, false)).toEqual([
      "consent_implied",
    ]);
    expect(consentRefusals({ email: "a@b.c", consent_status: "unsure" }, true)).toEqual([
      "suppressed",
      "consent_unsure",
    ]);
    expect(consentRefusals({ email: null, consent_status: "no_consent" }, false)).toEqual([
      "no_email",
    ]);
  });

  it("campaignPlanFor routes a crm customer_email proposal and nothing else", () => {
    expect(
      campaignPlanFor({ id: "p1", module: "crm", action: { kind: "customer_email", summary: "" } }),
    ).toEqual({ provider: "email_campaign", op: "send_campaign", params: { proposal_id: "p1" } });
    expect(
      campaignPlanFor({ id: "p1", module: "ads", action: { kind: "customer_email" } }),
    ).toBeNull();
    expect(campaignPlanFor({ id: "p1", module: "crm", action: { kind: "other" } })).toBeNull();
  });
});

/* ── against the database ── */

const created: { account_id: string; profile_id: string }[] = [];
const reviews: string[] = [];
const noSleep = async () => undefined;
const CURRENT: LawReviewVerdict = lawReviewVerdict(
  { table_sha256: jurisdictionTableHash(), reviewed_on: "2026-10-18" },
  jurisdictionTableHash(),
);
const ENV_KEYS = ["SESSION_D_REAL_WRITES", "RESEND_API_KEY", "APP_URL", "EMAIL_FROM"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.SESSION_D_REAL_WRITES = "on";
  process.env.RESEND_API_KEY = "re_test_campaigns";
  process.env.APP_URL = "https://syb.test";
  process.env.EMAIL_FROM = "Ledgerline <hello@send.syb.test>";
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
  if (reviews.length > 0) {
    await db.delete(jurisdictionReviews).where(inArray(jurisdictionReviews.id, reviews));
  }
  if (ids.length === 0) return;
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
  text: "Thank you for coming back to the studio. The winter range is on the shelf this week.",
});

interface Business {
  account_id: string;
  profile_id: string;
  user_id: string;
  tag: string;
}

async function business(
  mode: "instant" | "watching" = "instant",
  country = "Hungary",
): Promise<Business> {
  const s = await bootstrapIntake();
  created.push(s);
  await owner(s.profile_id, "identity.legal_name", "Emberworks");
  await owner(s.profile_id, "legal.country", country);
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode,
    watch_weeks: mode === "watching" ? 6 : null,
    inputs: { reasons: ["test fixture"] },
    reasoning: "test fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 42 * 86_400_000).toISOString(),
  });
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p4-15-${crypto.randomUUID()}@test.local`,
      display_name: "P4-15 owner",
      role: "owner",
    })
    .returning({ id: users.id });
  return { ...s, user_id: u!.id, tag: crypto.randomUUID().slice(0, 8) };
}

async function person(b: Business, label: string, status: ConsentStatus) {
  return addContact(b.account_id, {
    email: `${label}-${b.tag}@customers.test`,
    name: `${label} Person`,
    consent: { status, source: `test: ${label}` },
  });
}

/** An approved campaign proposal for these contact ids, drafted, its email approved. */
async function campaign(
  b: Business,
  contactIds: string[],
  opts: { level?: "easy" | "hard"; approveEmail?: boolean; connect?: boolean } = {},
) {
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
      level: opts.level ?? "hard",
      if_you_change_your_mind: "Irreversible once sent: a sent email can't be recalled.",
    },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await approveProposal({ proposalId: p.id, userId: b.user_id, profileId: b.profile_id });
  const { draft } = await draftCampaign(p.id, { draftLlm, limitLlm: limitsLlm });
  if (opts.connect !== false) {
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
  if (opts.approveEmail !== false && (opts.level ?? "hard") === "hard") {
    await approveCampaignEmail({
      profileId: b.profile_id,
      proposalId: p.id,
      userId: b.user_id,
      subject: "A note from Emberworks",
      bodySha256: sha256(draft.body),
    });
  }
  return { proposal_id: p.id, draft };
}

interface FakeCall {
  url: string;
  headers: Record<string, string>;
  body: {
    from: string;
    to: string[];
    reply_to: string;
    subject: string;
    text: string;
    headers: Record<string, string>;
  };
}

/** A fake Resend: answers each call from the script (default 200 with an id), records everything. */
function fakeResend(script: (number | "throw")[] = []) {
  const calls: FakeCall[] = [];
  const fetchImpl: MailFetch = async (url, init) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as FakeCall["body"],
    });
    const next = script.shift() ?? 200;
    if (next === "throw") throw new TypeError("network down");
    if (next === 200) {
      return new Response(JSON.stringify({ id: `re_${calls.length}_${crypto.randomUUID()}` }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ message: "refused" }), { status: next });
  };
  return { calls, fetchImpl };
}

function provider(
  fake: { fetchImpl: MailFetch },
  opts: { lawReview?: () => Promise<LawReviewVerdict>; runCap?: number } = {},
) {
  return createEmailCampaignExecutor({
    fetch: fake.fetchImpl,
    sleep: noSleep,
    backend: dbCampaignBackend({ lawReview: opts.lawReview ?? (async () => CURRENT) }),
    ...(opts.runCap ? { runCap: opts.runCap } : {}),
  });
}

async function sendsOf(proposalId: string) {
  return db.select().from(campaignSends).where(eq(campaignSends.proposal_id, proposalId));
}

const tokenIn = (text: string): string => /\/u\/([A-Za-z0-9_-]{43})/.exec(text)![1]!;

describe("P4-15 — THE DONE-WHEN", () => {
  it("sends exactly once through the engine, never to the non-consented, and one unsubscribe holds for good", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const b = await business();
    const ann = await person(b, "ann", "explicit_consent");
    const ben = await person(b, "ben", "explicit_consent");
    const implied = await person(b, "imp", "implied_consent");
    const unsure = await person(b, "uns", "unsure");
    const none = await person(b, "non", "no_consent");
    const ids = [ann, ben, implied, unsure, none].map((c) => c.id);
    const c = await campaign(b, ids);
    const fake = fakeResend();

    // 1. Exactly once, through the engine.
    const first = await sendCampaignNow({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      provider: provider(fake),
    });
    expect(first.result).toBe("sent");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.map((x) => x.body.to[0]).sort()).toEqual([ann.email, ben.email].sort());

    // 2. The non-consented never reached the fake — not in any call, any field.
    const everything = JSON.stringify(fake.calls);
    for (const nope of [implied, unsure, none]) expect(everything).not.toContain(nope.email!);

    // What went out is the approved body, apart from the recipient's own link.
    for (const call of fake.calls) {
      expect(call.url).toBe("https://api.resend.com/emails");
      expect(call.body.text.split(/https:\/\/syb\.test\/u\/[A-Za-z0-9_-]{43}/).join(SLOT)).toBe(
        c.draft.body,
      );
      const token = tokenIn(call.body.text);
      expect(call.body.headers).toEqual({
        "List-Unsubscribe": `<https://syb.test/api/u/${token}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      });
      expect(call.body.from).toBe('"Emberworks via Ledgerline" <hello@send.syb.test>');
      expect(call.body.reply_to).toBe("hello@emberworks.test");
      expect(call.body.subject).toBe("A note from Emberworks");
      expect(call.headers["Idempotency-Key"]).toMatch(/^syb-campaign-[0-9a-f-]{36}$/);
    }
    expect(new Set(fake.calls.map((x) => x.headers["Idempotency-Key"])).size).toBe(2);
    expect(new Set(fake.calls.map((x) => tokenIn(x.body.text))).size).toBe(2);

    const rows = await sendsOf(c.proposal_id);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(2);
    const refused = rows.filter((r) => r.status === "refused");
    expect(refused.map((r) => r.refused_reasons[0]).sort()).toEqual([
      "consent_implied",
      "consent_none",
      "consent_unsure",
    ]);
    // Rows hold hashes and ids, never an address; the token only as its hash.
    expect(JSON.stringify(rows)).not.toMatch(/@customers\.test/);
    for (const call of fake.calls)
      expect(JSON.stringify(rows)).not.toContain(tokenIn(call.body.text));
    const [p] = await db.select().from(proposals).where(eq(proposals.id, c.proposal_id));
    expect(p?.status).toBe("executed");

    // A second run — by the owner's click and by the due runner — sends zero.
    await sendCampaignNow({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      provider: provider(fake),
    });
    await runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { email_campaign: provider(fake) },
    });
    expect(fake.calls).toHaveLength(2);

    // 3. One unsubscribe — one-click, from Ann's own link.
    const annCall = fake.calls.find((x) => x.body.to[0] === ann.email)!;
    const token = tokenIn(annCall.body.text);
    expect(await viewUnsubscribe(token)).toEqual({ business: "Emberworks", done: false });
    expect(await unsubscribe(token)).toEqual({ business: "Emberworks", done: true });
    const [supp] = await db
      .select()
      .from(contactSuppressions)
      .where(
        and(
          eq(contactSuppressions.account_id, b.account_id),
          eq(contactSuppressions.email_hash, emailHash(ann.email!)),
        ),
      );
    expect(supp?.reason).toBe("unsubscribed");

    // The next campaign skips the address, immediately.
    const next = await campaign(b, [ann.id, ben.id]);
    const fake2 = fakeResend();
    expect(
      (
        await sendCampaignNow({
          profileId: b.profile_id,
          proposalId: next.proposal_id,
          provider: provider(fake2),
        })
      ).result,
    ).toBe("sent");
    expect(fake2.calls.map((x) => x.body.to[0])).toEqual([ben.email]);
    const nextRows = await sendsOf(next.proposal_id);
    expect(nextRows.find((r) => r.contact_id === ann.id)?.refused_reasons).toEqual(["suppressed"]);

    // Erased: re-import bounces off the suppression, and the link still works.
    await eraseContact(b.account_id, ann.id);
    const again = await importContacts(b.account_id, `email,name\n${ann.email},Ann Person`, {
      status: "explicit_consent",
      statement: "re-import after erasure, test",
    });
    expect(again.skipped.suppressed).toBe(1);
    expect(again.imported).toBe(0);
    expect(await viewUnsubscribe(token)).toEqual({ business: "Emberworks", done: true });
    expect(await unsubscribe(token)).toEqual({ business: "Emberworks", done: true });
    const stillThere = await db
      .select()
      .from(contactSuppressions)
      .where(eq(contactSuppressions.account_id, b.account_id));
    expect(stillThere.filter((r) => r.email_hash === emailHash(ann.email!))).toHaveLength(1);

    // Rule 22: Ann's send rows lost the contact and Resend's id; nothing personal anywhere.
    const after = await sendsOf(c.proposal_id);
    const annRow = after.find((r) => r.email_hash === emailHash(ann.email!))!;
    expect(annRow).toMatchObject({ contact_id: null, provider_message_id: null, status: "sent" });
    expect(annRow.unsubscribed_at).not.toBeNull();
    const log = await db.select().from(decisionLog).where(eq(decisionLog.profile_id, b.profile_id));
    expect(log.map((l) => l.kind)).toEqual(
      expect.arrayContaining([
        "consent",
        "campaign_approval",
        "execution",
        "unsubscribe",
        "erasure",
      ]),
    );
    const trail = JSON.stringify({ log, after, nextRows, logs });
    for (const pii of [ann.email!, "Ann Person", ben.email!, implied.email!, token]) {
      expect(trail).not.toContain(pii);
    }
    spy.mockRestore();
  });
});

describe("P4-15 — each gate refuses on its own, sending nothing and keeping the approval", () => {
  async function refusedBy(
    setup: (b: Business) => Promise<void>,
    opts: {
      lawReview?: () => Promise<LawReviewVerdict>;
      mode?: "instant" | "watching";
      connect?: boolean;
    } = {},
  ) {
    const b = await business(opts.mode ?? "instant");
    const ann = await person(b, "ann", "explicit_consent");
    const c = await campaign(b, [ann.id], { connect: opts.connect ?? true });
    await setup(b);
    const fake = fakeResend();
    const out = await sendCampaignNow({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      provider: provider(fake, opts.lawReview ? { lawReview: opts.lawReview } : {}),
    });
    expect(out.result).toBe("refused");
    expect(fake.calls).toHaveLength(0);
    expect(await sendsOf(c.proposal_id)).toHaveLength(0);
    const [p] = await db.select().from(proposals).where(eq(proposals.id, c.proposal_id));
    expect(p?.status).toBe("approved");
    const [run] = await db
      .select()
      .from(executions)
      .where(eq(executions.proposal_id, c.proposal_id));
    expect(run).toBeUndefined();
    return { out, b, c };
  }

  it("guard 6a: real sends off — in the engine's own sentence", async () => {
    const { out } = await refusedBy(async () => {
      delete process.env.SESSION_D_REAL_WRITES;
    });
    expect(out.message).toBe(realWritesOffSentence("Campaign email"));
  });

  it("no law review on record", async () => {
    const { out } = await refusedBy(async () => undefined, {
      lawReview: async () => lawReviewVerdict(null, jurisdictionTableHash()),
    });
    expect(out.message).toMatch(/^Nobody has reviewed the email-law rules/);
    expect(out.message).toMatch(/Nothing was sent; this stays approved\.$/);
  });

  it("a stale review: its hash isn't the table's any more", async () => {
    const { out } = await refusedBy(async () => undefined, {
      lawReview: async () =>
        lawReviewVerdict(
          { table_sha256: "a".repeat(64), reviewed_on: "2026-10-01" },
          jurisdictionTableHash(),
        ),
    });
    expect(out.message).toMatch(/changed after their last review \(2026-10-01\)/);
  });

  it("the emergency stop", async () => {
    const { out, b } = await refusedBy(async (biz) => {
      await haltExecutions({ accountId: biz.account_id, reason: "test" });
    });
    expect(out.message).toMatch(/emergency stop is on/);
    await resumeExecutions(b.account_id);
  });

  it("the watch", async () => {
    const { out } = await refusedBy(async () => undefined, { mode: "watching" });
    expect(out.message).toMatch(/being watched, not changed/);
  });

  it("not connected", async () => {
    const { out } = await refusedBy(async () => undefined, { connect: false });
    expect(out.message).toBe(`${GATE_WORDS.not_connected} Nothing was sent; this stays approved.`);
  });

  it("email not set up: no https address for unsubscribe links", async () => {
    const { out } = await refusedBy(async () => {
      process.env.APP_URL = "http://localhost:3000";
    });
    expect(out.message).toMatch(/^Email isn't set up yet/);
  });

  it("a campaign approved as undoable is refused before anything is read", async () => {
    const b = await business();
    const ann = await person(b, "ann", "explicit_consent");
    const c = await campaign(b, [ann.id], { level: "easy" });
    // The email itself can't be approved under that label either.
    await expect(
      approveCampaignEmail({
        profileId: b.profile_id,
        proposalId: c.proposal_id,
        userId: b.user_id,
        subject: "Hi",
        bodySha256: sha256(c.draft.body),
      }),
    ).rejects.toMatchObject({ status: 409 });
    const fake = fakeResend();
    const out = await sendCampaignNow({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      provider: provider(fake),
    });
    expect(out).toMatchObject({ result: "refused" });
    expect(out.message).toMatch(/cannot be undone, but the proposal was labelled "easy"/);
    expect(fake.calls).toHaveLength(0);
  });

  it("the screen names the gate holding it, first in the engine's order", async () => {
    const b = await business();
    const ann = await person(b, "ann", "explicit_consent");
    const c = await campaign(b, [ann.id], { connect: false });
    delete process.env.SESSION_D_REAL_WRITES;
    const [p] = await db.select().from(proposals).where(eq(proposals.id, c.proposal_id));
    const gates = await campaignGates(p!, b.account_id, {
      lawReview: async () => lawReviewVerdict(null, jurisdictionTableHash()),
    });
    expect(gates.map((g) => g.code)).toEqual([
      "real_sends_off",
      "not_connected",
      "law_review_missing",
    ]);
    const view = await campaignSendView(p!, b.account_id);
    expect(view.phase).toBe("held");
    expect(view.gates[0]?.code).toBe("real_sends_off");
  });
});

describe("P4-15 — at send time, per recipient", () => {
  it("a suppression added between approval and send is honoured", async () => {
    const b = await business();
    const ann = await person(b, "ann", "explicit_consent");
    const ben = await person(b, "ben", "explicit_consent");
    const c = await campaign(b, [ann.id, ben.id]);
    // Ben unsubscribes from something else after the owner approved the email.
    await db.insert(contactSuppressions).values({
      account_id: b.account_id,
      email_hash: emailHash(ben.email!),
      reason: "unsubscribed",
    });
    const fake = fakeResend();
    await sendCampaignNow({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      provider: provider(fake),
    });
    expect(fake.calls.map((x) => x.body.to[0])).toEqual([ann.email]);
    const rows = await sendsOf(c.proposal_id);
    expect(rows.find((r) => r.contact_id === ben.id)).toMatchObject({
      status: "refused",
      refused_reasons: ["suppressed"],
    });
  });

  it("consent withdrawn to 'unsure' after approval is refused at send", async () => {
    const b = await business();
    const ann = await person(b, "ann", "explicit_consent");
    const c = await campaign(b, [ann.id]);
    await db.update(contacts).set({ consent_status: "unsure" }).where(eq(contacts.id, ann.id));
    const fake = fakeResend();
    await sendCampaignNow({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      provider: provider(fake),
    });
    expect(fake.calls).toHaveLength(0);
    expect((await sendsOf(c.proposal_id))[0]?.refused_reasons).toEqual(["consent_unsure"]);
  });

  it("a recipient in a country with no known rules is refused, the rest sent", async () => {
    const b = await business();
    const ann = await person(b, "ann", "explicit_consent");
    const cal = await person(b, "cal", "explicit_consent");
    await db.update(contacts).set({ country: "CH" }).where(eq(contacts.id, cal.id));
    const c = await campaign(b, [ann.id, cal.id]);
    const fake = fakeResend();
    await sendCampaignNow({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      provider: provider(fake),
    });
    expect(fake.calls.map((x) => x.body.to[0])).toEqual([ann.email]);
    expect(
      (await sendsOf(c.proposal_id)).find((r) => r.contact_id === cal.id)?.refused_reasons,
    ).toEqual(["no_regime"]);
  });

  it("an unknown outcome is never retried — by the next run or any other", async () => {
    const b = await business();
    const ann = await person(b, "ann", "explicit_consent");
    const ben = await person(b, "ben", "explicit_consent");
    const c = await campaign(b, [ann.id, ben.id]);
    const fake = fakeResend([500]);
    const first = await sendCampaignNow({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      provider: provider(fake),
    });
    // The run stopped after the uncertain one: one at risk, not the whole list.
    expect(first.result).toBe("held");
    expect(fake.calls).toHaveLength(1);
    const uncertain = fake.calls[0]!.body.to[0]!;
    let rows = await sendsOf(c.proposal_id);
    expect(rows.map((r) => r.status).sort()).toEqual(["pending", "unknown"]);

    // The due runner picks the held run up and sends only the pending one.
    await runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { email_campaign: provider(fake) },
    });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.body.to[0]).not.toBe(uncertain);
    rows = await sendsOf(c.proposal_id);
    expect(rows.map((r) => r.status).sort()).toEqual(["sent", "unknown"]);

    // And again: nothing more, ever.
    await sendCampaignNow({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      provider: provider(fake),
    });
    await runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { email_campaign: provider(fake) },
    });
    expect(fake.calls).toHaveLength(2);
    const view = await campaignSendView(
      (await db.select().from(proposals).where(eq(proposals.id, c.proposal_id)))[0]!,
      b.account_id,
    );
    expect(view).toMatchObject({ phase: "sent", counts: { sent: 1, unknown: 1 } });
  });

  it("a definite refusal is failed (nothing went out); a key or rate refusal puts it back and holds", async () => {
    const b = await business();
    const ann = await person(b, "ann", "explicit_consent");
    const ben = await person(b, "ben", "explicit_consent");
    const c = await campaign(b, [ann.id, ben.id]);
    const fake = fakeResend([422, 429]);
    const out = await sendCampaignNow({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      provider: provider(fake),
    });
    expect(out).toMatchObject({ result: "held" });
    expect(out.message).toMatch(/asked SYB to slow down/);
    const rows = await sendsOf(c.proposal_id);
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "pending"]);
    expect(rows.find((r) => r.status === "failed")?.provider_status).toBe(422);
    expect(rows.find((r) => r.status === "pending")?.email_hash).toBeNull();
  });

  it("a run at its cap resumes with only the unsent; a stop mid-run holds and resumes the same way", async () => {
    const b = await business();
    const people = await Promise.all(
      ["a1", "a2", "a3"].map((l) => person(b, l, "explicit_consent")),
    );
    const c = await campaign(
      b,
      people.map((x) => x.id),
    );
    const fake = fakeResend();
    const capped = provider(fake, { runCap: 1 });

    const one = await sendCampaignNow({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      provider: capped,
    });
    expect(one).toMatchObject({ result: "held" });
    expect(one.message).toMatch(/Sent 1 this run\. 2 still to go/);
    const [run] = await db
      .select()
      .from(executions)
      .where(eq(executions.proposal_id, c.proposal_id));
    expect(run).toMatchObject({ status: "failed", held_for: "remaining" });

    // The stop comes on; the next run is refused outright and sends nothing.
    await haltExecutions({ accountId: b.account_id, reason: "test" });
    await runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { email_campaign: capped },
    });
    expect(fake.calls).toHaveLength(1);
    await resumeExecutions(b.account_id);

    await runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { email_campaign: capped },
    });
    await runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { email_campaign: capped },
    });
    expect(fake.calls).toHaveLength(3);
    expect(new Set(fake.calls.map((x) => x.body.to[0])).size).toBe(3);
    const [done] = await db
      .select()
      .from(executions)
      .where(eq(executions.proposal_id, c.proposal_id));
    expect(done?.status).toBe("succeeded");
  });

  it("a stop between two sends holds the run, and the resume sends only the rest", async () => {
    const b = await business();
    const people = await Promise.all(["s1", "s2"].map((l) => person(b, l, "explicit_consent")));
    const c = await campaign(
      b,
      people.map((x) => x.id),
    );
    const fake = fakeResend();
    let sent = 0;
    const halting: MailFetch = async (url, init) => {
      const res = await fake.fetchImpl(url, init);
      sent += 1;
      if (sent === 1) await haltExecutions({ accountId: b.account_id, reason: "mid-run" });
      return res;
    };
    const out = await sendCampaignNow({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      provider: provider({ fetchImpl: halting }),
    });
    expect(out).toMatchObject({ result: "refused" });
    expect(fake.calls).toHaveLength(1);
    const [run] = await db
      .select()
      .from(executions)
      .where(eq(executions.proposal_id, c.proposal_id));
    expect(run).toMatchObject({ status: "failed", held_for: "stop" });
    await resumeExecutions(b.account_id);
    await runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { email_campaign: provider(fake) },
    });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.body.to[0]).not.toBe(fake.calls[1]!.body.to[0]);
  });

  it("a run that died mid-send: its `sending` row becomes unknown, the rest go on", async () => {
    const b = await business();
    const people = await Promise.all(["d1", "d2"].map((l) => person(b, l, "explicit_consent")));
    const c = await campaign(
      b,
      people.map((x) => x.id),
    );
    // Simulate the death: a run claimed, one row claimed `sending`, then nothing.
    const [run] = await db
      .insert(executions)
      .values({
        proposal_id: c.proposal_id,
        profile_id: b.profile_id,
        account_id: b.account_id,
        provider: "email_campaign",
        op: "send_campaign",
        started_at: new Date(Date.now() - STALE_RUN_MS - 60_000).toISOString(),
      })
      .returning();
    const backend = dbCampaignBackend({ lawReview: async () => CURRENT });
    await backend.materialise(c.proposal_id, run!.id, {
      profile_id: b.profile_id,
      account_id: b.account_id,
    });
    const [firstRow] = await backend.pending(c.proposal_id, 1);
    // Rows tie on created_at and then order by a random id, so name the
    // address of whichever contact this row belongs to.
    const claimed = people.find((x) => x.id === firstRow!.contact_id)!;
    await backend.claim(firstRow!.send_id, {
      email_hash: emailHash(claimed.email!),
      token_hash: "f".repeat(64),
      sender_name: "Emberworks",
      body_sha256: "0".repeat(64),
    });
    expect(await reclaimStaleCampaignRuns()).toBeGreaterThanOrEqual(1);
    const fake = fakeResend();
    await runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { email_campaign: provider(fake) },
    });
    expect(fake.calls).toHaveLength(1);
    const rows = await sendsOf(c.proposal_id);
    expect(rows.find((r) => r.id === firstRow!.send_id)?.status).toBe("unknown");
    expect(rows.map((r) => r.status).sort()).toEqual(["sent", "unknown"]);
  });

  it("the same address on two rows is emailed once — the UNIQUE index decides", async () => {
    const b = await business();
    const ann = await person(b, "ann", "explicit_consent");
    const c = await campaign(b, [ann.id]);
    const [run] = await db
      .insert(executions)
      .values({
        proposal_id: c.proposal_id,
        profile_id: b.profile_id,
        account_id: b.account_id,
        provider: "email_campaign",
        op: "send_campaign",
      })
      .returning();
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    await db.insert(campaignSends).values(
      [id1, id2].map((id) => ({
        id,
        proposal_id: c.proposal_id,
        execution_id: run!.id,
        profile_id: b.profile_id,
        account_id: b.account_id,
        idempotency_key: `syb-campaign-${id}`,
      })),
    );
    const backend = dbCampaignBackend({ lawReview: async () => CURRENT });
    const claim = {
      email_hash: emailHash(ann.email!),
      token_hash: "e".repeat(64),
      sender_name: "Emberworks",
      body_sha256: "0".repeat(64),
    };
    expect(await backend.claim(id1, claim)).toEqual({ claimed: true });
    expect(await backend.claim(id2, { ...claim, token_hash: "d".repeat(64) })).toEqual({
      claimed: false,
      code: "duplicate_address",
    });
    // And a claimed row can't be claimed again.
    expect(await backend.claim(id1, claim)).toEqual({ claimed: false, code: null });
  });
});

describe("P4-15 — the owner approves the exact email", () => {
  it("records who, when, the body's hash and the subject; a changed body is refused", async () => {
    const b = await business();
    const ann = await person(b, "ann", "explicit_consent");
    const c = await campaign(b, [ann.id], { approveEmail: false });
    await expect(
      approveCampaignEmail({
        profileId: b.profile_id,
        proposalId: c.proposal_id,
        userId: b.user_id,
        subject: "Hello",
        bodySha256: sha256(`${c.draft.body} edited`),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      approveCampaignEmail({
        profileId: b.profile_id,
        proposalId: c.proposal_id,
        userId: b.user_id,
        subject: "two\nlines",
        bodySha256: sha256(c.draft.body),
      }),
    ).rejects.toMatchObject({ status: 422 });
    const ok = await approveCampaignEmail({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      userId: b.user_id,
      subject: "Hello",
      bodySha256: sha256(c.draft.body),
    });
    expect(ok.fresh).toBe(true);
    const [item] = await db.select().from(contentItems).where(eq(contentItems.id, c.draft.id));
    expect(item).toMatchObject({
      approved_by: b.user_id,
      approved_sha256: sha256(c.draft.body),
      approved_subject: "Hello",
    });
    const [p] = await db.select().from(proposals).where(eq(proposals.id, c.proposal_id));
    expect(p?.execute_not_before).not.toBeNull();
    const log = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.ref_id, c.proposal_id), eq(decisionLog.kind, "campaign_approval")));
    expect(log).toHaveLength(1);
    // Approving the same thing twice is the same approval.
    const again = await approveCampaignEmail({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      userId: b.user_id,
      subject: "Hello",
      bodySha256: sha256(c.draft.body),
    });
    expect(again.fresh).toBe(false);

    // The body changed after approval: the send refuses it by name.
    await db
      .update(contentItems)
      .set({ body: `${c.draft.body}\nP.S. an edit` })
      .where(eq(contentItems.id, c.draft.id));
    const fake = fakeResend();
    const out = await sendCampaignNow({
      profileId: b.profile_id,
      proposalId: c.proposal_id,
      provider: provider(fake),
    });
    expect(out.message).toMatch(/^The email changed after you approved it/);
    expect(fake.calls).toHaveLength(0);
  });

  it("an approved campaign whose email nobody approved is never picked up by the due runner", async () => {
    const b = await business();
    const ann = await person(b, "ann", "explicit_consent");
    const c = await campaign(b, [ann.id], { approveEmail: false });
    const fake = fakeResend();
    const summary = await runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { email_campaign: provider(fake) },
    });
    expect(summary.outcomes.find((o) => o.proposal_id === c.proposal_id)).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });
});
