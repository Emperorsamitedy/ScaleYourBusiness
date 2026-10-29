// /api/competitors/:id — feature 35. PATCH edits the owner's facts about
// a competitor (only what changed gets a new record); DELETE takes it off
// the list by writing tracked = false. Nothing is ever deleted (rule 3).

import { NextResponse } from "next/server";
import { editCompetitor, removeCompetitor } from "../../../../lib/competitors/service";
import { body, failure, session, signedOut } from "../shared";
import { requireRole } from "../../../../lib/auth/roles";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const s = await session();
  if (!s) return signedOut();
  const denied = requireRole(s, "competitors.manage");
  if (denied) return denied;
  const { id } = await params;
  const input = await body(request);
  if (!input) return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  try {
    await editCompetitor(s.profile_id, id, input);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error, s.account_id, "competitor_edit_failed");
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const s = await session();
  if (!s) return signedOut();
  const denied = requireRole(s, "competitors.manage");
  if (denied) return denied;
  const { id } = await params;
  try {
    await removeCompetitor(s.profile_id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error, s.account_id, "competitor_remove_failed");
  }
}
