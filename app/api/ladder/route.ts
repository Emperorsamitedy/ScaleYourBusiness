// /api/ladder — the Trust Ladder screen (the v1 spec §4.6).
//
//   GET   every capability with its station, ceiling, ledger record and what
//         the next step still needs; standing rules; unseen notices
//   POST  { op, ... } — the owner's changes, each checked on the server:
//           station   { capability, to }   lower any time; raise on evidence only
//           request   { capability }       ask for station 4 (the first step)
//           confirm   { request_id }       the separate confirmation (the second)
//           caps      { capability, caps } set station 4's limits
//           rule_add  { scope, condition, action, words, days? }
//           rule_renew { rule_id }   rule_retire { rule_id }
//           seen      { notice_id }
//
// Reading is anyone signed in to the business; every change is the owner's
// (ladder.manage). There is no switch here that raises everything at once,
// and none may be added: promotion is per capability (§4.3).

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../lib/auth/access";
import { requireRole } from "../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { logSafeError } from "../../../lib/core/log-safe";
import type { CapsInput } from "../../../lib/ladder/caps";
import { setCaps } from "../../../lib/ladder/caps";
import type { Station } from "../../../lib/ladder/ladder";
import { CAPABILITIES, LadderError } from "../../../lib/ladder/ladder";
import { ladderOverview, markNoticeSeen } from "../../../lib/ladder/overview";
import { changeStation, confirmPromotion, requestPromotion } from "../../../lib/ladder/promotion";
import type { RuleAction } from "../../../lib/ladder/standing-rules";
import {
  addStandingRule,
  renewStandingRule,
  retireStandingRule,
} from "../../../lib/ladder/standing-rules";

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    return NextResponse.json(await ladderOverview(access.profile_id, access.account_id));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "ladder_view_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on my side" }, { status: 500 });
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "that has to come from SYB itself" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  if (!access.session)
    return NextResponse.json({ error: "this needs you signed in" }, { status: 401 });
  const denied = requireRole(access, "ladder.manage");
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const by = access.session.user_id;
  const ids = { profileId: access.profile_id, accountId: access.account_id };
  const capability = str(body?.capability);
  const known = () => {
    if (!CAPABILITIES.includes(capability)) throw new LadderError("unknown capability", 422);
  };
  try {
    switch (str(body?.op)) {
      case "station": {
        known();
        const to = Number(body?.to);
        if (![1, 2, 3].includes(to))
          throw new LadderError("station 4 is asked for and confirmed separately", 422);
        await changeStation({ ...ids, capability, to: to as Station, by });
        break;
      }
      case "request":
        known();
        return NextResponse.json(await requestPromotion({ ...ids, capability, by }));
      case "confirm":
        await confirmPromotion({ ...ids, requestId: str(body?.request_id), by });
        break;
      case "caps":
        known();
        await setCaps({
          profileId: access.profile_id,
          capability,
          caps: body?.caps as CapsInput,
          by,
        });
        break;
      case "rule_add":
        await addStandingRule({
          profileId: access.profile_id,
          scope: str(body?.scope),
          condition: body?.condition,
          action: str(body?.action) as RuleAction,
          words: str(body?.words),
          by,
          ...(typeof body?.days === "number" ? { days: body.days } : {}),
        });
        break;
      case "rule_renew":
        await renewStandingRule({ profileId: access.profile_id, ruleId: str(body?.rule_id) });
        break;
      case "rule_retire":
        await retireStandingRule({ profileId: access.profile_id, ruleId: str(body?.rule_id) });
        break;
      case "seen":
        await markNoticeSeen(access.profile_id, str(body?.notice_id));
        break;
      default:
        return NextResponse.json({ error: "unknown change" }, { status: 422 });
    }
    return NextResponse.json(await ladderOverview(access.profile_id, access.account_id));
  } catch (error) {
    if (error instanceof LadderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "ladder_change_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on my side" }, { status: 500 });
  }
}
