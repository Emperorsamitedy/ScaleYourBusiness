// The proposals API — Phase 3 Session A (P3-05/07).
//
//   GET  /api/proposals   the swept, grouped queue (+ pending count for badges)
//   POST /api/proposals   generate from the latest report and open interrupts
//   PUT  /api/proposals   decide — approve, decline, or request changes;
//                         one id or a bulk list
//
// Reading needs the intake cookie, like every profile surface. DECIDING
// needs a signed-in user: the schema itself refuses an approval without
// a human id (P3-01), so an unauthenticated decide is a 401 here rather
// than a constraint violation later. Bulk is a loop, deliberately —
// every proposal gets its own conditional-update guard and its own
// decision-log entry; there is no "approve all" shortcut around rule 12.

import { logSafeError } from "../../../lib/core/log-safe";
import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { fieldRecords, proposals } from "../../../db/schema";
import { readEvidence, sourceFieldsOf } from "../../../lib/proposals/evidence";
import { generateProposals } from "../../../lib/proposals/generate";
import {
  ProposalError,
  approveProposal,
  proposalQueue,
  rejectProposal,
  requestChanges,
} from "../../../lib/proposals/service";
import { languageOf, refusalFor, requireRole, roleAllows, roleOf } from "../../../lib/auth/roles";
import { trFor } from "../../../lib/i18n/server-tr";
import { PAYMENTS_MODULE } from "../../../lib/payments/store";

async function resolveProfile(): Promise<string | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  return (await resolveAccess())?.profile_id ?? null;
}

/** The masthead's business name — identity.legal_name, as the menu reads it. Null when unrecorded. */
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

function onError(error: unknown): NextResponse {
  if (error instanceof ProposalError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ event: "proposals_error", ...logSafeError(error) }));
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const queue = await proposalQueue(profileId);
    // The evidence lines' basis and any open disagreement, for the fields
    // the pending proposals' assumptions name (lib/proposals/evidence).
    const [business, evidence] = await Promise.all([
      businessName(profileId),
      readEvidence(profileId, sourceFieldsOf(queue.pending.map((p) => p.scenario))),
    ]);
    return NextResponse.json({
      ...queue,
      pending_count: queue.pending.length,
      business,
      facts: evidence.facts,
      disagreements: evidence.disagreements,
    });
  } catch (error) {
    return onError(error);
  }
}

export async function POST(): Promise<NextResponse> {
  const access = await resolveAccess();
  const profileId = access?.profile_id ?? null;
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "proposals.generate");
  if (denied) return denied;
  try {
    const outcome = await generateProposals(profileId);
    return NextResponse.json({
      created: outcome.created.length,
      blocked: outcome.blocked.length,
      skipped: outcome.skipped,
    });
  } catch (error) {
    return onError(error);
  }
}

interface DecideBody {
  ids?: unknown;
  decision?: unknown;
  reason?: unknown;
  /** request_changes: the owner's words on what should be different. */
  changes?: unknown;
  execute_not_before?: unknown;
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });

  const session = await matchingSession();
  if (!session) {
    return NextResponse.json(
      { error: "deciding needs you signed in — approvals carry your name" },
      { status: 401 },
    );
  }
  const denied = requireRole(session, "proposals.decide");
  if (denied) return denied;

  const body = (await request.json()) as DecideBody;
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids must be a non-empty list" }, { status: 422 });
  }
  if (
    body.decision !== "approve" &&
    body.decision !== "reject" &&
    body.decision !== "request_changes"
  ) {
    return NextResponse.json(
      { error: 'decision must be "approve", "reject" or "request_changes"' },
      { status: 422 },
    );
  }
  if (
    body.decision === "request_changes" &&
    (typeof body.changes !== "string" || body.changes.trim() === "")
  ) {
    return NextResponse.json(
      { error: "asking for changes needs the changes — say what should be different" },
      { status: 422 },
    );
  }
  if (
    body.decision === "reject" &&
    (typeof body.reason !== "string" || body.reason.trim() === "")
  ) {
    return NextResponse.json(
      { error: "declining asks why — the reason is required" },
      { status: 422 },
    );
  }
  const executeNotBefore =
    typeof body.execute_not_before === "string" &&
    !Number.isNaN(Date.parse(body.execute_not_before))
      ? new Date(body.execute_not_before).toISOString()
      : null;

  const decided: string[] = [];
  const failed: { id: string; error: string }[] = [];
  // P6-05 (rule 26 amended): a payment is the owner's to decide. A manager
  // decides everything else in the queue, never a prepared payment.
  const role = roleOf(session);
  const ownerOnly = new Set<string>();
  if (role === null || !roleAllows(role, "payments.prepare")) {
    const uuids = ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x));
    const rows =
      uuids.length === 0
        ? []
        : await db
            .select({ id: proposals.id })
            .from(proposals)
            .where(
              and(
                inArray(proposals.id, uuids),
                eq(proposals.profile_id, profileId),
                eq(proposals.module, PAYMENTS_MODULE),
              ),
            );
    for (const r of rows) ownerOnly.add(r.id);
  }
  for (const id of ids) {
    if (ownerOnly.has(id)) {
      failed.push({
        id,
        error: refusalFor("payments.prepare", trFor(languageOf(session), "roleWords")),
      });
      continue;
    }
    try {
      if (body.decision === "approve") {
        await approveProposal({
          proposalId: id,
          userId: session.user_id,
          executeNotBefore,
          profileId,
        });
      } else if (body.decision === "request_changes") {
        await requestChanges({
          proposalId: id,
          userId: session.user_id,
          words: body.changes as string,
          profileId,
        });
      } else {
        await rejectProposal({
          proposalId: id,
          userId: session.user_id,
          reason: body.reason as string,
          profileId,
        });
      }
      decided.push(id);
    } catch (error) {
      failed.push({
        id,
        error: error instanceof ProposalError ? error.message : "something went wrong",
      });
    }
  }
  return NextResponse.json(
    { decided, failed },
    { status: failed.length > 0 && decided.length === 0 ? 409 : 200 },
  );
}
