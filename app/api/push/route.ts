// Phone alerts — idea 53 (I-53.2, I-53.3).
//
//   GET  /api/push   { signed_in, configured, public_key, devices }
//   POST /api/push   { action: "subscribe", subscription, time_zone }
//                    { action: "remove", id }
//                    { action: "test" }
//
// Signed-in owner only, behind the one door (lib/auth/access): a device is
// tied to the sign-in that switched it on, and the yes an alert leads to is
// recorded with a name. Every POST must come from SYB's own page
// (isSameOriginPost). Nothing a browser sends is echoed back, and no
// endpoint or key ever leaves this route: the screen sees labels and dates.

import { type NextRequest, NextResponse } from "next/server";
import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { logSafeError } from "../../../lib/core/log-safe";
import { pushServiceSetting } from "../../../lib/env";
import { sendTestPush } from "../../../lib/push/deliver";
import { pushConfig } from "../../../lib/push/send";
import {
  listDevices,
  parseSubscription,
  removeDevice,
  saveSubscription,
} from "../../../lib/push/subscriptions";
import { requireRole } from "../../../lib/auth/roles";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function owner() {
  const access = await resolveAccess();
  if (!access) return null;
  const session = await matchingSession();
  return session ? { access, session } : null;
}

export async function GET(): Promise<NextResponse> {
  const who = await owner();
  const cfg = pushConfig();
  const configured = cfg.ok && cfg.publicKey !== null;
  if (!who) {
    return NextResponse.json({ signed_in: false, configured, public_key: null, devices: [] });
  }
  try {
    return NextResponse.json({
      signed_in: true,
      configured,
      // The VAPID PUBLIC key: the browser's applicationServerKey. Public by design.
      public_key: cfg.ok ? cfg.publicKey : null,
      // Idea 52: your own devices only.
      devices: await listDevices(
        who.session.account_id,
        who.session.session_id ?? null,
        who.session.user_id,
      ),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "push_devices_failed",
        account_id: who.session.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

interface PushBody {
  action?: unknown;
  subscription?: unknown;
  time_zone?: unknown;
  id?: unknown;
}

const TEST_WORDS: Record<string, string> = {
  sent: "sent",
  gone: "gone: the phone no longer takes alerts, so I removed it",
  failed: "not sent",
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "this has to come from ScaleX's own page" }, { status: 403 });
  }
  const who = await owner();
  if (!who) {
    return NextResponse.json(
      { error: "phone alerts need you signed in: they lead to decisions with your name" },
      { status: 401 },
    );
  }
  const accountId = who.session.account_id;
  const body = (await request.json().catch(() => ({}))) as PushBody;
  // Idea 52: alerts are for people who may decide; removing your own phone is always allowed.
  const denied = requireRole(
    who.session,
    body.action === "remove" ? "alerts.remove_device" : "alerts.subscribe",
  );
  if (denied) return denied;
  try {
    if (body.action === "subscribe") {
      const cfg = pushConfig();
      if (!cfg.ok || cfg.publicKey === null) {
        return NextResponse.json(
          { error: "this server can't send phone alerts yet" },
          { status: 409 },
        );
      }
      const target = parseSubscription(body.subscription, {
        allowFake: pushServiceSetting() === "fake",
      });
      if (typeof target === "string") {
        return NextResponse.json({ error: target }, { status: 422 });
      }
      const saved = await saveSubscription({
        accountId,
        userId: who.session.user_id,
        sessionId: who.session.session_id ?? null,
        userAgent: request.headers.get("user-agent"),
        target,
        timeZone: body.time_zone,
      });
      console.log(
        JSON.stringify({
          event: "push_device_on",
          account_id: accountId,
          subscription_id: saved.id,
          device_label: saved.device_label,
        }),
      );
      return NextResponse.json({ on: true, device_label: saved.device_label });
    }

    if (body.action === "remove") {
      if (typeof body.id !== "string" || !UUID_RE.test(body.id)) {
        return NextResponse.json({ error: "which device?" }, { status: 422 });
      }
      const removed = await removeDevice(accountId, body.id, who.session.user_id);
      if (!removed) return NextResponse.json({ error: "no such device" }, { status: 404 });
      console.log(
        JSON.stringify({
          event: "push_device_off",
          account_id: accountId,
          subscription_id: body.id,
        }),
      );
      return NextResponse.json({ removed: true });
    }

    if (body.action === "test") {
      const cfg = pushConfig();
      if (!cfg.ok) {
        return NextResponse.json(
          { error: "this server can't send phone alerts yet" },
          { status: 409 },
        );
      }
      const outcomes = await sendTestPush(accountId, cfg.service, who.session.user_id);
      if (outcomes.length === 0) {
        return NextResponse.json({ error: "no device is switched on yet" }, { status: 409 });
      }
      return NextResponse.json({
        results: outcomes.map((o) => ({
          label: o.label,
          result: o.outcome.kind,
          words:
            o.outcome.kind === "failed"
              ? `${TEST_WORDS.failed}: ${o.outcome.why}`
              : TEST_WORDS[o.outcome.kind],
        })),
      });
    }

    return NextResponse.json(
      { error: 'action must be "subscribe", "remove" or "test"' },
      { status: 422 },
    );
  } catch (error) {
    console.error(
      JSON.stringify({ event: "push_route_failed", account_id: accountId, ...logSafeError(error) }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
