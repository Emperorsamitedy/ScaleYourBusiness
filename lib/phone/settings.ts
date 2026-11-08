// The phone line's settings, the stranger-facing READ — P6-02.
//
// Twilio says which number was dialled (`To`); this finds the business
// that number answers for, and the name the support settings hold for it,
// so the line can greet without reading the profile. Turning the line on,
// off, or setting where callers are put through is the owner's act and
// lives in lib/phone-desk, on the trusted side (rule 21: the phone tier
// imports no profile, proposal or execution path, and the structural test
// in lib/support holds it to that).

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { phoneSettings, supportSettings } from "../../db/schema";
import { DEFAULT_BUSINESS_NAME } from "../support/settings";
import { E164_RE } from "./twilio";

export interface PhoneLine {
  profile_id: string;
  account_id: string;
  phone_number: string;
  enabled: boolean;
  handover_number: string | null;
  business_name: string;
}

async function lineWhere(where: ReturnType<typeof eq>): Promise<PhoneLine | null> {
  const [row] = await db
    .select({
      profile_id: phoneSettings.profile_id,
      account_id: phoneSettings.account_id,
      phone_number: phoneSettings.phone_number,
      enabled: phoneSettings.enabled,
      handover_number: phoneSettings.handover_number,
      business_name: supportSettings.business_name,
    })
    .from(phoneSettings)
    .leftJoin(supportSettings, eq(supportSettings.profile_id, phoneSettings.profile_id))
    .where(where);
  if (!row) return null;
  return { ...row, business_name: row.business_name ?? DEFAULT_BUSINESS_NAME };
}

/** The line a dialled number answers for. Junk never reaches the database. */
export async function lineByNumber(number: string | undefined): Promise<PhoneLine | null> {
  if (!number || !E164_RE.test(number)) return null;
  return lineWhere(eq(phoneSettings.phone_number, number));
}

export async function lineForProfile(profileId: string): Promise<PhoneLine | null> {
  return lineWhere(eq(phoneSettings.profile_id, profileId));
}
