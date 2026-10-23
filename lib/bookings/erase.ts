// Erasure for bookings — rule 22's spirit, called by eraseContact
// (lib/crm/contacts.ts) INSIDE its transaction (review 2026-10-23, #11).
// Its own small module so the CRM doesn't import the whole bookings store.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { DbOrTx } from "../../db";
import { db } from "../../db";
import { bookingAppointments, bookingClientErasures } from "../../db/schema";
import { clientKeyCandidates } from "./client-key";

/** Every key an erased customer's email or phone may have produced. */
export function erasedClientKeys(
  accountId: string,
  who: { email: string | null; phone: string | null },
): string[] {
  return [
    ...(who.email ? clientKeyCandidates(accountId, { kind: "email", value: who.email }, "") : []),
    ...(who.phone ? clientKeyCandidates(accountId, { kind: "phone", value: who.phone }, "") : []),
  ];
}

/**
 * Rule 22's spirit: erasing a customer also clears the client key their
 * email or phone produced, so their bookings stop being linkable to anyone,
 * and REMEMBERS the key (a hash, never the identity) so the next import of
 * the usual overlapping export can't write it back (review 2026-10-23, #3).
 * Keys made from a booking system's own client id can't be found from an
 * email; those stay anonymous ids, as the erasure screen says.
 */
export async function forgetBookingClient(
  accountId: string,
  who: { email: string | null; phone: string | null },
  executor: DbOrTx = db,
): Promise<number> {
  const keys = erasedClientKeys(accountId, who);
  if (keys.length === 0) return 0;
  await executor
    .insert(bookingClientErasures)
    .values(keys.map((client_key) => ({ account_id: accountId, client_key })))
    .onConflictDoNothing();
  const rows = await executor
    .update(bookingAppointments)
    .set({ client_key: null })
    .where(
      and(
        eq(bookingAppointments.account_id, accountId),
        isNotNull(bookingAppointments.client_key),
        inArray(bookingAppointments.client_key, keys),
      ),
    )
    .returning({ id: bookingAppointments.id });
  return rows.length;
}
