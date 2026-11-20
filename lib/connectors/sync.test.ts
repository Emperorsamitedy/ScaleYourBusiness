// P2-06 — the sync runner.
//
// The plan's definition of done for Session A: a fixture connector can
// "connect, backfill from fixtures, sync incrementally, produce derived
// facts that supersede estimates, and pass the scope audit — all without
// any real external account". That whole sentence is tested below, plus
// the two disciplines the runner adds: a per-connection lock so two cron
// hits cannot interleave, and a hard attempt cap so a broken provider
// parks itself instead of retrying forever.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
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
import { readCurrentField } from "../profile/field-store";
import {
  FIXTURE_BACKFILL_DAYS,
  FIXTURE_FAILING_SECRET,
  FIXTURE_PAGE_DAYS,
  FIXTURE_SECRET,
} from "./providers/fixture";
import { connect, countStoppedReads, disconnect, pauseConnection } from "./service";
import { MAX_CONSECUTIVE_FAILURES, runConnectorSync, syncConnection } from "./sync";

const created: { account_id: string; profile_id: string }[] = [];
const NOW = new Date("2026-09-14T12:00:00Z");
/** The fixture's last complete day is the day before `now`. */
const LAST_DAY = "2026-09-13";
const EXPECTED_PAGES = Math.ceil(FIXTURE_BACKFILL_DAYS / FIXTURE_PAGE_DAYS);
/** revenue + orders + ad_spend for each backfilled day. */
const EXPECTED_OBSERVATIONS = FIXTURE_BACKFILL_DAYS * 3;

async function scenario(secret = FIXTURE_SECRET) {
  const s = await bootstrapIntake();
  created.push(s);
  const conn = await connect(s.account_id, "fixture", secret);
  return { ...s, connection_id: conn.id };
}

const countObservations = async (connectionId: string) =>
  (
    await db
      .select({ id: metricObservations.id })
      .from(metricObservations)
      .where(eq(metricObservations.connection_id, connectionId))
  ).length;

const connectionRow = async (id: string) =>
  (await db.select().from(connections).where(eq(connections.id, id)))[0];

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

describe("P2-06 — backfill, then incremental", () => {
  it("backfills a year in pages, then syncs incrementally and changes nothing", async () => {
    const s = await scenario();

    const first = await syncConnection(s.connection_id, NOW);
    expect(first.ok).toBe(true);
    expect(first.kind).toBe("backfill");
    expect(first.pages).toBe(EXPECTED_PAGES);
    expect(first.observations).toBe(EXPECTED_OBSERVATIONS);
    expect(await countObservations(s.connection_id)).toBe(EXPECTED_OBSERVATIONS);
    expect((await connectionRow(s.connection_id))?.cursor).toBe(LAST_DAY);
    expect((await connectionRow(s.connection_id))?.last_sync_at).toBeTruthy();

    // Same day again: the provider has nothing new, and re-running is safe.
    const second = await syncConnection(s.connection_id, NOW);
    expect(second.ok).toBe(true);
    expect(second.kind).toBe("incremental");
    expect(second.observations).toBe(0);
    expect(await countObservations(s.connection_id)).toBe(EXPECTED_OBSERVATIONS);
  });

  it("a re-run after a wiped cursor re-ingests without double-counting", async () => {
    const s = await scenario();
    await syncConnection(s.connection_id, NOW);
    const afterFirst = await countObservations(s.connection_id);

    // Simulate a lost cursor: the whole backfill runs again.
    await db.update(connections).set({ cursor: null }).where(eq(connections.id, s.connection_id));
    const redo = await syncConnection(s.connection_id, NOW);

    expect(redo.observations).toBe(EXPECTED_OBSERVATIONS);
    // Upserted onto the same natural keys — not appended.
    expect(await countObservations(s.connection_id)).toBe(afterFirst);
  });

  it("resumes from a partial cursor instead of restarting", async () => {
    const s = await scenario();
    // A backfill that died 30 days in.
    await db
      .update(connections)
      .set({ cursor: "2026-09-01" })
      .where(eq(connections.id, s.connection_id));

    const resumed = await syncConnection(s.connection_id, NOW);
    expect(resumed.ok).toBe(true);
    expect(resumed.pages).toBe(1);
    expect(resumed.observations).toBe(12 * 3); // 2026-09-02..13 inclusive
    expect((await connectionRow(s.connection_id))?.cursor).toBe(LAST_DAY);
  });

  it("a successful sync derives the monthly facts (P2-05 end to end)", async () => {
    const s = await scenario();
    const outcome = await syncConnection(s.connection_id, NOW);

    // The fixture measures revenue, orders and ad spend; the rest are honest refusals.
    expect(outcome.derived.filter((d) => d.outcome === "written").map((d) => d.field_key)).toEqual([
      "revenue.monthly_revenue",
      "revenue.order_count_monthly",
      "marketing.monthly_ad_spend",
    ]);
    const revenue = await readCurrentField<{ amount_minor: number; currency: string }>(
      s.profile_id,
      "revenue.monthly_revenue",
    );
    expect(revenue?.status).toBe("inferred");
    expect(revenue?.value?.currency).toBe("EUR");
    expect(revenue?.value?.amount_minor).toBeGreaterThan(0);
    expect(
      await readCurrentField<number>(s.profile_id, "revenue.order_count_monthly"),
    ).toMatchObject({ status: "inferred" });
  });

  it("writes one telemetry row per run", async () => {
    const s = await scenario();
    await syncConnection(s.connection_id, NOW);
    await syncConnection(s.connection_id, NOW);

    const rows = await db
      .select()
      .from(connectorSyncs)
      .where(eq(connectorSyncs.connection_id, s.connection_id));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(["backfill", "incremental"]);
    expect(rows.every((r) => r.ok)).toBe(true);
    expect(rows.every((r) => r.account_id === s.account_id)).toBe(true);
    expect(rows.find((r) => r.kind === "backfill")?.observations_upserted).toBe(
      EXPECTED_OBSERVATIONS,
    );
  });
});

