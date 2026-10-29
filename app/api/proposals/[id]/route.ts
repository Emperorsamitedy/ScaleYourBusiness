// GET /api/proposals/:id — one proposal for its card (idea 53, I-53.5),
// the page a phone alert opens.
//
// Read-only. Deciding goes through PUT /api/proposals, the queue's own
// decision path, with its checks and its decision-log entries (rule 12):
// this route has no write. Behind the one door (lib/auth/access), and only
// the caller's own business's proposal: a foreign id is "no such proposal"
// (404), never confirmed across the boundary. The proposal is swept for
// expiry first, so an expired one reads as expired.

import { and, eq, isNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../../db";
import { fieldRecords, proposals } from "../../../../db/schema";
import { resolveAccess } from "../../../../lib/auth/access";
import { logSafeError } from "../../../../lib/core/log-safe";
import { readCurrentField } from "../../../../lib/profile/field-store";
import { readEvidence, sourceFieldsOf } from "../../../../lib/proposals/evidence";
import type { HardLimit } from "../../../../lib/proposals/hard-limits";
import { HARD_LIMITS_KEY } from "../../../../lib/proposals/hard-limits";
import { expireDueProposals } from "../../../../lib/proposals/service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function businessName(profileId: string): Promise<string | null> {
  const [row] = await db
    .select({ value: fieldRecords.value })
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        eq(fieldRecords.field_key, "identity.legal_name"),
        isNull(fieldRecords.superseded_at),
      ),
    );
  return typeof row?.value === "string" && row.value.trim() !== "" ? row.value.trim() : null;
}

/** The owner's 13.5 limits as recorded — read, never parsed here (no model call). */
async function recordedLimits(profileId: string): Promise<HardLimit[] | null> {
  const field = await readCurrentField<HardLimit[]>(profileId, HARD_LIMITS_KEY);
  if (!field || !Array.isArray(field.value)) return null;
  return field.value.filter(
    (l): l is HardLimit =>
      typeof l === "object" && l !== null && typeof (l as HardLimit).quote === "string",
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "no such proposal" }, { status: 404 });
  try {
    await expireDueProposals(access.profile_id);
    const [proposal] = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.id, id), eq(proposals.profile_id, access.profile_id)));
    if (!proposal) return NextResponse.json({ error: "no such proposal" }, { status: 404 });
    const [business, evidence, limits] = await Promise.all([
      businessName(access.profile_id),
      readEvidence(access.profile_id, sourceFieldsOf([proposal.scenario])),
      recordedLimits(access.profile_id),
    ]);
    return NextResponse.json({
      proposal,
      business,
      facts: evidence.facts,
      disagreements: evidence.disagreements,
      // Null: the owner never answered 13.5, so there was nothing to check against.
      limits,
      signed_in: access.session !== null,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "proposal_card_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
