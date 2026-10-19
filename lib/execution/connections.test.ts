// P3-20b — execution connections, rule 13 as tests: a write credential
// connects only with EXACTLY the registered scopes; one too many or too
// few is refused by name; a measure row can never hold a write-capable
// scope (the trigger mirrors isWriteCapable, proven on a sample); and
// the measurement side — activeConnection, listConnections, the sync
// runner — never sees an execute row.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  fieldRecords,
  intakeEvents,
} from "../../db/schema";
import { isWriteCapable } from "../connectors/scopes";
import { decryptSecret } from "../connectors/secrets";
import { activeConnection, listConnections } from "../connectors/service";
import { syncConnection } from "../connectors/sync";
import { bootstrapIntake } from "../intake/service";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  connectForExecution,
  disconnectExecution,
  executionSecret,
  expectedExecutionScopes,
  listExecutionConnections,
} from "./connections";

const created: { account_id: string; profile_id: string }[] = [];

/** Drizzle wraps a Postgres error as "Failed query: …" with the real message on .cause. */
function refusalText(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

async function expectTriggerRefusal(attempt: Promise<unknown>): Promise<void> {
  let caught: unknown = null;
  try {
    await attempt;
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected the trigger to refuse the row").not.toBeNull();
  expect(refusalText(caught)).toMatch(/write-capable scope/);
}

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

const answering =
  (scopes: readonly string[]) => async (): Promise<{ granted_scopes: readonly string[] }> => ({
    granted_scopes: scopes,
  });

afterAll(async () => {
  const accountIds = created.map((s) => s.account_id);
  const profileIds = created.map((s) => s.profile_id);
  if (accountIds.length > 0) {
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, profileIds));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, profileIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
});

describe("P3-20b — connectForExecution", () => {
  it("connects with exactly the registered scopes; the secret is encrypted at rest and never returned", async () => {
    const s = await fresh();
    expect(expectedExecutionScopes("fixture")).toEqual(["write_fixture_state"]);

    const pub = await connectForExecution({
      accountId: s.account_id,
      provider: "fixture",
      secret: "fixture-write-token",
      verify: answering(["write_fixture_state"]),
    });
    expect(pub.purpose).toBe("execute");
    expect(pub.status).toBe("connected");
    expect(pub.granted_scopes).toEqual(["write_fixture_state"]);
    expect(pub.label).toBe("Fixture (in-repo)");
    expect("encrypted_secret" in pub).toBe(false);

    const [row] = await db.select().from(connections).where(eq(connections.id, pub.id));
    expect(row?.purpose).toBe("execute");
    expect(row?.encrypted_secret).not.toBeNull();
    expect(row?.encrypted_secret).not.toBe("fixture-write-token");
    expect(decryptSecret(row!.encrypted_secret!)).toBe("fixture-write-token");
    expect(executionSecret(row!)).toBe("fixture-write-token");
  });

  it("one scope too many is refused by name, and nothing is stored", async () => {
    const s = await fresh();
    await expect(
      connectForExecution({
        accountId: s.account_id,
        provider: "fixture",
        secret: "t",
        verify: answering(["write_fixture_state", "ads_read"]),
      }),
    ).rejects.toThrow(/"ads_read" which the consent does not name/);
    expect(await activeExecutionConnection(s.account_id, "fixture")).toBeNull();
  });

  it("one scope too few is refused by name, and nothing is stored", async () => {
    const s = await fresh();
    await expect(
      connectForExecution({
        accountId: s.account_id,
        provider: "fixture",
        secret: "t",
        verify: answering([]),
      }),
    ).rejects.toThrow(/missing "write_fixture_state" which the consent requires/);
    expect(await activeExecutionConnection(s.account_id, "fixture")).toBeNull();
  });

  it("an unknown provider, an empty credential and a second live connection are each refused", async () => {
    const s = await fresh();
    await expect(
      connectForExecution({
        accountId: s.account_id,
        provider: "stripe",
        secret: "t",
        verify: answering([]),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      connectForExecution({
        accountId: s.account_id,
        provider: "fixture",
        secret: "   ",
        verify: answering(["write_fixture_state"]),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await connectForExecution({
      accountId: s.account_id,
      provider: "fixture",
      secret: "t",
      verify: answering(["write_fixture_state"]),
    });
    await expect(
      connectForExecution({
        accountId: s.account_id,
        provider: "fixture",
        secret: "t",
        verify: answering(["write_fixture_state"]),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("disconnecting wipes the secret, keeps the row, and allows a reconnect; a foreign id is not found", async () => {
    const s = await fresh();
    const other = await fresh();
    const pub = await connectForExecution({
      accountId: s.account_id,
      provider: "fixture",
      secret: "t",
      verify: answering(["write_fixture_state"]),
    });
    await expect(disconnectExecution(other.account_id, pub.id)).rejects.toMatchObject({
      status: 404,
    });
    const gone = await disconnectExecution(s.account_id, pub.id);
    expect(gone.status).toBe("disconnected");
    const [row] = await db.select().from(connections).where(eq(connections.id, pub.id));
    expect(row?.encrypted_secret).toBeNull();
    expect(() => executionSecret(row!)).toThrow(ExecutionConnectionError);

    const again = await connectForExecution({
      accountId: s.account_id,
      provider: "fixture",
      secret: "t2",
      verify: answering(["write_fixture_state"]),
    });
    expect(again.id).not.toBe(pub.id);
    expect((await listExecutionConnections(s.account_id)).map((c) => c.status)).toEqual([
      "disconnected",
      "connected",
    ]);
  });
});

describe("P3-20b — the invariants", () => {
  it("a measure row can never hold a write-capable scope: the trigger mirrors isWriteCapable on a sample", async () => {
    const s = await fresh();
    const sample = [
      "write_x",
      "manage_pages",
      "read_write_log",
      "Full-Access",
      "full_access",
      "*",
      "ALL",
      "all_things",
      "admin",
      "delete_stuff",
      "ads_read",
      "read_orders",
      "https://www.googleapis.com/auth/analytics.readonly",
      // P4-15: sending is a write, on both sides of the mirror.
      "email.send_marketing",
      "send_mail",
    ];
    for (const scope of sample) {
      const attempt = db.insert(connections).values({
        account_id: s.account_id,
        provider: "fixture",
        purpose: "measure",
        status: "disconnected",
        granted_scopes: [scope],
      });
      if (isWriteCapable(scope)) {
        await expectTriggerRefusal(attempt);
      } else {
        await expect(attempt).resolves.toBeDefined();
      }
      // The same scope on an EXECUTE row is the trigger's business no more.
      await expect(
        db.insert(connections).values({
          account_id: s.account_id,
          provider: "fixture",
          purpose: "execute",
          status: "disconnected",
          granted_scopes: [scope],
        }),
      ).resolves.toBeDefined();
    }
    // An UPDATE sneaking a write scope onto a measure row is refused too.
    const [measure] = await db
      .insert(connections)
      .values({
        account_id: s.account_id,
        provider: "fixture",
        purpose: "measure",
        status: "disconnected",
        granted_scopes: ["read_revenue"],
      })
      .returning();
    await expectTriggerRefusal(
      db
        .update(connections)
        .set({ granted_scopes: ["read_revenue", "write_revenue"] })
        .where(eq(connections.id, measure!.id)),
    );
  });

  it("the measurement side never sees an execute connection", async () => {
    const s = await fresh();
    const pub = await connectForExecution({
      accountId: s.account_id,
      provider: "fixture",
      secret: "t",
      verify: answering(["write_fixture_state"]),
    });
    expect(await activeConnection(s.account_id, "fixture")).toBeNull();
    expect(await listConnections(s.account_id)).toEqual([]);
    const outcome = await syncConnection(pub.id);
    expect(outcome.skipped).toBe("not_measurement");
    expect(outcome.pages).toBe(0);
    expect(await activeExecutionConnection(s.account_id, "fixture")).not.toBeNull();
  });
});
