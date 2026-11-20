// The open leak register — the v1 build spec §6.4, §6.6 (P7-52).
//
// Every leak is an object with a status: open, in progress, fixed and
// verified, or accepted (the owner chose to live with it). "A leak cannot
// be marked fixed-and-verified without a ledger_entry with verdict
// verified_gain" — checked here against the ledger (the business's own,
// standing entry), and held by the table's check constraint, which refuses
// the status without the entry. Every move is a row in leak_events, which
// nothing edits: unclosed items are what bring the owner back.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { leakEvents, leaks, ledgerEntries } from "../../db/schema";
import type { Money } from "../core/money";

export type Leak = typeof leaks.$inferSelect;
export type LeakStatus = Leak["status"];

export class LeakError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "LeakError";
    this.status = status;
  }
}

export interface LeakInput {
  key: string;
  title: string;
  low: Money | null;
  high: Money | null;
  grade: string;
}

/**
 * Open the leaks a report found, once each: a leak already in the register
 * (by key) keeps its status and history; a new one opens.
 */
export async function registerLeaks(
  profileId: string,
  reportId: string,
  found: readonly LeakInput[],
): Promise<number> {
  if (found.length === 0) return 0;
  const existing = await db
    .select({ key: leaks.key })
    .from(leaks)
    .where(
      and(
        eq(leaks.profile_id, profileId),
        inArray(
          leaks.key,
          found.map((f) => f.key),
        ),
      ),
    );
  const known = new Set(existing.map((e) => e.key));
  let opened = 0;
  for (const f of found) {
    if (known.has(f.key)) continue;
    const currency = f.low?.currency ?? f.high?.currency ?? null;
    const [row] = await db
      .insert(leaks)
      .values({
        profile_id: profileId,
        report_id: reportId,
        key: f.key,
        title: f.title,
        currency,
        low_minor: f.low && f.low.currency === currency ? f.low.amount_minor : null,
        high_minor: f.high && f.high.currency === currency ? f.high.amount_minor : null,
        grade: f.grade,
      })
      .onConflictDoNothing()
      .returning();
    if (row) {
      opened += 1;
      await db
        .insert(leakEvents)
        .values({ leak_id: row.id, from_status: null, to_status: "open", by: null });
    }
  }
  return opened;
}

/** Move a leak. Fixed-and-verified needs a verified gain of this business in the ledger. */
export async function moveLeak(args: {
  profileId: string;
  leakId: string;
  to: LeakStatus;
  by: string | null;
  verifiedEntryId?: string | null;
  note?: string;
}): Promise<Leak> {
  const [leak] = await db
    .select()
    .from(leaks)
    .where(and(eq(leaks.id, args.leakId), eq(leaks.profile_id, args.profileId)));
  if (!leak) throw new LeakError("no such leak", 404);
  let entryId: string | null = null;
  if (args.to === "fixed_and_verified") {
    if (!args.verifiedEntryId) {
      throw new LeakError("fixed-and-verified needs the ledger entry that proves the gain");
    }
    const [entry] = await db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.id, args.verifiedEntryId),
          eq(ledgerEntries.profile_id, args.profileId),
        ),
      );
    if (!entry || entry.verdict !== "verified_gain") {
      throw new LeakError("only a verified gain of this business's own proves a leak fixed");
    }
    const later = await db
      .select({ seq: ledgerEntries.seq })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.plan_id, entry.plan_id));
    if (later.some((l) => l.seq > entry.seq)) {
      throw new LeakError("that gain was corrected since: use the standing entry");
    }
    entryId = entry.id;
  }
  const [row] = await db
    .update(leaks)
    .set({ status: args.to, verified_entry_id: entryId, updated_at: new Date().toISOString() })
    .where(eq(leaks.id, leak.id))
    .returning();
  await db.insert(leakEvents).values({
    leak_id: leak.id,
    from_status: leak.status,
    to_status: args.to,
    by: args.by,
    note: args.note ?? null,
  });
  return row!;
}

export async function leaksOf(profileId: string): Promise<Leak[]> {
  return db.select().from(leaks).where(eq(leaks.profile_id, profileId));
}
