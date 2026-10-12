// Support settings, the OWNER side — Phase 4 Session B (P4-07).
//
// Creating and rotating the public site key, and copying the business
// name across so the support tier can greet without reading the
// profile. This module sits on the trusted side (it reads a profile
// field); lib/support only ever reads the row it writes.

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, supportSettings } from "../../db/schema";
import { readCurrentField } from "../profile/field-store";
import type { SupportSettingsRow } from "../support/settings";
import { settingsForProfile } from "../support/settings";

export class SupportSettingsError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "SupportSettingsError";
    this.status = status;
  }
}

export const BUSINESS_NAME_KEY = "identity.legal_name";
export const DEFAULT_BUSINESS_NAME = "this business";

function newSiteKey(): string {
  return randomBytes(16).toString("hex");
}

async function businessName(profileId: string): Promise<string> {
  const field = await readCurrentField<string>(profileId, BUSINESS_NAME_KEY);
  const value = field && field.status === "answered" ? field.value : null;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : DEFAULT_BUSINESS_NAME;
}

/** The profile's settings, created on first call with a fresh key. */
export async function ensureSupportSettings(profileId: string): Promise<SupportSettingsRow> {
  const existing = await settingsForProfile(profileId);
  if (existing) return existing;
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) throw new SupportSettingsError("no such profile", 404);
  const [row] = await db
    .insert(supportSettings)
    .values({
      profile_id: profileId,
      account_id: profile.account_id,
      site_key: newSiteKey(),
      business_name: await businessName(profileId),
    })
    .onConflictDoNothing()
    .returning();
  return row ?? ((await settingsForProfile(profileId)) as SupportSettingsRow);
}

/** A new key; the old one stops working the moment this returns. Also refreshes the name. */
export async function rotateSiteKey(profileId: string): Promise<SupportSettingsRow> {
  await ensureSupportSettings(profileId);
  const [row] = await db
    .update(supportSettings)
    .set({
      site_key: newSiteKey(),
      business_name: await businessName(profileId),
      rotated_at: new Date().toISOString(),
    })
    .where(eq(supportSettings.profile_id, profileId))
    .returning();
  if (!row) throw new SupportSettingsError("no such profile", 404);
  console.log(JSON.stringify({ event: "support_site_key_rotated", account_id: row.account_id }));
  return row;
}
