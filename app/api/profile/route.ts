// GET /api/profile — the fact sheet (P1-59/60): every captured fact
// with its source, from the snapshot, plus the gaps and what answering
// each would buy. Session-scoped like the intake; read-only.

import { resolveAccess } from "../../../lib/auth/access";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import { buildFactSheet } from "../../../lib/profile/factsheet";

export async function GET(): Promise<NextResponse> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  const profileId = (await resolveAccess())?.profile_id;
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const [row] = await db
    .select({ id: businessProfiles.id, account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!row) return NextResponse.json({ error: "no intake session" }, { status: 401 });

  try {
    return NextResponse.json(await buildFactSheet(row.id));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "factsheet_error",
        account_id: row.account_id,
        message: String(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
