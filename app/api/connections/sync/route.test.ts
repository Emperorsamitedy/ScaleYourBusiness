// POST /api/connections/sync through the real door (only next/headers'
// cookie jar is stood in), with the fixture connector: no external account.
// What must hold: asked for lines, the read's progress arrives as it lands
// and ends with the summary; asked plainly, the answer is what it always
// was; and who may ask is decided before the first line either way.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "../../../../db";
import {
  accounts,
  authSessions,
  businessProfiles,
  connections,
  connectorSyncs,
  fieldRecords,
  intakeEvents,
  metricObservations,
  users,
  watchActivity,
} from "../../../../db/schema";
import { AUTH_COOKIE } from "../../../../lib/auth/access";
import type { Role } from "../../../../lib/auth/roles";
import { openSession } from "../../../../lib/auth/service";
import {
  FIXTURE_BACKFILL_DAYS,
  FIXTURE_PAGE_DAYS,
  FIXTURE_SECRET,
} from "../../../../lib/connectors/providers/fixture";
import { connect } from "../../../../lib/connectors/service";
import type { SyncLine } from "../../../../lib/connectors/sync-stream";
import { SYNC_STREAM_TYPE, readSyncStream } from "../../../../lib/connectors/sync-stream";
import { bootstrapIntake } from "../../../../lib/intake/service";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) as string } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => jar.has(name),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers(),
}));

const { POST } = await import("./route");

const PAGES = Math.ceil(FIXTURE_BACKFILL_DAYS / FIXTURE_PAGE_DAYS);
const FIGURES = FIXTURE_BACKFILL_DAYS * 3;
const created: { account_id: string; profile_id: string }[] = [];

/**
 * A business with a connected fixture source and a member of this role signed
 * in. An account always keeps an owner, so anyone else joins one.
 */
async function business(role: Role = "owner") {
  const s = await bootstrapIntake();
  created.push(s);
  const conn = await connect(s.account_id, "fixture", FIXTURE_SECRET);
  const join = async (as: Role) => {
    const [u] = await db
      .insert(users)
      .values({
        account_id: s.account_id,
        email: `sync-${crypto.randomUUID().slice(0, 8)}@test.local`,
        display_name: "Sync route",
        role: as,
      })
      .returning();
    if (!u) throw new Error("fixture user");
    return u;
  };
  const owner = await join("owner");
  const member = role === "owner" ? owner : await join(role);
  return { ...s, connection_id: conn.id, token: (await openSession(member)).session_token };
}

function signIn(token: string | null) {
  jar.clear();
  if (token) jar.set(AUTH_COOKIE, token);
}

const ask = (id: unknown, lines: boolean) =>
  POST(
    new NextRequest("http://localhost:3000/api/connections/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(lines ? { accept: SYNC_STREAM_TYPE } : {}),
      },
      body: JSON.stringify({ id }),
    }),
  );

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
    await db.delete(watchActivity).where(eq(watchActivity.profile_id, s.profile_id));
    await db.delete(authSessions).where(eq(authSessions.account_id, s.account_id));
    await db.delete(users).where(eq(users.account_id, s.account_id));
    await db.delete(intakeEvents).where(eq(intakeEvents.profile_id, s.profile_id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("a read's progress, asked for as lines", () => {
  it("sends each page as it lands and ends with the summary", async () => {
    const b = await business();
    signIn(b.token);
    const res = await ask(b.connection_id, true);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(SYNC_STREAM_TYPE);
    expect(res.headers.get("cache-control")).toContain("no-store");

    const lines: SyncLine[] = [];
    await readSyncStream(res.body as ReadableStream<Uint8Array>, (line) => lines.push(line));
    const reading = lines.filter((l) => l.type === "progress" && l.step === "reading");
    expect(reading).toHaveLength(PAGES);
    expect(lines.at(-2)).toEqual({
      type: "progress",
      step: "working",
      pages: PAGES,
      observations: FIGURES,
    });
    expect(lines.at(-1)).toMatchObject({
      type: "done",
      ok: true,
      skipped: null,
      kind: "backfill",
      pages: PAGES,
      error: null,
    });
    // Counts and our own words only: nothing of the source's is in a line.
    const text = JSON.stringify(lines);
    expect(text).not.toContain(FIXTURE_SECRET);
    for (const l of lines) {
      expect(Object.keys(l).sort().join(",")).toMatch(
        /^(observations,pages,step,type|error,kind,observations,ok,pages,skipped,type)$/,
      );
    }
  }, 60_000);

  it("answers a plain request exactly as before", async () => {
    const b = await business();
    signIn(b.token);
    const res = await ask(b.connection_id, false);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({
      ok: true,
      skipped: null,
      kind: "backfill",
      pages: PAGES,
      observations: expect.any(Number),
      error: null,
    });
  }, 60_000);
});

describe("who may ask is decided before the first line", () => {
  it("refuses a visitor, a viewer, another business's source and a request with no id, as plain answers", async () => {
    const mine = await business();
    const theirs = await business();

    signIn(null);
    const out = await ask(mine.connection_id, true);
    expect(out.status).toBe(401);
    expect(out.headers.get("content-type")).toContain("application/json");

    const viewer = await business("viewer");
    signIn(viewer.token);
    const denied = await ask(viewer.connection_id, true);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain("application/json");

    signIn(mine.token);
    const foreign = await ask(theirs.connection_id, true);
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("content-type")).toContain("application/json");
    expect((await ask(undefined, true)).status).toBe(422);

    // Nothing was read for any of them.
    for (const id of [mine.connection_id, theirs.connection_id, viewer.connection_id]) {
      const [row] = await db.select().from(connections).where(eq(connections.id, id));
      expect(row?.last_sync_at).toBeNull();
    }
  }, 60_000);
});
