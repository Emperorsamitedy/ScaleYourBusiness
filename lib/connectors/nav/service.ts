// NAV Online Számla for one business — connect, sync, degrade, revoke (the
// multi-market spec §E.4–§E.6).
//
// connectNav proves the technical user at once with queryTaxpayer and hands
// back the business's own registered name, then stores the credentials
// sealed under the account's own key (./vault.ts). syncNav reads both
// directions into the same observations table every connector feeds, so
// the diagnosis sees revenue and cost without knowing they came from NAV.
// A technical user NAV stops accepting marks the connection failed with a
// plain Hungarian reconnect message: figures fall back to what else is
// known, nothing is blanked. revokeNav wipes the stored credentials at once
// and says, in Hungarian, to delete the technical user on NAV's side too.
//
// Nothing here can reach NAV until NAV_SOFTWARE_ID is configured, which
// waits on counsel (specs/nav-online-szamla-v3.md).

import { and, eq, ne } from "drizzle-orm";
import { db } from "../../../db";
import { connections } from "../../../db/schema";
import type { NormalisedEvent } from "../contract";
import type { Observation } from "../provider";
import { demoteOnConnectorFailure } from "../../ladder/connector-health";
import { upsertObservations } from "../service";
import type { NavConnector, NavTransport } from "./connector";
import { NAV_CONNECTOR, NAV_WORDS, NavConnectorError, navConnector } from "./connector";
import type { NavCredentials, NavSoftware } from "./protocol";
import { NAV_OPERATIONS, validateSoftware } from "./protocol";
import { sealNavCredentials, withNavCredentials } from "./vault";

type Env = Readonly<Record<string, string | undefined>>;

/** The months a first sync reads back. */
export const NAV_BACKFILL_MONTHS = 12;
/** Consecutive failed syncs before the connection is marked failed. */
export const NAV_MAX_FAILURES = 3;

export const NAV_SERVICE_WORDS = {
  notConfigured: {
    en: "Connecting NAV isn't available yet.",
    hu: "A NAV-kapcsolat még nem érhető el.",
  },
  alreadyConnected: {
    en: "NAV is already connected for this business — disconnect it first.",
    hu: "A NAV már kapcsolódik ehhez a vállalkozáshoz — előbb bontsa a kapcsolatot.",
  },
  revoked: {
    en: "SYB has deleted your NAV technical user's details. Now delete the technical user in Online Számla too, so it can't be used again.",
    hu: "A SYB törölte a NAV technikai felhasználó adatait. Most törölje a technikai felhasználót az Online Számlában is, hogy többé ne lehessen használni.",
  },
  degraded: {
    en: "NAV stopped accepting the technical user. Figures from NAV are paused; reconnect it in Connections.",
    hu: "A NAV nem fogadja el többé a technikai felhasználót. A NAV-ból származó adatok szünetelnek; csatlakoztassa újra a Kapcsolatok oldalon.",
  },
} as const;

export class NavServiceError extends Error {
  readonly hu: string;
  readonly status: number;
  constructor(w: { en: string; hu: string }, status: number) {
    super(w.en);
    this.name = "NavServiceError";
    this.hu = w.hu;
    this.status = status;
  }
}

/** SYB's identity as calling software, from configuration — or null while it isn't set. */
export function navSoftwareFromEnv(env: Env = process.env): NavSoftware | null {
  const id = env.NAV_SOFTWARE_ID?.trim() ?? "";
  if (id === "") return null;
  const country = env.NAV_SOFTWARE_DEV_COUNTRY?.trim() ?? "";
  const tax = env.NAV_SOFTWARE_DEV_TAX_NUMBER?.trim() ?? "";
  return validateSoftware({
    softwareId: id,
    softwareName: "SYB",
    softwareOperation: "ONLINE_SERVICE",
    softwareMainVersion: "1.0",
    softwareDevName: env.NAV_SOFTWARE_DEV_NAME?.trim() || "SYB",
    softwareDevContact: env.NAV_SOFTWARE_DEV_CONTACT?.trim() ?? "",
    ...(country ? { softwareDevCountryCode: country } : {}),
    ...(tax ? { softwareDevTaxNumber: tax } : {}),
  });
}

export function navEnvironment(env: Env = process.env): "test" | "prod" {
  return env.NAV_ENVIRONMENT === "prod" ? "prod" : "test";
}

/** A plain POST of XML: the only network path NAV has. */
export const fetchTransport: NavTransport = async (url, xml) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/xml", accept: "application/xml" },
    body: xml,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, text: await res.text() };
};

export interface NavDeps {
  software?: NavSoftware | null;
  transport?: NavTransport;
  environment?: "test" | "prod";
  master?: Buffer;
  now?: () => Date;
}

function connectorFor(
  accountId: string,
  blob: string,
  deps: NavDeps,
  connection?: { status: string; last_sync_at: string | null; failure_count: number },
): NavConnector {
  const software = deps.software === undefined ? navSoftwareFromEnv() : deps.software;
  if (!software) throw new NavServiceError(NAV_SERVICE_WORDS.notConfigured, 503);
  return navConnector({
    withCredentials: (work) => withNavCredentials(accountId, blob, work, deps.master),
    software,
    environment: deps.environment ?? navEnvironment(),
    transport: deps.transport ?? fetchTransport,
    ...(deps.now ? { now: deps.now } : {}),
    ...(connection ? { connection } : {}),
  });
}

async function activeNav(accountId: string) {
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.provider, NAV_CONNECTOR),
        ne(connections.status, "disconnected"),
      ),
    );
  return row ?? null;
}

