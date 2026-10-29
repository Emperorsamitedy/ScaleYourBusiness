// The carts API — idea 47, abandoned carts.
//
//   GET  /api/carts                     what was left in carts over the last 30 days against
//                                       the 30 before, the products left behind, who can be
//                                       emailed (counts only), the likely-to-win-back range
//                                       with its rule of thumb, and today's reminder proposal
//   POST /api/carts {action:"propose"}  put a win-back email for the consented shoppers of
//                                       the last week in the approval queue
//
// Reading needs the intake cookie; proposing needs a signed-in user and a
// same-origin POST (isSameOriginPost), as the site audit does. A
// business with no store connection that reads carts gets `applies: false`
// and nothing else. No address, name or contact id ever leaves this route:
// the segment is counted here, and its ids stay on the proposal. Nothing
// here sends anything: the proposal waits for the owner (rule 12), and the
// send re-checks every recipient's consent (rule 23).

import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { proposals } from "../../../db/schema";
import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { careState } from "../../../lib/care/day-zero";
import { watchingUntil } from "../../../lib/care/watch-words";
import { cartsApply, loadCarts } from "../../../lib/carts/load";
import type { CartsMeasure } from "../../../lib/carts/measure";
import { CARTS, WIN_BACK } from "../../../lib/carts/measure";
import { abandonedCartSegment } from "../../../lib/carts/segment";
import { logSafeError } from "../../../lib/core/log-safe";
import { outboundPosture } from "../../../lib/crm/contacts";
import {
  CART_REF_PREFIX,
  SEGMENT_MODULE,
  proposeFromSegments,
  recentCartRecipients,
} from "../../../lib/crm/segment-proposals";
import { requireRole } from "../../../lib/auth/roles";

export interface CartsScreenView {
  applies: boolean;
  today?: string;
  sources?: { label: string; read_at: string | null; carts: number }[];
  measure?: CartsMeasure;
  /** product_ref → the owner's offer name, else the cart line's title. */
  product_names?: Record<string, string>;
  rule_of_thumb?: { label: string; statement: string; low: number; high: number };
  thresholds?: {
    window_days: number;
    min_days: number;
    min_carts: number;
    winback_min_days: number;
    winback_max_days: number;
    recontact_days: number;
  };
  /** The reminder as it would be proposed now: counts only. */
  reminder?: {
    emailable: number;
    in_segment: number;
    recently_proposed: number;
    unmatched_carts: number;
    no_consent: number;
    suppressed: number;
  };
  /** Today's reminder proposal, when one was made. */
  proposal?: { id: string; status: string; blocked_by_limit: string | null } | null;
  /** Why a reminder can't be proposed now, in the owner's words; null when it can. */
  held?: string | null;
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    if (!(await cartsApply(access.account_id))) {
      return NextResponse.json({ applies: false } satisfies CartsScreenView);
    }
    const now = new Date();
    const view = await loadCarts(access.account_id, access.profile_id, now);
    const segment = abandonedCartSegment(
      view.facts,
      await recentCartRecipients(access.profile_id, now),
    );
    const care = await careState(access.profile_id);
    const posture = await outboundPosture(access.profile_id);
    const held =
      care?.watch_ends_at && now.toISOString() < care.watch_ends_at
        ? watchingUntil(care.watch_ends_at)
        : posture === "disabled"
          ? "You told me your customers haven't agreed to marketing email, so I send none."
          : null;
    const [proposal] = await db
      .select({
        id: proposals.id,
        status: proposals.status,
        blocked_by_limit: proposals.blocked_by_limit,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.profile_id, access.profile_id),
          eq(proposals.module, SEGMENT_MODULE),
          eq(proposals.originating_finding, `${CART_REF_PREFIX}${view.today}`),
        ),
      );

    const body: CartsScreenView = {
      applies: true,
      today: view.today,
      sources: view.sources.map((s) => ({ label: s.label, read_at: s.read_at, carts: s.carts })),
      measure: view.measure,
      product_names: view.product_names,
      rule_of_thumb: {
        label: WIN_BACK.label,
        statement: WIN_BACK.statement,
        low: WIN_BACK.low,
        high: WIN_BACK.high,
      },
      thresholds: {
        window_days: CARTS.window_days,
        min_days: CARTS.min_days,
        min_carts: CARTS.min_carts,
        winback_min_days: CARTS.winback_min_days,
        winback_max_days: CARTS.winback_max_days,
        recontact_days: CARTS.recontact_days,
      },
      reminder: {
        emailable: segment.emailable_ids.length,
        in_segment: segment.contact_ids.length,
        recently_proposed: segment.recently_proposed,
        unmatched_carts: segment.unmatched_carts,
        no_consent: segment.excluded.no_consent + segment.excluded.no_email,
        suppressed: segment.excluded.suppressed,
      },
      proposal: proposal ?? null,
      held,
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "carts_view_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "this has to come from SYB's own page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  if (!(await matchingSession())) {
    return NextResponse.json({ error: "proposing needs you signed in" }, { status: 401 });
  }
  const denied = requireRole(access, "proposals.generate");
  if (denied) return denied;
  try {
    if (!(await cartsApply(access.account_id))) {
      return NextResponse.json({ error: "no shop connection reads carts" }, { status: 409 });
    }
    const body = (await request.json().catch(() => ({}))) as { action?: unknown };
    if (body.action !== "propose") {
      return NextResponse.json({ error: "unknown action" }, { status: 422 });
    }
    const run = await proposeFromSegments(access.profile_id, { only: "abandoned_cart" });
    return NextResponse.json({
      created: run.created.length,
      blocked: run.blocked.length,
      skipped: run.skipped,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "carts_post_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
