// GET /api/watch — the watching status screen's read (P1-47): the
// current decision, the honest activity log, days remaining, the
// thresholds that would trigger an interruption, and (P2-24) any
// interruption that has actually happened. All of it is stored fact;
// nothing here is generated.

import { resolveAccess } from "../../../lib/auth/access";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles, fieldRecords } from "../../../db/schema";
import { openInterruptions } from "../../../lib/anomaly/detect";
import { thresholdTexts } from "../../../lib/anomaly/thresholds";
import { latestDecision } from "../../../lib/mode/service";
import { watchLog } from "../../../lib/watch/job";

export async function GET(): Promise<NextResponse> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  const profileId = (await resolveAccess())?.profile_id;
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const [row] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!row) return NextResponse.json({ error: "no intake session" }, { status: 401 });

  const decision = await latestDecision(profileId);
  const log = await watchLog(profileId);
  const goals = await goalStatements(profileId, log);
  const daysRemaining =
    decision?.mode === "watching"
      ? Math.max(0, Math.ceil((Date.parse(decision.review_at) - Date.now()) / 86_400_000))
      : null;

  return NextResponse.json({
    decision,
    days_remaining: daysRemaining,
    // The rules as code (P2-24), each saying whether anything enforces it yet.
    thresholds: thresholdTexts(),
    interruptions: await openInterruptions(profileId),
    log: log.map((entry) => ({
      at: entry.at,
      kind: entry.kind,
      detail: entry.detail,
      // A goal's weekly check says which goal it is about: three goals
      // checked on one morning otherwise read as one line three times.
      subject: goals.get(goalIdOf(entry.meta) ?? "") ?? null,
      // 2026-11-23, Watching said plainly: a goal's verdict and the day it
      // can first be judged, from what the check stored beside its sentence.
      ...goalCheckOf(entry.kind, entry.meta),
    })),
  });
}

/** A goal check's verdict and, while it is too soon, the day judging starts (lib/care/progress explain). */
function goalCheckOf(kind: string, meta: unknown): { verdict?: string; judged_from?: string } {
  if (kind !== "goal_progress") return {};
  const m = meta as {
    verdict?: unknown;
    explain?: { kind?: unknown; from?: unknown; until?: unknown; ends?: unknown };
  } | null;
  const verdict = typeof m?.verdict === "string" ? m.verdict : undefined;
  const e = m?.explain;
  const day =
    e?.kind === "under_care"
      ? e.from
      : e?.kind === "watching"
        ? e.until
        : e?.kind === "goal_new"
          ? e.ends
          : null;
  return {
    ...(verdict ? { verdict } : {}),
    ...(typeof day === "string" ? { judged_from: day.slice(0, 10) } : {}),
  };
}

const goalIdOf = (meta: unknown): string | null => {
  const id = (meta as { goal_id?: unknown } | null)?.goal_id;
  return typeof id === "string" ? id : null;
};

/** Each logged goal's statement, as the owner wrote it. */
async function goalStatements(
  profileId: string,
  log: readonly { meta: unknown }[],
): Promise<Map<string, string>> {
  const ids = [...new Set(log.map((e) => goalIdOf(e.meta)).filter((id) => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ key: fieldRecords.field_key, value: fieldRecords.value })
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        isNull(fieldRecords.superseded_at),
        inArray(
          fieldRecords.field_key,
          ids.map((id) => `goals.${id}.statement`),
        ),
      ),
    );
  const out = new Map<string, string>();
  for (const r of rows) {
    if (typeof r.value === "string" && r.value.trim() !== "")
      out.set(r.key.split(".")[1] ?? "", r.value.trim());
  }
  return out;
}
