// P4-15 — unsubscribe, through its own routes: a GET (a link scanner, a
// mail preview) never unsubscribes anyone; an RFC 8058 one-click POST does,
// at once, with a plain 200; the page's button POST does and comes back to
// the page; a token SYB never minted changes nothing; and it all works on
// the token alone, with no cookie.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  campaignSends,
  contactSuppressions,
  decisionLog,
  executions,
  fieldRecords,
  intakeEvents,
  proposals,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { createProposal } from "../proposals/service";
import { isOneClickPost, tokenHash, unsubscribe, viewUnsubscribe } from "./unsubscribe";

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  await db.delete(campaignSends).where(inArray(campaignSends.profile_id, ids));
  await db.delete(executions).where(inArray(executions.profile_id, ids));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(contactSuppressions).where(inArray(contactSuppressions.account_id, accountIds));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

/** One sent campaign row with a known token — what a recipient's email links to. */
async function sentRow() {
  const s = await bootstrapIntake();
  created.push(s);
  const p = await createProposal({
    profile_id: s.profile_id,
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
      profile_id: s.profile_id,
      account_id: s.account_id,
      provider: "email_campaign",
      op: "send_campaign",
      status: "succeeded",
    })
    .returning();
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const id = crypto.randomUUID();
  const hash = `h1:${"ab".repeat(32)}`;
  await db.insert(campaignSends).values({
    id,
    proposal_id: p.id,
    execution_id: run!.id,
    profile_id: s.profile_id,
    account_id: s.account_id,
    contact_id: null, // as after an erasure: the link still works
    email_hash: hash,
    status: "sent",
    idempotency_key: `syb-campaign-${id}`,
    unsubscribe_token_hash: tokenHash(token),
    sender_name: "Emberworks",
    claimed_at: new Date().toISOString(),
    sent_at: new Date().toISOString(),
  });
  return { ...s, token, id, hash };
}

const params = (token: string) => ({ params: Promise.resolve({ token }) });

async function suppressed(accountId: string) {
  return db.select().from(contactSuppressions).where(eq(contactSuppressions.account_id, accountId));
}

describe("P4-15 — unsubscribe", () => {
  it("a GET never unsubscribes: the route redirects to the page, the page only reads", async () => {
    const r = await sentRow();
    const { GET } = await import("../../app/api/u/[token]/route");
    const res = await GET(new NextRequest(`https://syb.test/api/u/${r.token}`), params(r.token));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://syb.test/u/${r.token}`);
    expect(await viewUnsubscribe(r.token)).toEqual({ business: "Emberworks", done: false });
    expect(await suppressed(r.account_id)).toEqual([]);
  });

  it("an RFC 8058 one-click POST unsubscribes at once, with a plain 200 and no cookie", async () => {
    const r = await sentRow();
    const { POST } = await import("../../app/api/u/[token]/route");
    const res = await POST(
      new NextRequest(`https://syb.test/api/u/${r.token}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
      params(r.token),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const rows = await suppressed(r.account_id);
    expect(rows).toMatchObject([{ email_hash: r.hash, reason: "unsubscribed" }]);
    const [send] = await db.select().from(campaignSends).where(eq(campaignSends.id, r.id));
    expect(send?.unsubscribed_at).not.toBeNull();
    const log = await db.select().from(decisionLog).where(eq(decisionLog.ref_id, r.id));
    expect(log).toMatchObject([{ kind: "unsubscribe", actor: "system" }]);
    // No PII and no token in the log entry.
    expect(JSON.stringify(log)).not.toContain(r.token);
    expect(JSON.stringify(log)).not.toContain(r.hash);
    // Twice is still once.
    expect(await unsubscribe(r.token)).toEqual({ business: "Emberworks", done: true });
    expect(await suppressed(r.account_id)).toHaveLength(1);
    expect(await db.select().from(decisionLog).where(eq(decisionLog.ref_id, r.id))).toHaveLength(1);
  });

  it("review #24: a multipart/form-data one-click also gets a plain 200, never the page's 303", async () => {
    const r = await sentRow();
    const { POST } = await import("../../app/api/u/[token]/route");
    const form = new FormData();
    form.set("List-Unsubscribe", "One-Click");
    // The request builds its own multipart body and boundary, as a mail client's would.
    const res = await POST(
      new NextRequest(`https://syb.test/api/u/${r.token}`, { method: "POST", body: form }),
      params(r.token),
    );
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
    expect(await suppressed(r.account_id)).toMatchObject([{ email_hash: r.hash }]);
  });

  it("review #24: only the one-click field counts — the button's multipart, or a lookalike, is not one", async () => {
    const boundary = "----syb";
    const part = (name: string, value: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const end = `--${boundary}--\r\n`;
    const type = `multipart/form-data; boundary=${boundary}`;
    expect(await isOneClickPost(type, `${part("List-Unsubscribe", "One-Click")}${end}`)).toBe(true);
    expect(await isOneClickPost(type, `${part("confirm", "1")}${end}`)).toBe(false);
    expect(await isOneClickPost(type, "not multipart at all")).toBe(false);
    expect(
      await isOneClickPost("application/x-www-form-urlencoded", "List-Unsubscribe=One-Click"),
    ).toBe(true);
    expect(await isOneClickPost(null, "List-Unsubscribe=One-Click")).toBe(true);
    expect(await isOneClickPost(null, "confirm=1")).toBe(false);
    expect(await isOneClickPost(null, "X-List-Unsubscribe=One-Click")).toBe(false);
  });

  it("the page's button POST unsubscribes and returns to the page, which says it's done", async () => {
    const r = await sentRow();
    const { POST } = await import("../../app/api/u/[token]/route");
    const res = await POST(
      new NextRequest(`https://syb.test/api/u/${r.token}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "confirm=1",
      }),
      params(r.token),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://syb.test/u/${r.token}`);
    expect(await viewUnsubscribe(r.token)).toEqual({ business: "Emberworks", done: true });
  });

  it("a token ScaleX never minted changes nothing", async () => {
    const r = await sentRow();
    const forged = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    expect(await viewUnsubscribe(forged)).toBeNull();
    expect(await unsubscribe(forged)).toBeNull();
    expect(await viewUnsubscribe("short")).toBeNull();
    const { POST } = await import("../../app/api/u/[token]/route");
    const res = await POST(
      new NextRequest(`https://syb.test/api/u/${forged}`, {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
      }),
      params(forged),
    );
    expect(res.status).toBe(404);
    expect(await suppressed(r.account_id)).toEqual([]);
  });
});
