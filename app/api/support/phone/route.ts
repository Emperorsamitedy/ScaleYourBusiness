// The OWNER'S phone line API — P6-02, on the /support screen.
//
//   GET  /api/support/phone              whether the line can run, its settings, the calls
//   GET  /api/support/phone?call=<id>    one call's transcript
//   POST /api/support/phone {action}     phone_on | phone_off | set_handover | erase_call
//
// Reading needs the intake cookie like every profile surface; every
// mutation needs a signed-in person with the role for it (lib/auth/roles),
// from our own origin, exactly as /api/support. Nothing here calls Twilio:
// the line is set up by pointing the number's webhooks at this app, which
// the screen spells out.

import { type NextRequest, NextResponse } from "next/server";
import { matchingSession, resolveAccess } from "../../../../lib/auth/access";
import type { RoleAction } from "../../../../lib/auth/roles";
import { requireRole } from "../../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import { twilioEnv, twilioMissing } from "../../../../lib/env";
import { requestTr } from "../../../../lib/i18n/request-tr";
import type { Tr } from "../../../../lib/i18n/tr";
import { STEPS, VOICE_PATH } from "../../../../lib/phone/line";
import { lineForProfile } from "../../../../lib/phone/settings";
import {
  PhoneDeskError,
  disablePhoneLine,
  enablePhoneLine,
  eraseCall,
  listCalls,
  readCall,
  setHandoverNumber,
} from "../../../../lib/phone-desk/desk";

/** The desk's refusals, in the reader's words — the key under support.phone.error. */
const ERROR_KEYS: Record<string, string> = {
  "the phone line is not set up on this server": "notSetUp",
  "that number already answers for another business": "taken",
  "the phone line is not on": "notOn",
  "write the number with its country code, starting with +": "badNumber",
  "no such call": "noCall",
};

function onError(error: unknown, tr: Tr): NextResponse {
  if (error instanceof PhoneDeskError) {
    const key = ERROR_KEYS[error.message];
    return NextResponse.json(
      { error: key ? tr(`phone.error.${key}`) : error.message },
      { status: error.status },
    );
  }
  console.error(JSON.stringify({ event: "phone_desk_error", ...logSafeError(error) }));
  return NextResponse.json({ error: tr("failed") }, { status: 500 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const { tr } = await requestTr("support");
  try {
    const callId = request.nextUrl.searchParams.get("call");
    if (callId) {
      return NextResponse.json({ turns: await readCall(access.profile_id, callId) });
    }
    const origin = process.env.APP_URL?.replace(/\/$/, "") || request.nextUrl.origin;
    const [line, calls] = await Promise.all([
      lineForProfile(access.profile_id),
      listCalls(access.profile_id),
    ]);
    return NextResponse.json({
      missing: twilioMissing(),
      number: twilioEnv()?.phoneNumber ?? null,
      voice_url: `${origin}${VOICE_PATH}`,
      status_url: `${origin}${VOICE_PATH}?step=${STEPS[4]}`,
      line: line
        ? {
            phone_number: line.phone_number,
            enabled: line.enabled,
            handover_number: line.handover_number,
          }
        : null,
      calls,
    });
  } catch (error) {
    return onError(error, tr);
  }
}

const PHONE_ROLE: Record<string, RoleAction> = {
  phone_on: "support.settings",
  phone_off: "support.settings",
  set_handover: "support.settings",
  erase_call: "erasure.run",
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { tr } = await requestTr("support");
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    console.warn(JSON.stringify({ event: "phone_cross_site_refused", account_id: null }));
    return NextResponse.json({ error: tr("phone.error.crossSite") }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const session = await matchingSession();
  if (!session) return NextResponse.json({ error: tr("phone.error.signIn") }, { status: 401 });
  try {
    const body = (await request.json()) as {
      action?: unknown;
      number?: unknown;
      call_id?: unknown;
    };
    const denied = requireRole(session, PHONE_ROLE[String(body.action)] ?? "support.settings");
    if (denied) return denied;
    switch (body.action) {
      case "phone_on": {
        const line = await enablePhoneLine(access.profile_id);
        return NextResponse.json({ phone_number: line.phone_number, enabled: line.enabled });
      }
      case "phone_off":
        await disablePhoneLine(access.profile_id);
        return NextResponse.json({ enabled: false });
      case "set_handover": {
        if (typeof body.number !== "string") {
          return NextResponse.json({ error: tr("phone.error.badNumber") }, { status: 422 });
        }
        const number = await setHandoverNumber(access.profile_id, body.number);
        return NextResponse.json({ handover_number: number });
      }
      case "erase_call": {
        // GDPR erasure of one call (rule 22). Irreversible, so signed-in only.
        if (typeof body.call_id !== "string") {
          return NextResponse.json({ error: tr("phone.error.noCall") }, { status: 422 });
        }
        await eraseCall(session.account_id, body.call_id);
        return NextResponse.json({ erased: true });
      }
      default:
        return NextResponse.json({ error: tr("phone.error.action") }, { status: 422 });
    }
  } catch (error) {
    return onError(error, tr);
  }
}
