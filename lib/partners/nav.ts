// NAV Online Számla across a firm's client book — the multi-market spec
// §E.4's bookkeeper path: "a firm can set this up across its whole client
// book from the Partner Console (§7.6), under an active mandate."
//
// Nothing new happens to a credential here. Each client goes through the
// same door an owner uses (lib/connectors/nav/service connectNav): validated
// at once with queryTaxpayer, the registered name handed back, sealed under
// that business's own key, read-only operations only. What this adds is the
// walk across the book:
//
//   - a principal or manager runs it (requireFirm), never staff
//   - each client is asked of the database's partner_may with
//     manage_connectors at that moment; without it the client is "not
//     found" and nothing is stored for it
//   - each client's NAV attempts share the owner's own hourly limit, so a
//     firm can't try more passwords against a business than its owner could
//   - one client's failure is that client's outcome; the rest carry on
//   - each connection and each revocation goes in the owner's audit trail as
//     the partner's own action
//
// Credentials are never logged and never answered: an outcome is a fixed
// code, a failure's log line names the account and the error's class only.

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, connections, fieldRecords } from "../../db/schema";
import { withinRateLimit } from "../core/rate-limit";
import { NAV_CONNECTOR } from "../connectors/nav/connector";
import type { NavDeps } from "../connectors/nav/service";
import { NavServiceError, connectNav, revokeNav } from "../connectors/nav/service";
import { PartnerAccessError, logPartnerAction, partnerClients, partnerMay } from "./access";
import { requireFirm } from "./firm";

/** A book is at most this many clients in one run (§7.7's book of 200). */
export const NAV_BULK_MAX = 200;
/** The owner's own route allows this many NAV attempts an hour per business; a firm shares it. */
export const NAV_CONNECT_LIMIT_PER_HOUR = 5;

export type NavBulkOutcome =
  | "connected"
  | "skipped"
  | "not_found"
  | "already_connected"
  | "rejected"
  | "not_configured"
  | "rate_limited"
  | "failed";

export interface NavBulkRow {
  client: string;
  login: string;
  password: string;
  signatureKey: string;
  taxNumber: string;
}

export interface NavBulkResult {
  client: string;
  outcome: NavBulkOutcome;
  taxpayer_name?: string | null;
}

export class NavBulkError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "NavBulkError";
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const blank = (s: string) => s.trim() === "";

function outcomeOf(error: NavServiceError): NavBulkOutcome {
  if (error.status === 409) return "already_connected";
  if (error.status === 503) return "not_configured";
  return "rejected";
}

async function accountOf(profileId: string): Promise<string | null> {
  const [p] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return p?.account_id ?? null;
}

/**
 * Connect NAV for each row's client, in order, one at a time. A row with
 * every field blank is skipped (the console sends the whole book); a row
 * with some fields missing is NAV's to refuse, as for an owner.
 */