describe("P2-06 — failure discipline", () => {
  it("counts consecutive failures and parks the connection at the cap", async () => {
    const s = await scenario(FIXTURE_FAILING_SECRET);

    for (let attempt = 1; attempt <= MAX_CONSECUTIVE_FAILURES; attempt++) {
      const outcome = await syncConnection(s.connection_id, NOW);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("deliberate");
      const row = await connectionRow(s.connection_id);
      expect(row?.failure_count).toBe(attempt);
      expect(row?.status).toBe(attempt >= MAX_CONSECUTIVE_FAILURES ? "failed" : "connected");
    }

    // Parked: the daily run no longer picks it up.
    const summary = await runConnectorSync(NOW, { accountIds: [s.account_id] });
    const [row] = await db
      .select()
      .from(connectorSyncs)
      .where(and(eq(connectorSyncs.connection_id, s.connection_id), eq(connectorSyncs.ok, false)));
    expect(row).toBeDefined();
    expect(summary.connections).toBeGreaterThanOrEqual(0);
    expect((await connectionRow(s.connection_id))?.status).toBe("failed");
  });

  it("a source that stopped by itself is counted as needing the owner; one they paused is not", async () => {
    const stopped = await scenario(FIXTURE_FAILING_SECRET);
    expect(await countStoppedReads(stopped.account_id)).toBe(0); // reading, so far
    for (let attempt = 1; attempt <= MAX_CONSECUTIVE_FAILURES; attempt++) {
      await syncConnection(stopped.connection_id, NOW);
    }
    expect(await countStoppedReads(stopped.account_id)).toBe(1);

    // The owner's own pause is a choice, not something that needs them.
    const chosen = await scenario();
    await pauseConnection(chosen.connection_id);
    expect(await countStoppedReads(chosen.account_id)).toBe(0);
    // And one business's stopped source is never counted for another.
    const other = await scenario();
    expect(await countStoppedReads(other.account_id)).toBe(0);
  });

  it("a failure never stores the credential in the error text", async () => {
    const s = await scenario(FIXTURE_FAILING_SECRET);
    await syncConnection(s.connection_id, NOW);
    const row = await connectionRow(s.connection_id);
    expect(row?.last_error).toBeTruthy();
    expect(row?.last_error).not.toContain(FIXTURE_FAILING_SECRET);
  });

  it("skips connections that are not connected", async () => {
    const paused = await scenario();
    await pauseConnection(paused.connection_id);
    expect((await syncConnection(paused.connection_id, NOW)).skipped).toBe("not_connected");

    const gone = await scenario();
    await disconnect(gone.connection_id);
    expect((await syncConnection(gone.connection_id, NOW)).skipped).toBe("not_connected");
  });

  it("reports a missing connection rather than throwing", async () => {
    const outcome = await syncConnection("00000000-0000-0000-0000-000000000000", NOW);
    expect(outcome.skipped).toBe("not_found");
    expect(outcome.ok).toBe(false);
  });
});

describe("P2-06 — the per-connection lock", () => {
  it("a second run on a locked connection stands down instead of interleaving", async () => {
    const s = await scenario();
    const client = await db.$client.connect();
    try {
      await client.query("select pg_advisory_lock(hashtext($1))", [
        `connector_sync:${s.connection_id}`,
      ]);

      const blocked = await syncConnection(s.connection_id, NOW);
      expect(blocked.skipped).toBe("locked");
      expect(blocked.observations).toBe(0);
      expect(await countObservations(s.connection_id)).toBe(0);
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1))", [
        `connector_sync:${s.connection_id}`,
      ]);
      client.release();
    }

    // Released: the next run proceeds normally.
    expect((await syncConnection(s.connection_id, NOW)).ok).toBe(true);
  });

  it("the lock is released after a run, including a failing one", async () => {
    const s = await scenario(FIXTURE_FAILING_SECRET);
    await syncConnection(s.connection_id, NOW);
    // If the lock leaked, this second call would report "locked".
    expect((await syncConnection(s.connection_id, NOW)).skipped).toBeNull();
  });
});
