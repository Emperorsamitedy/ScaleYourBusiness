// Moving between businesses — idea 52 (I-52.2).
//
// A switch issues a NEW session for the target business's own users row,
// and only when that row's email is exactly the current session's
// verified email. Nothing else is revoked: the browser's previous session
// token is retired (its cookie is being replaced, so nobody holds it any
// more), and every other session the person has stays as it was.
//
// "Add another business" makes a fresh account, its profile and an owner
// row for the same email, then switches into it — the interview starts
// there. Both go into the decision log as account_switch, ids only.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { logTeamDecision } from "./members";
import type { AuthedSession, RedeemedSession } from "./service";
import { createOwner, openSession, revokeSession } from "./service";

export class SwitchError extends Error {
  readonly status: number;
  constructor(message: string, status = 404) {
    super(message);
    this.name = "SwitchError";
    this.status = status;
  }
}

async function logSwitch(
  from: AuthedSession,
  to: Omit<RedeemedSession, "choose">,
  detail: "switch" | "new_business",
) {
  const profileId = to.profile_id ?? from.profile_id;
  if (!profileId) {
    // Neither business has a profile yet: there is no log to write it in.
    console.log(
      JSON.stringify({ event: "account_switch_unlogged", account_id: to.account_id, detail }),
    );
    return;
  }
  await logTeamDecision(db, {
    kind: "account_switch",
    profileId,
    accountId: to.account_id,
    refId: to.user_id,
    byUserId: to.user_id,
    detail: `${detail}:${from.user_id}`,
  });
}

/**
 * Move this browser to another business the same person belongs to.
 * A business they aren't on is "no such business" — never confirmed.
 */
export async function switchAccount(args: {
  session: AuthedSession;
  /** The browser's current auth cookie, retired once the new one is issued. */
  currentToken: string | undefined;
  targetAccountId: string;
}): Promise<Omit<RedeemedSession, "choose">> {
  const { session } = args;
  const [target] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.account_id, args.targetAccountId),
        // Exactly the verified address: both are stored normalised.
        eq(users.email, session.email),
        isNull(users.removed_at),
      ),
    );
  if (!target) throw new SwitchError("no such business");
  const next = await openSession(target);
  if (target.id !== session.user_id) await revokeSession(args.currentToken);
  await logSwitch(session, next, "switch");
  console.log(
    JSON.stringify({
      event: "account_switched",
      account_id: next.account_id,
      from: session.account_id,
    }),
  );
  return next;
}

/** A new business for the same person: account, profile, owner row, then a switch into it. */
export async function addBusiness(args: {
  session: AuthedSession;
  currentToken: string | undefined;
}): Promise<Omit<RedeemedSession, "choose">> {
  const boot = await bootstrapIntake();
  const owner = await createOwner(boot.account_id, args.session.email);
  const next = await openSession(owner);
  await revokeSession(args.currentToken);
  await logSwitch(args.session, next, "new_business");
  console.log(JSON.stringify({ event: "business_added", account_id: next.account_id }));
  return next;
}
