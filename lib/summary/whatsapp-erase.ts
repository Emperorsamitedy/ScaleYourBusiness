// Erasing a person's WhatsApp number (rule 22), on its own: removing a team
// member (lib/auth/members) calls this, and the push send path's import
// graph runs through members. Only the database here, so that path never
// reaches the WhatsApp sender or anything it imports (lib/push/no-connector).

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db";
import type { DbOrTx } from "../../db";
import { whatsappOptins } from "../../db/schema";

/**
 * Rule 22: forget every number this user ever gave — withdrawn too, if
 * still live. The rows stay (dates, version, hash) so the record of the
 * yes and its end survives without the number. Returns how many were cleared.
 * `tx` lets a caller (removing a member) do it inside its own transaction.
 */
export async function eraseWhatsAppNumbers(userId: string, tx: DbOrTx = db): Promise<number> {
  const now = new Date().toISOString();
  const rows = await tx
    .update(whatsappOptins)
    .set({
      phone_number: null,
      erased_at: now,
      withdrawn_at: sql`coalesce(${whatsappOptins.withdrawn_at}, ${now}::timestamptz)`,
    })
    .where(and(eq(whatsappOptins.user_id, userId), isNotNull(whatsappOptins.phone_number)))
    .returning({ id: whatsappOptins.id, account_id: whatsappOptins.account_id });
  if (rows.length > 0) {
    console.log(
      JSON.stringify({
        event: "whatsapp_number_erased",
        account_id: rows[0]!.account_id,
        optins: rows.length,
      }),
    );
  }
  return rows.length;
}
