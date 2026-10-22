// Erasure for bookings — rule 22's spirit, called by eraseContact
// (lib/crm/contacts.ts). Its own small module so the CRM doesn't import the
// whole bookings store.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db";
import { bookingAppointments } from "../../db/schema";
import { clientKey } from "./client-key";

/**
 * Rule 22's spirit: erasing a customer also clears the client key their
 * email or phone produced, so their bookings stop being linkable to anyone.
 * Keys made from a booking system's own client id can't be found from an
 * email; those stay anonymous ids, as the erasure screen says.
 */
export async function forgetBookingClient(
  accountId: string,
  who: { email: string | null; phone: string | null },
): Promise<number> {
  const keys = [
    who.email ? clientKey(accountId, { kind: "email", value: who.email }, "") : null,
    who.phone ? clientKey(accountId, { kind: "phone", value: who.phone }, "") : null,
  ].filter((k): k is string => k !== null);
  if (keys.length === 0) return 0;
  const rows = await db
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
