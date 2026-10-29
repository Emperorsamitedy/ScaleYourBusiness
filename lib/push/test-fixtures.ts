// Idea 53: the database fixtures the push tests share — a business with an
// owner, and a browser subscription on the fake push host (no network).

import "dotenv/config";
import { createECDH, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  accounts,
  authSessions,
  businessProfiles,
  executionHalts,
  fieldRecords,
  intakeEvents,
  proposals,
  pushSubscriptions,
  users,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { FAKE_PUSH_HOST, saveSubscription } from "./subscriptions";
import { b64url } from "./webpush";

const created: { account_id: string; profile_id: string }[] = [];

export async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `i53-${crypto.randomUUID()}@test.local`,
      display_name: "I-53 owner",
      role: "owner",
    })
    .returning({ id: users.id });
  if (!u) throw new Error("no user");
  return { ...s, user_id: u.id };
}

export function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)) };
}

export async function device(
  b: { account_id: string; user_id: string },
  opts: { sessionId?: string | null; ua?: string } = {},
) {
  const endpoint = `https://${FAKE_PUSH_HOST}/${crypto.randomUUID()}`;
  const saved = await saveSubscription({
    accountId: b.account_id,
    userId: b.user_id,
    sessionId: opts.sessionId ?? null,
    userAgent: opts.ua ?? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)",
    target: { endpoint, ...browserKeys() },
    timeZone: "Europe/Budapest",
  });
  return { ...saved, endpoint };
}

/** For afterAll: every business made here, with its rows. Decision-log rows stay (rule 7). */
export async function cleanup(): Promise<void> {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) {
    await db.delete(executionHalts).where(eq(executionHalts.account_id, s.account_id));
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.account_id, s.account_id));
    await db.delete(authSessions).where(eq(authSessions.account_id, s.account_id));
    await db.delete(users).where(eq(users.account_id, s.account_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
  created.length = 0;
}
