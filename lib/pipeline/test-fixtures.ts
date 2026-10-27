// Shared setup for the pipeline's database tests (P5-14..17): a fresh
// business whose 6.1a answer is given through the real write path, and a
// cleanup that removes what the tests made. The decision log is append-only
// and is never cleaned (rule 7).

import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  contactSuppressions,
  contacts,
  deals,
  fieldRecords,
  intakeEvents,
  proposals,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";

export interface TestBusiness {
  account_id: string;
  profile_id: string;
}

const made: TestBusiness[] = [];

/** Write one answered fact as the owner would. */
export async function answer(profileId: string, key: string, value: unknown): Promise<void> {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

/** A fresh business; `type` answers 6.1a (customers.type) unless null. */
export async function freshBusiness(
  type: "b2b" | "b2c" | "both" | null = "b2b",
): Promise<TestBusiness> {
  const s = await bootstrapIntake();
  made.push(s);
  if (type !== null) await answer(s.profile_id, "customers.type", { code: type });
  return s;
}

export async function cleanupBusinesses(): Promise<void> {
  const ids = made.map((s) => s.profile_id);
  for (const s of made) {
    await db.delete(deals).where(eq(deals.account_id, s.account_id));
    await db.delete(contacts).where(eq(contacts.account_id, s.account_id));
    await db.delete(contactSuppressions).where(eq(contactSuppressions.account_id, s.account_id));
  }
  if (ids.length > 0) {
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of made) {
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
  made.length = 0;
}
