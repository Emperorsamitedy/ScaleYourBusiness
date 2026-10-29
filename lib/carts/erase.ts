// Erasure for abandoned carts — rule 22's spirit, called by eraseContact
// (lib/crm/contacts.ts) INSIDE its transaction, like lib/bookings/erase.ts.
// Its own small module, handed the address's hash forms, so the CRM
// doesn't import the cart store and nothing here imports the CRM.

import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../../db";
import { db } from "../../db";
import { abandonedCheckouts } from "../../db/schema";

/**
 * Delete every cart of the account whose shopper hash is one of `hashes`
 * (emailHashCandidates of the erased address). Returns how many went. The
 * erasure suppression the caller writes keeps the next read from linking
 * them again (lib/carts/store.ts).
 */
export async function eraseCartsFor(
  accountId: string,
  hashes: readonly string[],
  executor: DbOrTx = db,
): Promise<number> {
  if (hashes.length === 0) return 0;
  const rows = await executor
    .delete(abandonedCheckouts)
    .where(
      and(
        eq(abandonedCheckouts.account_id, accountId),
        inArray(abandonedCheckouts.email_hash, [...hashes]),
      ),
    )
    .returning({ id: abandonedCheckouts.id });
  return rows.length;
}
