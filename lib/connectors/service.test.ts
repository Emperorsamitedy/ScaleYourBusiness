// P2-01 / P2-02 — the connector spine's contracts.
//
// Three promises are tested here, because all three are load-bearing for
// everything Phase 2 builds on top:
//
//   · a secret is proven and scope-checked BEFORE it is stored, and is
//     never handed back out (rules 9 and 10);
//   · disconnecting revokes locally and keeps the row — every observation
//     cites its connection for provenance (rule 2);
//   · re-ingesting a day updates it in place and never double-counts,
//     which is what makes a killed backfill safe to re-run (P2-02).

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import type { Observation } from "./provider";
import {
  FIXTURE_OVERGRANTING_SECRET,
  FIXTURE_SECRET,
  fixtureObservations,
} from "./providers/fixture";
import { decryptSecret } from "./secrets";
import {
  ConnectorError,
  ObservationError,
  canonicalDimensions,
  connect,
  disconnect,
  listConnections,
  pauseConnection,
  resumeConnection,
  toObservationRow,
  toPublicConnection,
  upsertObservations,
} from "./service";

const created: { account_id: string; profile_id: string }[] = [];

async function freshAccount(): Promise<string> {
  const s = await bootstrapIntake();
  created.push(s);
  return s.account_id;
}

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

describe("P2-01 — connecting", () => {
  it("stores the secret encrypted and never returns it", async () => {
    const accountId = await freshAccount();
    const result = await connect(accountId, "fixture", FIXTURE_SECRET);

    expect(result.provider).toBe("fixture");
    expect(result.status).toBe("connected");
    expect(result.granted_scopes).toEqual(["read_revenue", "read_orders", "read_ad_spend"]);
    // The public shape has no secret member at all — not an empty one.
    expect(Object.keys(result)).not.toContain("encrypted_secret");
    expect(JSON.stringify(result)).not.toContain(FIXTURE_SECRET);

    const [row] = await db.select().from(connections).where(eq(connections.id, result.id));
    expect(row?.encrypted_secret).toBeTruthy();
    expect(row?.encrypted_secret).not.toContain(FIXTURE_SECRET);
    // …and it is the real secret, recoverable only with the key.
    expect(decryptSecret(row?.encrypted_secret as string)).toBe(FIXTURE_SECRET);
  });

  it("REFUSES a credential whose provider grants more than the registry allows", async () => {
    const accountId = await freshAccount();
    await expect(connect(accountId, "fixture", FIXTURE_OVERGRANTING_SECRET)).rejects.toThrow(
      /write_orders/,
    );
    // Nothing was stored: a refused connect leaves no row to clean up.
    expect(await listConnections(accountId)).toEqual([]);
  });

  it("refuses an invalid credential without storing anything", async () => {
    const accountId = await freshAccount();
    await expect(connect(accountId, "fixture", "wrong")).rejects.toThrow(ConnectorError);
    expect(await listConnections(accountId)).toEqual([]);
  });

  it("refuses an unknown provider and an empty credential", async () => {
    const accountId = await freshAccount();
    await expect(connect(accountId, "not_a_provider", FIXTURE_SECRET)).rejects.toThrow(
      /unknown provider/,
    );
    await expect(connect(accountId, "fixture", "   ")).rejects.toThrow(/credential is required/);
  });

  it("refuses a second live connection for the same provider", async () => {
    const accountId = await freshAccount();
    await connect(accountId, "fixture", FIXTURE_SECRET);
    await expect(connect(accountId, "fixture", FIXTURE_SECRET)).rejects.toThrow(
      /already connected/,
    );
  });
});

describe("P2-01 — disconnecting keeps the row", () => {
  it("wipes the secret, stops sync, and preserves provenance", async () => {
    const accountId = await freshAccount();
    const conn = await connect(accountId, "fixture", FIXTURE_SECRET);

    const after = await disconnect(conn.id);
    expect(after.status).toBe("disconnected");
    expect(after.disconnected_at).toBeTruthy();

    const [row] = await db.select().from(connections).where(eq(connections.id, conn.id));
    expect(row).toBeDefined(); // the row is KEPT
    expect(row?.encrypted_secret).toBeNull(); // the credential is gone
    expect(row?.granted_scopes).toEqual(["read_revenue", "read_orders", "read_ad_spend"]);
  });

  it("allows reconnecting the same provider afterwards", async () => {
    const accountId = await freshAccount();
    const first = await connect(accountId, "fixture", FIXTURE_SECRET);
    await disconnect(first.id);
    const second = await connect(accountId, "fixture", FIXTURE_SECRET);
    expect(second.id).not.toBe(first.id);
    expect((await listConnections(accountId)).map((c) => c.status).sort()).toEqual([
      "connected",
      "disconnected",
    ]);
  });

  it("disconnecting twice is a 404, not a silent success", async () => {
    const accountId = await freshAccount();
    const conn = await connect(accountId, "fixture", FIXTURE_SECRET);
    await disconnect(conn.id);
    await expect(disconnect(conn.id)).rejects.toThrow(/not found/);
  });

  it("pause and resume move status without touching the credential", async () => {
    const accountId = await freshAccount();
    const conn = await connect(accountId, "fixture", FIXTURE_SECRET);
    expect((await pauseConnection(conn.id)).status).toBe("paused");
    await expect(pauseConnection(conn.id)).rejects.toThrow(ConnectorError);
    expect((await resumeConnection(conn.id)).status).toBe("connected");

    const [row] = await db.select().from(connections).where(eq(connections.id, conn.id));
    expect(decryptSecret(row?.encrypted_secret as string)).toBe(FIXTURE_SECRET);
  });
});

