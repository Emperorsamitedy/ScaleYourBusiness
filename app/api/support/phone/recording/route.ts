// A call recording, played to the OWNER — P6-08 (rule 32).
//
//   GET /api/support/phone/recording?call=<id>   the call's audio, opened
//
// Owner only: a signed-in person whose role may "phone.recordings", for a
// call of their own business (the one door, resolveAccess). The audio is
// opened from its sealed file here and streamed back with no-store; the
// storage address never leaves the server, so there is no public URL to
// pass around. Each play is logged with who listened.

import { type NextRequest, NextResponse } from "next/server";
import { matchingSession, resolveAccess } from "../../../../../lib/auth/access";
import { requireRole } from "../../../../../lib/auth/roles";
import { logSafeError } from "../../../../../lib/core/log-safe";
import { PhoneRecordingError, openRecording } from "../../../../../lib/phone-recording/recordings";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return refuse("no intake session", 401);
  // Signed in, always: an anonymous interview has no recordings and no owner to check.
  const session = await matchingSession();
  const denied = requireRole(session, "phone.recordings");
  if (denied) return denied;
  const callId = request.nextUrl.searchParams.get("call") ?? "";
  if (!UUID_RE.test(callId)) return refuse("no such recording", 404);
  try {
    const audio = await openRecording(access.profile_id, callId);
    console.log(
      JSON.stringify({
        event: "phone_recording_played",
        account_id: session?.account_id ?? null,
        user_id: session?.user_id ?? null,
        call_id: callId,
      }),
    );
    return new NextResponse(Buffer.from(audio.body), {
      status: 200,
      headers: {
        "Content-Type": audio.content_type,
        "Content-Length": String(audio.body.byteLength),
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof PhoneRecordingError) return refuse(error.message, error.status);
    console.error(JSON.stringify({ event: "phone_recording_play_failed", ...logSafeError(error) }));
    return refuse("failed", 500);
  }
}