/** §E.4: prove the technical user, show the business its own name, store sealed. */
export async function connectNav(
  accountId: string,
  credentials: NavCredentials,
  deps: NavDeps = {},
): Promise<{ connection_id: string; taxpayer_name: string | null }> {
  for (const k of ["login", "password", "signatureKey", "taxNumber"] as const) {
    if (typeof credentials[k] !== "string" || credentials[k].trim() === "") {
      throw new NavServiceError(NAV_WORDS.rejected, 422);
    }
  }
  const creds = { ...credentials, taxNumber: credentials.taxNumber.replace(/\D/g, "").slice(0, 8) };
  if (await activeNav(accountId)) {
    throw new NavServiceError(NAV_SERVICE_WORDS.alreadyConnected, 409);
  }
  const blob = sealNavCredentials(accountId, creds, deps.master);
  const c = connectorFor(accountId, blob, deps);
  const auth = await c.authorize();
  if (!auth.ok) throw new NavServiceError(NAV_WORDS.rejected, 400);
  const [row] = await db
    .insert(connections)
    .values({
      account_id: accountId,
      provider: NAV_CONNECTOR,
      purpose: "measure",
      status: "connected",
      encrypted_secret: blob,
      granted_scopes: [...NAV_OPERATIONS],
    })
    .returning({ id: connections.id });
  return { connection_id: row!.id, taxpayer_name: c.taxpayer()?.name ?? null };
}

function toObservation(e: NormalisedEvent): Observation {
  return {
    metric_key: e.metric,
    period_date: e.day,
    dimensions: e.dimensions,
    ...(e.amount ? { value_minor: e.amount.amount_minor } : { value_num: e.quantity ?? 0 }),
    observed_at: e.observed_at,
  };
}

/**
 * Read issuer- and buyer-side invoices since the last sync (a year back on
 * the first) into observations. A failure counts; a rejected technical user,
 * or NAV_MAX_FAILURES in a row, marks the connection failed with the
 * Hungarian reconnect message (§E.6).
 */
export async function syncNav(
  connectionId: string,
  deps: NavDeps = {},
): Promise<{ observations: number } | { failed: true; message_hu: string }> {
  const [row] = await db.select().from(connections).where(eq(connections.id, connectionId));
  if (
    !row ||
    row.provider !== NAV_CONNECTOR ||
    row.status !== "connected" ||
    !row.encrypted_secret
  ) {
    throw new NavServiceError(NAV_WORDS.rejected, 404);
  }
  const now = deps.now?.() ?? new Date();
  const since = row.last_sync_at
    ? new Date(Date.parse(row.last_sync_at) - 3 * 86_400_000).toISOString().slice(0, 10)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - NAV_BACKFILL_MONTHS, 1))
        .toISOString()
        .slice(0, 10);
  const c = connectorFor(row.account_id, row.encrypted_secret, deps, row);
  try {
    const events = await c.pull(since);
    const n = await upsertObservations(row.id, NAV_CONNECTOR, events.map(toObservation));
    await db
      .update(connections)
      .set({ last_sync_at: now.toISOString(), failure_count: 0, last_error: null })
      .where(eq(connections.id, row.id));
    return { observations: n };
  } catch (error) {
    if (!(error instanceof NavConnectorError)) throw error;
    const failures = row.failure_count + 1;
    const failed = failures >= NAV_MAX_FAILURES || error.hu === NAV_WORDS.rejected.hu;
    const message = failed ? NAV_SERVICE_WORDS.degraded.hu : error.hu;
    await db
      .update(connections)
      .set({
        failure_count: failures,
        last_error: message,
        ...(failed ? { status: "failed" as const } : {}),
      })
      .where(eq(connections.id, row.id));
    // The v1 spec §11.2: what depended on NAV drops to station 1, the owner told.
    if (failed)
      await demoteOnConnectorFailure({ accountId: row.account_id, provider: NAV_CONNECTOR });
    return { failed: true, message_hu: message };
  }
}

/**
 * §E.5's one-tap revocation: the stored credentials are deleted now, in this
 * call — well inside 60 seconds — and the owner is told, in Hungarian, to
 * delete the technical user on NAV's side too. The row stays as provenance
 * for what it already read.
 */
export async function revokeNav(
  accountId: string,
): Promise<{ revoked: boolean; message_hu: string; message_en: string }> {
  const rows = await db
    .update(connections)
    .set({
      status: "disconnected",
      encrypted_secret: null,
      disconnected_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.provider, NAV_CONNECTOR),
        ne(connections.status, "disconnected"),
      ),
    )
    .returning({ id: connections.id });
  return {
    revoked: rows.length > 0,
    message_hu: NAV_SERVICE_WORDS.revoked.hu,
    message_en: NAV_SERVICE_WORDS.revoked.en,
  };
}

/** The nightly run: every connected NAV connection, one at a time; none while SYB isn't configured. */
export async function runNavSync(
  deps: NavDeps = {},
): Promise<{ connections: number; synced: number; failed: number; skipped?: "not_configured" }> {
  const software = deps.software === undefined ? navSoftwareFromEnv() : deps.software;
  if (!software) return { connections: 0, synced: 0, failed: 0, skipped: "not_configured" };
  const rows = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.provider, NAV_CONNECTOR), eq(connections.status, "connected")));
  let synced = 0;
  let failed = 0;
  for (const r of rows) {
    const result = await syncNav(r.id, { ...deps, software });
    if ("failed" in result) failed += 1;
    else synced += 1;
  }
  return { connections: rows.length, synced, failed };
}
