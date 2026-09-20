// P2-12 — the connections API's guarantees, below the route handlers.
//
// The API only ever acts on a connection through ownedConnection, so these
// tests are the access control for connecting a payment account: an account
// reaches its own connections and nobody else's, and another account's
// connection is "not found" rather than "forbidden", with nothing to
// enumerate. The public shape also says how far a connection's scopes can
// be trusted, which the screen renders in words.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  connectorSyncs,
  fieldRecords,
  metricObservations,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { FIXTURE_SECRET } from "./providers/fixture";
import { createStripeProvider } from "./providers/stripe";
import { FAKE_STRIPE_KEY, fakeStripe } from "./providers/stripe-fake";
import { overrideProviderForTests } from "./registry";
import { connect, disconnectForAccount, listConnections, ownedConnection } from "./service";

const created: { account_id: string; profile_id: string }[] = [];
let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

afterAll(async () => {
  for (const s of created) {
    const rows = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    for (const { id } of rows) {
      await db.delete(metricObservations).where(eq(metricObservations.connection_id, id));
      await db.delete(connectorSyncs).where(eq(connectorSyncs.connection_id, id));
    }
    await db.delete(connections).where(eq(connections.account_id, s.account_id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

async function freshAccount(): Promise<string> {
  const s = await bootstrapIntake();
  created.push(s);
  return s.account_id;
}

describe("P2-12 — ownership", () => {
  it("an account reaches its own connection and nobody else's", async () => {
    const owner = await freshAccount();
    const stranger = await freshAccount();
    const conn = await connect(owner, "fixture", FIXTURE_SECRET);

    expect((await ownedConnection(owner, conn.id)).id).toBe(conn.id);
    await expect(ownedConnection(stranger, conn.id)).rejects.toMatchObject({
      status: 404,
      message: "connection not found",
    });
  });

  it("a malformed id is simply not found, not a database error", async () => {
    const owner = await freshAccount();
    await expect(ownedConnection(owner, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
  });

  it("disconnecting another account's connection fails and leaves it connected", async () => {
    const owner = await freshAccount();
    const stranger = await freshAccount();
    const conn = await connect(owner, "fixture", FIXTURE_SECRET);

    await expect(disconnectForAccount(stranger, conn.id)).rejects.toMatchObject({ status: 404 });
    expect((await listConnections(owner))[0]?.status).toBe("connected");

    expect((await disconnectForAccount(owner, conn.id)).status).toBe("disconnected");
  });
});

describe("P2-12 — what the screen is told", () => {
  it("names the provider and says how far its scopes can be trusted", async () => {
    const fixtureAccount = await freshAccount();
    expect(await connect(fixtureAccount, "fixture", FIXTURE_SECRET)).toMatchObject({
      label: "Fixture",
      scope_verification: "reported",
    });

    restore = overrideProviderForTests(
      "stripe",
      createStripeProvider({ fetch: fakeStripe([]).fetch, sleep: async () => {} }),
    );
    const stripeAccount = await freshAccount();
    expect(await connect(stripeAccount, "stripe", FAKE_STRIPE_KEY)).toMatchObject({
      label: "Stripe",
      scope_verification: "probed",
      granted_scopes: ["read_balance_transactions"],
    });
  });

  it("refuses a full-access Stripe key without storing anything", async () => {
    restore = overrideProviderForTests(
      "stripe",
      createStripeProvider({ fetch: fakeStripe([]).fetch, sleep: async () => {} }),
    );
    const account = await freshAccount();
    await expect(connect(account, "stripe", "sk_live_51Dangerous")).rejects.toThrow(
      /full-access secret key/,
    );
    expect(await listConnections(account)).toEqual([]);
  });
});
