// The phone line's webhook — P6-02 (TASKS-PHASE6.md rules 31, 32, 34).
//
//   POST /api/phone/voice                Twilio: a call comes in
//   POST /api/phone/voice?step=turn      the caller said something (<Gather> speech)
//   POST /api/phone/voice?step=message   the caller left a message
//   POST /api/phone/voice?step=dial      a put-through to the owner ended
//   POST /api/phone/voice?step=status    Twilio's status callback: the call ended
//
// Stranger-facing: anyone can dial the number. So it reads no cookie, knows
// no session, and imports lib/phone only (the rule-21 structural test in
// lib/support holds it to that).
//
//   · With no Twilio settings, every request is refused (503): a request
//     whose signature can't be checked is never answered.
//   · An unsigned or badly signed request is refused (403) before a single
//     parameter is acted on, and so is one naming another Twilio account.
//   · Everything else answers TwiML. A failure inside a step still answers
//     a caller with words and a hang-up, never a stack trace.

import { type NextRequest, NextResponse } from "next/server";
import { twilioEnv } from "../../../../lib/env";
import type { Step } from "../../../../lib/phone/line";
import { STEPS, handleVoice } from "../../../../lib/phone/line";
import { formParams, signedUrls, verifyTwilioSignature } from "../../../../lib/phone/twilio";

/** The largest webhook body accepted. Twilio's are a few KB. */
const MAX_BODY_BYTES = 64 * 1024;

function xml(body: string, status = 200): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
}

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
      JSON.stringify({ event: "phone_signature_refused", account_id: null, signed: !!signature }),
    );
    return refuse("unsigned", 403);
  }
  if (params.AccountSid !== env.accountSid) {
    console.warn(JSON.stringify({ event: "phone_other_account_refused", account_id: null }));
    return refuse("not this account", 403);
  }
  const rawStep = request.nextUrl.searchParams.get("step") ?? "start";
  if (!(STEPS as readonly string[]).includes(rawStep)) return refuse("no such step", 404);
  try {
    return xml(await handleVoice(rawStep as Step, params));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "phone_step_failed",
        account_id: null,
        step: rawStep,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return xml(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-GB">Sorry, something went wrong. Please call again later.</Say><Hangup/></Response>`,
    );
  }
}
