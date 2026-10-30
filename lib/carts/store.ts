// Abandoned carts, stored — idea 47.
//
// A store's sync hands back the checkouts started in the last
// CARTS.read_days days (Provider.readAbandonedCheckouts). Each lands once
// per (connection, checkout id), and a re-read updates it: a cart the
// shopper later finished gains its completed_at. Two rules on the way in:
//
//   · No address is kept (rules 22 and 23's spirit). An email the platform
//     gives is turned into the keyed hash contacts and suppressions use
//     (lib/crm/contacts.ts emailHash) and dropped. A hash that matches an
//     ERASURE suppression is dropped too, so the next read can't link an
//     erased customer's carts back to them.
//   · Carts don't outlive CARTS.retention_days. Every store of a read
//     deletes the connection's older ones first.
//
// Erasure is lib/carts/erase.ts, called inside eraseContact's transaction.
//
// Shopify gives no email today (lib/connectors/providers/shopify.ts: the
// shopper needs read_customers, which SYB doesn't hold), so its carts land
// with a null hash and match nobody. The path is the same for any store
// that does.

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db";
import { db } from "../../db";
import { abandonedCheckouts, contactSuppressions } from "../../db/schema";
import { dayString } from "../connectors/days";
import type { CartRead } from "../connectors/provider";
import { emailHash, emailHashCandidates } from "../crm/contacts";
import { CARTS } from "./measure";

const CHUNK = 500;
const DAY_MS = 86_400_000;

/** The oldest moment a stored cart may have started at, for `now`. */
export function retentionCutoff(now: Date): string {
  return new Date(now.getTime() - CARTS.retention_days * DAY_MS).toISOString();
}

/**
 * Review 2026-10-30: every business's carts past retention, gone — run on
 * the weekly beat, so a store whose syncs stopped (paused, failed) doesn't
 * keep carts past CARTS.retention_days just because no read came.
 */
export async function pruneExpiredCarts(now: Date, executor: DbOrTx = db): Promise<number> {
  const rows = await executor
    .delete(abandonedCheckouts)
    .where(lt(abandonedCheckouts.started_at, retentionCutoff(now)))
    .returning({ id: abandonedCheckouts.id });
  return rows.length;
}

/**
 * Store one read for a connection: prune what is past retention, then
 * upsert every cart. Returns how many carts landed and how many emails were
 * hashed (a count, never an address, for the sync's log line).
 */
export async function storeCarts(
  conn: { id: string; account_id: string },
  read: CartRead,
  now: Date,
  executor: DbOrTx = db,
): Promise<{ stored: number; hashed: number; pruned: number }> {
  const cutoff = retentionCutoff(now);
  const pruned = await executor
    .delete(abandonedCheckouts)
    .where(
      and(eq(abandonedCheckouts.connection_id, conn.id), lt(abandonedCheckouts.started_at, cutoff)),
    )
    .returning({ id: abandonedCheckouts.id });

  // One cart once; a read that returned one twice keeps the later.
  const byRef = new Map<string, CartRead["carts"][number]>();
  for (const c of read.carts) {
    const at = Date.parse(c.started_at);
    // As instants (review 2026-10-30): a provider's time may carry an offset.
    if (!Number.isFinite(at) || at < Date.parse(cutoff)) continue;
    byRef.set(c.ref, c);
  }
  const carts = [...byRef.values()];

  // The keyed hash, unless the address was erased (its suppression row says so).
  const hashes = new Map<string, string>();
  const emails = carts.map((c) => c.email).filter((e): e is string => !!e && e.trim() !== "");
  if (emails.length > 0) {
    const candidates = new Map(emails.map((e) => [e, emailHashCandidates(e)]));
    const all = [...new Set([...candidates.values()].flat())];
    const erased = new Set<string>();
    for (let i = 0; i < all.length; i += CHUNK) {
      const rows = await executor
        .select({ hash: contactSuppressions.email_hash })
        .from(contactSuppressions)
        .where(
          and(
            eq(contactSuppressions.account_id, conn.account_id),
            eq(contactSuppressions.reason, "erasure"),
            inArray(contactSuppressions.email_hash, all.slice(i, i + CHUNK)),
          ),
        );
      for (const r of rows) erased.add(r.hash);
    }
    for (const [email, forms] of candidates) {
      if (!forms.some((h) => erased.has(h))) hashes.set(email, emailHash(email));
    }
  }

  const observedAt = now.toISOString();
  const rows = carts.map((c) => ({
    account_id: conn.account_id,
    connection_id: conn.id,
    checkout_ref: c.ref,
    started_at: c.started_at,
    updated_at: c.updated_at,
    day: dayString(new Date(Date.parse(c.started_at))),
    completed_at: c.completed_at,
    total_minor: c.total_minor,
    currency: c.currency.toUpperCase(),
    lines: c.lines,
    lines_truncated: c.lines_truncated,
    email_hash: c.email ? (hashes.get(c.email) ?? null) : null,
    accepts_marketing: c.accepts_marketing,
    observed_at: observedAt,
  }));
  for (let i = 0; i < rows.length; i += CHUNK) {
    await executor
      .insert(abandonedCheckouts)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [abandonedCheckouts.connection_id, abandonedCheckouts.checkout_ref],
        set: {
          updated_at: sqlExcluded("updated_at"),
          completed_at: sqlExcluded("completed_at"),
          total_minor: sqlExcluded("total_minor"),
          currency: sqlExcluded("currency"),
          lines: sqlExcluded("lines"),
          lines_truncated: sqlExcluded("lines_truncated"),
          // A read without the shopper keeps the hash an earlier read gave.
          email_hash: sql`coalesce(excluded.email_hash, ${abandonedCheckouts.email_hash})`,
          accepts_marketing: sql`coalesce(excluded.accepts_marketing, ${abandonedCheckouts.accepts_marketing})`,
          observed_at: sqlExcluded("observed_at"),
        },
      });
  }
  return {
    stored: rows.length,
    hashed: rows.filter((r) => r.email_hash).length,
    pruned: pruned.length,
  };
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
