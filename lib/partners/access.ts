// Partner access — the v1 build spec §7.1, §7.7 (P7-80).
//
// The one door for a firm member reaching a client: the database's
// partner_may(user, profile, scope) (migration 0117). Nothing here holds a
// list of who may see what; every call asks the database at that moment,
// so a revoked or expired mandate stops working at the next request — well
// inside §7.7's 60 seconds — and the mandate rows stay as the audit trail.
//
// Every partner action is written to the client owner's decision log as
// the partner's own (actor "partner", the person's user id), so the owner
// sees it in their audit trail with the partner's name and firm.

import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import type { MANDATE_SCOPES } from "../../db/schema";
import { decisionLog, firmMembers, firms, mandates } from "../../db/schema";

export type MandateScope = (typeof MANDATE_SCOPES)[number];

export class PartnerAccessError extends Error {
  readonly status: number;
  constructor(message = "no active mandate covers that", status = 404) {
    super(message);
    this.name = "PartnerAccessError";
    this.status = status;
  }
}

/** The database's answer: a live member, the firm's mandate, unrevoked, unexpired, in scope. */
export async function partnerMay(
  userId: string,
  profileId: string,
  scope: MandateScope,
): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(
    sql`select partner_may(${userId}::uuid, ${profileId}::uuid, ${scope}) as ok`,
  );
  return rows.rows[0]?.ok === true;
}

/** Throws unless the database says yes. A refused business is "not found": its existence isn't confirmed. */
export async function requirePartner(
  userId: string,
  profileId: string,
  scope: MandateScope,
): Promise<void> {
  if (!(await partnerMay(userId, profileId, scope))) throw new PartnerAccessError();
}

/**
 * Every business this person may reach with `scope`, decided in the
 * database's WHERE. Only their firms' mandate rows are candidates, so a book
 * of 200 asks partner_may 200 times, not once per business in SYB.
 */
export async function partnerClients(userId: string, scope: MandateScope): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: mandates.profile_id })
    .from(mandates)
    .innerJoin(firmMembers, eq(firmMembers.firm_id, mandates.firm_id))
    .where(
      and(
        eq(firmMembers.user_id, userId),
        isNull(firmMembers.removed_at),
        sql`partner_may(${userId}::uuid, ${mandates.profile_id}, ${scope})`,
      ),
    );
  return rows.map((r) => r.id);
}

/** The firm a person is a live member of, with their role there; null when none. */
export async function firmOf(userId: string) {
  const [row] = await db
    .select({ firm: firms, role: firmMembers.role })
    .from(firmMembers)
    .innerJoin(firms, eq(firms.id, firmMembers.firm_id))
    .where(and(eq(firmMembers.user_id, userId), isNull(firmMembers.removed_at)))
    .limit(1);
  return row ?? null;
}

/**
 * §7.7: "A partner action appears in the business owner's audit trail with
 * the partner's name." The entry names the person (user_id) and carries the
 * firm and the action in its hashed payload.
 */
export async function logPartnerAction(args: {
  profileId: string;
  userId: string;
  firmId: string;
  action: string;
  ref: string;
}): Promise<void> {
  const payload = JSON.stringify({
    action: args.action,
    firm_id: args.firmId,
    user_id: args.userId,
    ref: args.ref,
  });
  await db.insert(decisionLog).values({
    profile_id: args.profileId,
    actor: "partner",
    kind: "partner_action",
    // "action:firm:ref" — the firm stays readable after the person leaves it.
    ref_id: `${args.action}:${args.firmId}:${args.ref}`,
    payload_hash: createHash("sha256").update(payload).digest("hex"),
    user_id: args.userId,
  });
}
