// P4-15 — consent to campaign email (rule 13, P3-20h's pattern): a typed
// phrase, the registry's lines verbatim with the sender filled, a consent
// row whose hash covers what was shown, and a connection that holds NO
// secret — campaigns send from SYB's own account — with exactly the
// registry's scope and the sender identity.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  decisionLog,
  fieldRecords,
  intakeEvents,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { disconnectExecution, expectedExecutionScopes } from "./connections";
import {
  EMAIL_CAMPAIGN_PHRASE,
  checkSender,
  consentToCampaignEmail,
  emailConsentLines,
  hashEmailConsent,
  senderIdentity,
} from "./email-consent";

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const accountIds = created.map((s) => s.account_id);
  const profileIds = created.map((s) => s.profile_id);
  if (accountIds.length === 0) return;
  await db.delete(connections).where(inArray(connections.account_id, accountIds));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, profileIds));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, profileIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

describe("P4-15 — the consent wording", () => {
  it("the registry's two lines, verbatim, the sender filled in", () => {
    expect(emailConsentLines(senderIdentity("Emberworks", "Hello@Emberworks.test"))).toEqual([
      'SYB may send the campaigns you approve, from "Emberworks via SYB", with replies going to hello@emberworks.test, to customers who explicitly agreed to hear from you.',
      "SYB will never email anyone who hasn't explicitly agreed, or who unsubscribed.",
    ]);
  });

  it("the sender identity is checked: a name on one line, an address that reads", () => {
    expect(checkSender(" Emberworks ", " HELLO@emberworks.test ")).toEqual({
      name: "Emberworks",
      reply_to: "hello@emberworks.test",
    });
    expect(() => checkSender("", "a@b.co")).toThrow(/sender name/);
    expect(() => checkSender('Bad "name"', "a@b.co")).toThrow(/sender name/);
    expect(() => checkSender("Fine", "not-an-address")).toThrow(/email address/);
  });
});

describe("P4-15 — consentToCampaignEmail", () => {
  it("the typed phrase grants it: no secret, exact scopes, the sender, and a consent row over what was shown", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const { connection, consent_hash } = await consentToCampaignEmail({
      accountId: s.account_id,
      senderName: "Emberworks",
      replyTo: "hello@emberworks.test",
      confirmation: " Allow Campaign Email ",
    });
    expect(connection).toMatchObject({
      provider: "email_campaign",
      purpose: "execute",
      status: "connected",
      sender_name: "Emberworks",
      reply_to: "hello@emberworks.test",
    });
    const [row] = await db.select().from(connections).where(eq(connections.id, connection.id));
    expect(row?.encrypted_secret).toBeNull();
    expect([...(row?.granted_scopes ?? [])].sort()).toEqual([
      ...expectedExecutionScopes("email_campaign"),
    ]);
    const [entry] = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.ref_id, connection.id), eq(decisionLog.kind, "consent")));
    expect(entry).toMatchObject({
      actor: "owner",
      profile_id: s.profile_id,
      payload_hash: consent_hash,
    });
    expect(consent_hash).toBe(
      hashEmailConsent({
        account_id: s.account_id,
        connection_id: connection.id,
        granted_scopes: ["email.send_marketing"],
        consent_lines: emailConsentLines(senderIdentity("Emberworks", "hello@emberworks.test")),
        typed_confirmation: EMAIL_CAMPAIGN_PHRASE,
        sender_name: "Emberworks",
        reply_to: "hello@emberworks.test",
      }),
    );

    // Granted once: a second grant is refused until it is disconnected.
    await expect(
      consentToCampaignEmail({
        accountId: s.account_id,
        senderName: "Other",
        replyTo: "x@y.test",
        confirmation: EMAIL_CAMPAIGN_PHRASE,
      }),
    ).rejects.toMatchObject({ status: 409 });
    // Disconnect is one call, and then it can be granted again.
    expect((await disconnectExecution(s.account_id, connection.id)).status).toBe("disconnected");
    await expect(
      consentToCampaignEmail({
        accountId: s.account_id,
        senderName: "Emberworks",
        replyTo: "hello@emberworks.test",
        confirmation: EMAIL_CAMPAIGN_PHRASE,
      }),
    ).resolves.toBeDefined();
  });

  it("a wrong phrase or a bad sender stores nothing at all", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await expect(
      consentToCampaignEmail({
        accountId: s.account_id,
        senderName: "Emberworks",
        replyTo: "hello@emberworks.test",
        confirmation: "yes",
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      consentToCampaignEmail({
        accountId: s.account_id,
        senderName: "Emberworks",
        replyTo: "nope",
        confirmation: EMAIL_CAMPAIGN_PHRASE,
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(
      await db.select().from(connections).where(eq(connections.account_id, s.account_id)),
    ).toEqual([]);
    expect(
      await db.select().from(decisionLog).where(eq(decisionLog.profile_id, s.profile_id)),
    ).toEqual([]);
  });

  it("the database keeps a sender identity on the campaign-email row only", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await expect(
      db.insert(connections).values({
        account_id: s.account_id,
        provider: "meta_publish",
        purpose: "execute",
        status: "disconnected",
        sender_name: "Sneaky",
        reply_to: "a@b.test",
      }),
    ).rejects.toThrow();
  });
});
