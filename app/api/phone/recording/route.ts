// Twilio's recording status callback — P6-08 (TASKS-PHASE6.md rule 32).
//
//   POST /api/phone/recording   a recording finished (or captured nothing)
//
// Only the line's own <Start><Recording> names this address, and only for
// a call whose caller heard the recording notice. It is verified exactly
// as the voice webhook is — X-Twilio-Signature over the URL and the sorted
// parameters, with the auth token, and the account must be ours — before a
// single parameter is acted on. It reads no cookie and knows no session.
//
// It sits beside the voice webhook but OUTSIDE the stranger tier: it never
// sees a caller's words, only Twilio's ids, and it reaches the media store
// (lib/phone-recording), which the line itself may not.

import { type NextRequest, NextResponse } from "next/server";
import { twilioEnv } from "../../../../lib/env";
import { recordingCallback } from "../../../../lib/phone-recording/recordings";
import { formParams, signedUrls, verifyTwilioSignature } from "../../../../lib/phone/twilio";

/** Fetching, sealing and storing a call's audio, then deleting Twilio's copy. */
export const maxDuration = 120;

const MAX_BODY_BYTES = 64 * 1024;

function refuse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = twilioEnv();
  if (!env) {
    console.error(JSON.stringify({ event: "phone_not_configured", account_id: null }));
    return refuse("the phone line is not set up", 503);
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return refuse("too large", 413);
  const params = formParams(raw);
  const signature = request.headers.get("x-twilio-signature");
  if (
    !verifyTwilioSignature(
      env.authToken,
      signedUrls(request.url, process.env.APP_URL),
      params,
      signature,
    )
  ) {
    console.warn(
      JSON.stringify({
        event: "phone_recording_signature_refused",
        account_id: null,
        signed: !!signature,
      }),
    );
    return refuse("unsigned", 403);
  }
  if (params.AccountSid !== env.accountSid) {
    console.warn(JSON.stringify({ event: "phone_other_account_refused", account_id: null }));
    return refuse("not this account", 403);
  }
  try {
    const outcome = await recordingCallback(params);
    return NextResponse.json({ outcome }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "phone_recording_callback_failed",
        account_id: null,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    // Twilio's view of it doesn't matter: the row is pending and the upkeep retries.
    return refuse("failed", 500);
  }
}
