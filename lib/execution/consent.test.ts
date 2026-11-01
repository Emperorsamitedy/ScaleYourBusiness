// P3-20h — consent to write access, against the database: the typed
// phrase gates everything, the consent is a decision-log row whose hash
// covers what was shown and typed, and a refusal stores nothing at all.

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
import { ExecutionConnectionError, expectedExecutionScopes } from "./connections";
import { consentLines, consentToExecution, hashConsentPayload } from "./consent";

const created: { account_id: string; profile_id: string }[] = [];

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

const SECRET = JSON.stringify({ access_token: "EAAconsentTest", page_id: "1000000001" });
const answering = (scopes: readonly string[]) => async () => ({ granted_scopes: scopes });

afterAll(async () => {
  const accountIds = created.map((s) => s.account_id);
  const profileIds = created.map((s) => s.profile_id);
  if (accountIds.length > 0) {
    // The decision log is append-only (rule 7): its rows outlive the test, as they outlive a profile.
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, profileIds));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, profileIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
});

async function consentRows(profileId: string) {
  return db
    .select()
    .from(decisionLog)
    .where(and(eq(decisionLog.profile_id, profileId), eq(decisionLog.kind, "consent")));
}

describe("P3-20h — consentToExecution", () => {
  it("the typed phrase connects and records the consent: owner-actored, ref the connection, hash over what was shown", async () => {
    const s = await fresh();
    const scopes = expectedExecutionScopes("meta_publish");
    const { connection, consent_hash } = await consentToExecution({
      accountId: s.account_id,
      provider: "meta_publish",
      secret: SECRET,
      confirmation: " Allow publishing ",
      verify: answering(scopes),
    });
    expect(connection).toMatchObject({ provider: "meta_publish", purpose: "execute" });

    const rows = await consentRows(s.profile_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "owner",
      ref_id: connection.id,
      payload_hash: consent_hash,
    });
    expect(consent_hash).toBe(
      hashConsentPayload({
        account_id: s.account_id,
        connection_id: connection.id,
        provider: "meta_publish",
        granted_scopes: scopes,
        consent_lines: consentLines("meta_publish"),
        typed_confirmation: "allow publishing",
      }),
    );
  });

  // I-52d (owner, 2026-11-01): the person who consented is on the entry.
  it("records the signed-in person who consented; none given, none recorded", async () => {
    const s = await fresh();
    const person = crypto.randomUUID();
    await consentToExecution({
      accountId: s.account_id,
      provider: "meta_publish",
      secret: SECRET,
      confirmation: "allow publishing",
      verify: answering(expectedExecutionScopes("meta_publish")),
      userId: person,
    });
    expect((await consentRows(s.profile_id))[0]?.user_id).toBe(person);
  });

  it("the wrong phrase, an unoffered provider or a scope mismatch stores nothing and logs nothing", async () => {
    const s = await fresh();
    const scopes = expectedExecutionScopes("meta_publish");
    await expect(
      consentToExecution({
        accountId: s.account_id,
        provider: "meta_publish",
        secret: SECRET,
        confirmation: "yes",
        verify: answering(scopes),
      }),
    ).rejects.toThrow(/type "allow publishing" to confirm/);
    await expect(
      consentToExecution({
        accountId: s.account_id,
        provider: "fixture",
        secret: "x",
        confirmation: "allow publishing",
        verify: answering(["write_fixture_state"]),
      }),
    ).rejects.toThrow(ExecutionConnectionError);
    await expect(
      consentToExecution({
        accountId: s.account_id,
        provider: "meta_publish",
        secret: SECRET,
        confirmation: "allow publishing",
        verify: answering([...scopes, "ads_management"]),
      }),
    ).rejects.toThrow(/"ads_management"/);

    expect(
      await db.select().from(connections).where(eq(connections.account_id, s.account_id)),
    ).toHaveLength(0);
    expect(await consentRows(s.profile_id)).toHaveLength(0);
  });

  it("the hash moves when what was shown moves — a changed consent line is a different consent", () => {
    const base = {
      account_id: "a",
      connection_id: "c",
      provider: "meta_ads" as const,
      granted_scopes: ["ads_management"],
      consent_lines: consentLines("meta_ads"),
      typed_confirmation: "allow ad changes",
    };
    expect(hashConsentPayload(base)).toBe(
      hashConsentPayload({ ...base, granted_scopes: ["ads_management"] }),
    );
    expect(hashConsentPayload(base)).not.toBe(
      hashConsentPayload({ ...base, consent_lines: ["SYB may do anything."] }),
    );
  });
});
