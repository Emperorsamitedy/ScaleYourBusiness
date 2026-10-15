// Internal accounts — P3-40b (Session H).
//
// SYB runs its own business through its own product. That account is
// real, its scorecard is real — and its numbers must never be read as
// evidence about customers. Every cross-customer aggregate (Gate 2's
// approval rate, the ops funnel, the cost view) filters through here; a
// per-profile view does not, because the business is still a business.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { accounts, businessProfiles } from "../../db/schema";

/** Accounts flagged internal, as a set for filtering. */
export async function internalAccountIds(): Promise<Set<string>> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.internal, true));
  return new Set(rows.map((r) => r.id));
}

/** Profiles belonging to internal accounts. */
export async function internalProfileIds(): Promise<Set<string>> {
  const rows = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .innerJoin(accounts, eq(accounts.id, businessProfiles.account_id))
    .where(eq(accounts.internal, true));
  return new Set(rows.map((r) => r.id));
}

/** Flag (or unflag) an account as SYB's own. Operator action, not an owner one. */
export async function setAccountInternal(accountId: string, internal: boolean): Promise<void> {
  const updated = await db
    .update(accounts)
    .set({ internal })
    .where(eq(accounts.id, accountId))
    .returning({ id: accounts.id });
  if (updated.length === 0) throw new Error(`no account ${accountId}`);
}