describe("P2-02 — observations", () => {
  let connectionId = "";

  beforeAll(async () => {
    const accountId = await freshAccount();
    connectionId = (await connect(accountId, "fixture", FIXTURE_SECRET)).id;
  });

  const day = (date: string) => fixtureObservations(date, "2026-09-14T00:00:00Z");

  it("re-ingesting a day upserts rather than duplicating", async () => {
    const first = await upsertObservations(connectionId, "fixture", day("2026-01-10"));
    expect(first).toBe(3);
    await upsertObservations(connectionId, "fixture", day("2026-01-10"));
    await upsertObservations(connectionId, "fixture", day("2026-01-10"));

    const rows = await db
      .select()
      .from(metricObservations)
      .where(
        and(
          eq(metricObservations.connection_id, connectionId),
          eq(metricObservations.period_date, "2026-01-10"),
        ),
      );
    expect(rows).toHaveLength(3); // three metrics, one row each — not nine
  });

  it("a corrected figure replaces the old one in place", async () => {
    const corrected: Observation[] = [
      {
        metric_key: "revenue.daily",
        period_date: "2026-01-11",
        dimensions: { currency: "EUR" },
        value_minor: 100_00,
        observed_at: "2026-09-14T00:00:00Z",
      },
    ];
    await upsertObservations(connectionId, "fixture", corrected);
    await upsertObservations(connectionId, "fixture", [
      { ...(corrected[0] as Observation), value_minor: 250_00 },
    ]);

    const rows = await db
      .select()
      .from(metricObservations)
      .where(
        and(
          eq(metricObservations.connection_id, connectionId),
          eq(metricObservations.period_date, "2026-01-11"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value_minor).toBe(250_00);
  });

  it("the same metric on different dimensions are different rows", async () => {
    await upsertObservations(connectionId, "fixture", [
      {
        metric_key: "orders.daily",
        period_date: "2026-01-12",
        dimensions: { offer_id: "offer-a" },
        value_num: 5,
        observed_at: "2026-09-14T00:00:00Z",
      },
      {
        metric_key: "orders.daily",
        period_date: "2026-01-12",
        dimensions: { offer_id: "offer-b" },
        value_num: 7,
        observed_at: "2026-09-14T00:00:00Z",
      },
    ]);
    const rows = await db
      .select()
      .from(metricObservations)
      .where(
        and(
          eq(metricObservations.connection_id, connectionId),
          eq(metricObservations.period_date, "2026-01-12"),
        ),
      );
    expect(rows).toHaveLength(2);
  });

  it("an empty batch is a no-op", async () => {
    expect(await upsertObservations(connectionId, "fixture", [])).toBe(0);
  });
});

describe("P2-02 — the shape rules money depends on (rule 1)", () => {
  const base = { period_date: "2026-01-10", observed_at: "2026-09-14T00:00:00Z" };

  it("a money metric must carry minor units and a currency", () => {
    expect(() =>
      toObservationRow("c", "fixture", {
        ...base,
        metric_key: "revenue.daily",
        dimensions: {},
        value_minor: 100,
      }),
    ).toThrow(ObservationError);
    expect(() =>
      toObservationRow("c", "fixture", {
        ...base,
        metric_key: "revenue.daily",
        dimensions: { currency: "EUR" },
        value_num: 100,
      }),
    ).toThrow(ObservationError);
    expect(() =>
      toObservationRow("c", "fixture", {
        ...base,
        metric_key: "revenue.daily",
        dimensions: { currency: "EUR" },
        value_minor: 10.5,
      }),
    ).toThrow(/safe integer/);
  });

  it("a count metric must not pretend to be money", () => {
    expect(() =>
      toObservationRow("c", "fixture", {
        ...base,
        metric_key: "orders.daily",
        dimensions: { currency: "EUR" },
        value_num: 3,
      }),
    ).toThrow(ObservationError);
    expect(() =>
      toObservationRow("c", "fixture", {
        ...base,
        metric_key: "orders.daily",
        dimensions: {},
        value_minor: 3,
      }),
    ).toThrow(ObservationError);
  });

  it("rejects an unknown metric key", () => {
    expect(() =>
      toObservationRow("c", "fixture", {
        ...base,
        metric_key: "revenue.hourly" as never,
        dimensions: {},
        value_num: 1,
      }),
    ).toThrow(ObservationError);
  });

  it("the dimension key is stable regardless of property order", () => {
    expect(canonicalDimensions({ currency: "EUR", offer_id: "a" })).toBe(
      canonicalDimensions({ offer_id: "a", currency: "EUR" }),
    );
    // Absent and empty must not become two different rows for one series.
    expect(canonicalDimensions({})).toBe(canonicalDimensions({ offer_id: "" }));
  });
});

describe("toPublicConnection", () => {
  it("is an explicit field list, so a new column cannot leak by default", async () => {
    const accountId = await freshAccount();
    const conn = await connect(accountId, "fixture", FIXTURE_SECRET);
    const [row] = await db.select().from(connections).where(eq(connections.id, conn.id));
    const shape = Object.keys(toPublicConnection(row as typeof connections.$inferSelect)).sort();
    expect(shape).toEqual([
      "account_id",
      "created_at",
      "cursor",
      "disconnected_at",
      "failure_count",
      "granted_scopes",
      "id",
      "label",
      "last_error",
      "last_sync_at",
      "provider",
      "purpose",
      "scope_verification",
      "status",
    ]);
  });
});
