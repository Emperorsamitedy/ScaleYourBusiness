// The ledger's hash chain — the v1 build spec §3.5 (P7-35).
//
//   entry_hash = sha256(prev_hash || canonical_json(entry))
//
// appendEntry takes the chain lock, reads the head, and writes the next
// entry with its hash. The table's trigger (migration 0103) re-takes the
// same lock and refuses an entry that doesn't extend the head, so the chain
// can't fork even under concurrent closes. verifyChain walks every entry and
// returns the first break: a single altered byte anywhere changes that
// entry's hash, and so every link after it.
//
// The canonical form is this module's own: the entry's fields in a fixed
// order, money as integer strings, the time as an ISO instant — never the
// database's text rendering, which depends on the session's time zone.

import { createHash } from "node:crypto";
import { asc, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import { ledgerChainHeads, ledgerEntries } from "../../db/schema";

export type Entry = typeof ledgerEntries.$inferSelect;

/** The fields an entry's hash covers — everything but the hash itself. */
const HASHED_FIELDS = [
  "id",
  "seq",
  "plan_id",
  "profile_id",
  "verdict",
  "currency",
  "observed_effect_minor",
  "observed_low_minor",
  "observed_high_minor",
  "net_minor",
  "forecast_error_minor",
  "method_notes",
  "reporting_eur_minor",
  "reporting_fx_rate",
  "reporting_fx_date",
  "reporting_fx_source",
  "corrects_entry_id",
  "prev_hash",
  "created_at",
] as const;

type HashedEntry = Pick<Entry, (typeof HASHED_FIELDS)[number]>;

function canonicalValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (key === "created_at") return new Date(value as string).toISOString();
  if (key === "reporting_fx_date") return String(value).slice(0, 10);
  return String(value);
}

/** The entry as canonical JSON: a fixed field order, strings or null, nothing else. */
export function canonicalJson(entry: HashedEntry): string {
  return JSON.stringify(
    HASHED_FIELDS.map((k) => [k, canonicalValue(k, (entry as Record<string, unknown>)[k])]),
  );
}

export function entryHash(entry: HashedEntry): string {
  return createHash("sha256")
    .update((entry.prev_hash ?? "") + canonicalJson(entry))
    .digest("hex");
}

/** The lock lib/ledger and the table's trigger share. */
const CHAIN_LOCK = sql`select pg_advisory_xact_lock(hashtext('syb_ledger_chain'))`;

export type NewEntry = Omit<Entry, "seq" | "prev_hash" | "entry_hash">;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Append one entry at the chain's head, inside the caller's transaction. */
export async function appendEntry(tx: Tx, entry: NewEntry): Promise<Entry> {
  await tx.execute(CHAIN_LOCK);
  const [head] = await tx
    .select({ seq: ledgerEntries.seq, entry_hash: ledgerEntries.entry_hash })
    .from(ledgerEntries)
    .orderBy(desc(ledgerEntries.seq))
    .limit(1);
  const linked = {
    ...entry,
    created_at: new Date(entry.created_at).toISOString(),
    seq: (head?.seq ?? 0) + 1,
    prev_hash: head?.entry_hash ?? null,
  };
  const [row] = await tx
    .insert(ledgerEntries)
    .values({ ...linked, entry_hash: entryHash(linked) })
    .returning();
  return row!;
}

export type ChainVerdict =
  | { ok: true; entries: number; head_hash: string | null }
  | {
      ok: false;
      entries: number;
      /** The first entry whose link or hash doesn't hold. */
      first_break: { seq: number; id: string; why: "hash" | "link" | "sequence" };
    };

/** Pure: walk entries in seq order and return the first break. */
export function verifyChain(entries: readonly Entry[]): ChainVerdict {
  let prev: Entry | null = null;
  for (const e of entries) {
    const expectedSeq = prev === null ? 1 : prev.seq + 1;
    if (e.seq !== expectedSeq) {
      return {
        ok: false,
        entries: entries.length,
        first_break: { seq: e.seq, id: e.id, why: "sequence" },
      };
    }
    if ((e.prev_hash ?? null) !== (prev?.entry_hash ?? null)) {
      return {
        ok: false,
        entries: entries.length,
        first_break: { seq: e.seq, id: e.id, why: "link" },
      };
    }
    if (entryHash(e) !== e.entry_hash) {
      return {
        ok: false,
        entries: entries.length,
        first_break: { seq: e.seq, id: e.id, why: "hash" },
      };
    }
    prev = e;
  }
  return { ok: true, entries: entries.length, head_hash: prev?.entry_hash ?? null };
}

/** The verify endpoint's work: the whole chain, from the database, in pages. */
export async function verifyLedger(pageSize = 5_000): Promise<ChainVerdict> {
  const all: Entry[] = [];
  let after = 0;
  for (;;) {
    const page = await db
      .select()
      .from(ledgerEntries)
      .where(sql`${ledgerEntries.seq} > ${after}`)
      .orderBy(asc(ledgerEntries.seq))
      .limit(pageSize);
    all.push(...page);
    if (page.length < pageSize) break;
    after = page[page.length - 1]!.seq;
  }
  return verifyChain(all);
}

export async function chainHead(): Promise<{ seq: number; entry_hash: string } | null> {
  const [head] = await db
    .select({ seq: ledgerEntries.seq, entry_hash: ledgerEntries.entry_hash })
    .from(ledgerEntries)
    .orderBy(desc(ledgerEntries.seq))
    .limit(1);
  return head ?? null;
}

/**
 * Publish the day's chain head (§3.5): to ledger_chain_heads, append-only by
 * trigger, and — when one is configured — to an external write-once store
 * (S3 Object Lock in compliance mode, or equivalent), whose reference is
 * kept with the row. Once a day: a second publish for the same day is a
 * no-op. Without an external store the head is still dated and immutable
 * here, and anyone holding an earlier head can check the chain still ends
 * in it (D27).
 */
export async function publishChainHead(
  day: string,
  external?: (head: { day: string; seq: number | null; hash: string | null }) => Promise<string>,
): Promise<{ published: boolean; head_hash: string | null }> {
  const head = await chainHead();
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(ledgerEntries);
  const ref = external
    ? await external({ day, seq: head?.seq ?? null, hash: head?.entry_hash ?? null })
    : null;
  const [row] = await db
    .insert(ledgerChainHeads)
    .values({
      day,
      head_seq: head?.seq ?? null,
      head_hash: head?.entry_hash ?? null,
      entries: n,
      external_ref: ref,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return { published: false, head_hash: head?.entry_hash ?? null };
  return { published: true, head_hash: row.head_hash };
}
