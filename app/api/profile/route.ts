// GET /api/profile — the fact sheet (P1-59/60): every captured fact
// with its source, from the snapshot, plus the gaps and what answering
// each would buy. Session-scoped like the intake; read-only.

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import { buildFactSheet } from "../../../lib/profile/factsheet";

const COOKIE = "syb_intake_profile";

export async function GET(): Promise<NextResponse> {
  const store = await cookies();
  const profileId = store.get(COOKIE)?.value;
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
      JSON.stringify({ event: "factsheet_error", account_id: row.account_id, message: String(error) }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