export async function bulkConnectNav(args: {
  userId: string;
  rows: readonly NavBulkRow[];
  deps?: NavDeps;
}): Promise<{ results: NavBulkResult[] } & Record<NavBulkOutcome, number>> {
  const { firm } = await requireFirm(args.userId, ["principal", "manager"]);
  if (args.rows.length > NAV_BULK_MAX)
    throw new NavBulkError(`at most ${NAV_BULK_MAX} clients in one go`);
  const seen = new Set<string>();
  const results: NavBulkResult[] = [];
  for (const row of args.rows) {
    const client = String(row.client);
    const one = (outcome: NavBulkOutcome, extra: Partial<NavBulkResult> = {}) =>
      results.push({ client, outcome, ...extra });
    if (
      blank(row.login) &&
      blank(row.password) &&
      blank(row.signatureKey) &&
      blank(row.taxNumber)
    ) {
      one("skipped");
      continue;
    }
    // A malformed id, a repeat, or a client without the mandate: all "not found".
    if (!UUID.test(client) || seen.has(client)) {
      one("not_found");
      continue;
    }
    seen.add(client);
    if (!(await partnerMay(args.userId, client, "manage_connectors"))) {
      one("not_found");
      continue;
    }
    const accountId = await accountOf(client);
    if (!accountId) {
      one("not_found");
      continue;
    }
    if (
      !(await withinRateLimit(`nav-connect:${accountId}`, NAV_CONNECT_LIMIT_PER_HOUR, 3_600_000))
    ) {
      one("rate_limited");
      continue;
    }
    try {
      const r = await connectNav(
        accountId,
        {
          login: row.login,
          password: row.password,
          signatureKey: row.signatureKey,
          taxNumber: row.taxNumber,
        },
        args.deps,
      );
      await logPartnerAction({
        profileId: client,
        userId: args.userId,
        firmId: firm.id,
        action: "nav_connect",
        ref: r.connection_id,
      });
      one("connected", { taxpayer_name: r.taxpayer_name });
    } catch (error) {
      if (error instanceof NavServiceError) {
        one(outcomeOf(error));
        continue;
      }
      console.error(
        JSON.stringify({
          event: "partner_nav_connect_failed",
          account_id: accountId,
          name: error instanceof Error ? error.name : "unknown",
        }),
      );
      one("failed");
    }
  }
  const counts = Object.fromEntries(
    (
      [
        "connected",
        "skipped",
        "not_found",
        "already_connected",
        "rejected",
        "not_configured",
        "rate_limited",
        "failed",
      ] as const
    ).map((o) => [o, results.filter((r) => r.outcome === o).length]),
  ) as Record<NavBulkOutcome, number>;
  return { results, ...counts };
}

/** §E.5 from the console: one tap wipes a client's stored NAV credentials, under the mandate. */
export async function revokeNavForClient(args: { userId: string; profileId: string }) {
  const { firm } = await requireFirm(args.userId, ["principal", "manager"]);
  if (
    !UUID.test(args.profileId) ||
    !(await partnerMay(args.userId, args.profileId, "manage_connectors"))
  )
    throw new PartnerAccessError();
  const accountId = await accountOf(args.profileId);
  if (!accountId) throw new PartnerAccessError();
  const r = await revokeNav(accountId);
  if (r.revoked) {
    await logPartnerAction({
      profileId: args.profileId,
      userId: args.userId,
      firmId: firm.id,
      action: "nav_revoke",
      ref: accountId,
    });
  }
  return r;
}

export type NavState = "connected" | "failed" | "none";

/** The clients this person may help with connections, by name, with where NAV stands for each. */
export async function navBook(
  userId: string,
): Promise<{ profile_id: string; name: string | null; nav: NavState }[]> {
  const ids = await partnerClients(userId, "manage_connectors");
  if (ids.length === 0) return [];
  const [profiles, names] = await Promise.all([
    db
      .select({ id: businessProfiles.id, account_id: businessProfiles.account_id })
      .from(businessProfiles)
      .where(inArray(businessProfiles.id, ids)),
    db
      .select({ profile_id: fieldRecords.profile_id, value: fieldRecords.value })
      .from(fieldRecords)
      .where(
        and(
          inArray(fieldRecords.profile_id, ids),
          eq(fieldRecords.field_key, "identity.business_name"),
          isNull(fieldRecords.superseded_at),
        ),
      ),
  ]);
  const accountIds = profiles.map((p) => p.account_id);
  const navRows =
    accountIds.length === 0
      ? []
      : await db
          .select({ account_id: connections.account_id, status: connections.status })
          .from(connections)
          .where(
            and(
              inArray(connections.account_id, accountIds),
              eq(connections.provider, NAV_CONNECTOR),
              ne(connections.status, "disconnected"),
            ),
          );
  const rows = profiles.map((p) => {
    const name = names.find((n) => n.profile_id === p.id)?.value;
    const status = navRows.find((n) => n.account_id === p.account_id)?.status;
    const nav: NavState = !status ? "none" : status === "failed" ? "failed" : "connected";
    return { profile_id: p.id, name: typeof name === "string" ? name : null, nav };
  });
  return rows.sort((a, b) => (a.name ?? "￿").localeCompare(b.name ?? "￿"));
}
