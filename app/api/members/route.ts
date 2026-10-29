// The team API — idea 52 (I-52.4). Who can sign in to this business.
//
//   GET  /api/members                                    the people on the team and the open
//                                                        invites, and who you are on it
//   POST /api/members {action:"invite", email, role}     an invite; emailed through Resend
//                                                        when set up, else its link comes back
//                                                        for the owner to copy
//   POST /api/members {action:"revoke_invite", invite_id}
//   POST /api/members {action:"set_role", user_id, role}
//   POST /api/members {action:"remove", user_id}          their sessions are revoked with it
//
// Behind the one door (lib/auth/access), signed in. Anyone on the team may
// read the list; every change is the owner's (requireRole "team.manage")
// and comes from our own page (isSameOriginPost). Only this business's
// rows are ever named: a foreign id is "no such", never confirmed.
// Nothing here logs an email address.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../lib/auth/access";
import { sendInviteEmail } from "../../../lib/auth/email";
import {
  TeamError,
  createInvite,
  removeMember,
  revokeInvite,
  setMemberRole,
  teamList,
} from "../../../lib/auth/members";
import { permissionsFor, requireRole } from "../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { logSafeError } from "../../../lib/core/log-safe";
import { db } from "../../../db";
import { fieldRecords } from "../../../db/schema";
import { and, eq, isNull } from "drizzle-orm";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const noSuch = () => NextResponse.json({ error: "no such person or invite" }, { status: 404 });

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

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const session = access.session;
  if (!session) {
    return NextResponse.json({ error: "sign up first: a team starts with you" }, { status: 401 });
  }
  try {
    const list = await teamList(access.account_id);
    return NextResponse.json({
      ...list,
      you: { user_id: session.user_id, role: session.role },
      can: permissionsFor(session.role),
      email_configured: Boolean(process.env.RESEND_API_KEY?.trim()),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "members_view_error",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "change the team from our own page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access.session, "team.manage");
  if (denied) return denied;
  const session = access.session;
  if (!session) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      email?: unknown;
      role?: unknown;
      invite_id?: unknown;
      user_id?: unknown;
    };
    const scope = {
      accountId: access.account_id,
      profileId: access.profile_id,
    };
    switch (body.action) {
      case "invite": {
        if (typeof body.email !== "string") {
          return NextResponse.json({ error: "an email address is needed" }, { status: 422 });
        }
        const { token, invite } = await createInvite({
          ...scope,
          invitedBy: session.user_id,
          email: body.email,
          role: body.role,
        });
        const link = `${appOriginOf(request.url)}/invite?token=${encodeURIComponent(token)}`;
        const sent = await sendInviteEmail({
          to: invite.email,
          link,
          business: await businessName(access.profile_id),
          role: invite.role,
        });
        return NextResponse.json(
          {
            invite,
            delivered_via: sent.delivered_via,
            // Shown to copy whenever it wasn't emailed. The link is not a sign-in:
            // joining still needs a sign-in for exactly this address.
            ...(sent.delivered_via === "resend" ? {} : { link }),
          },
          { status: 201 },
        );
      }
      case "revoke_invite": {
        if (!isId(body.invite_id)) return noSuch();
        await revokeInvite({ ...scope, inviteId: body.invite_id, byUserId: session.user_id });
        return NextResponse.json({ revoked: true });
      }
      case "set_role": {
        if (!isId(body.user_id)) return noSuch();
        await setMemberRole({
          ...scope,
          targetUserId: body.user_id,
          role: body.role,
          byUserId: session.user_id,
        });
        return NextResponse.json({ changed: true });
      }
      case "remove": {
        if (!isId(body.user_id)) return noSuch();
        await removeMember({ ...scope, targetUserId: body.user_id, byUserId: session.user_id });
        return NextResponse.json({ removed: true, signed_out: body.user_id === session.user_id });
      }
      default:
        return NextResponse.json(
          { error: 'action must be "invite", "revoke_invite", "set_role" or "remove"' },
          { status: 422 },
        );
    }
  } catch (error) {
    if (error instanceof TeamError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "members_change_error",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
