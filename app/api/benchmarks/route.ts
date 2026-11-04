// Compared with similar businesses — idea 44.
//
//   GET /api/benchmarks   the business's own figures set beside one named,
//                         dated Eurostat cell each (lib/benchmarks/compare.ts),
//                         from the committed snapshot. No network, no model.
//
// Read-only, and there is no POST: a benchmark is a reference, never a fact
// on the profile (lib/benchmarks/fence.test.ts). Reading needs the intake
// cookie, as every owner screen does.
//
// I-44a: it also says whether the margin's gap is large (lib/benchmarks/gap,
// a stated threshold, like for like), and the margin review proposed for it
// this month, if any. Proposing is POST /api/proposals/margin-review.
//
// L-4b: the sentences come back in the reader's language (the request's
// "benchmarksWords"), figures in its locale with the business's currency.
// Nothing here is stored, so nothing needs keeping in English.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { proposals } from "../../../db/schema";
import { resolveAccess } from "../../../lib/auth/access";
import { careState } from "../../../lib/care/day-zero";
import { watchingUntil } from "../../../lib/care/watch-words";
import { logSafeError } from "../../../lib/core/log-safe";
import type { BenchResult } from "../../../lib/benchmarks/compare";
import { compareWithSimilar } from "../../../lib/benchmarks/compare";
import type { LargeGap } from "../../../lib/benchmarks/gap";
import { largeGap } from "../../../lib/benchmarks/gap";
import { loadBenchInputs } from "../../../lib/benchmarks/load";
import { BENCH_WORDS } from "../../../lib/benchmarks/map";
import { SNAPSHOT } from "../../../lib/benchmarks/snapshot";
import { requestWords } from "../../../lib/i18n/request-words";
import { marginReviewRef } from "../../../lib/proposals/margin-review";

export interface BenchView {
  result: BenchResult;
  /** I-44a: the margin's gap when it is large and like for like; else null. */
  gap: LargeGap | null;
  /** The margin review proposed this month, if any. */
  proposal: { id: string; status: string; blocked_by_limit: string | null } | null;
  /** Why a review can't be proposed yet, when it can't (rule 15). */
  held: string | null;
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const now = new Date();
    const [inputs, words] = await Promise.all([
      loadBenchInputs(access.profile_id, now),
      requestWords(BENCH_WORDS),
    ]);
    const result = compareWithSimilar(inputs, SNAPSHOT, words);
    const gap = largeGap(result, inputs);
    let proposal: BenchView["proposal"] = null;
    let held: string | null = null;
    if (gap) {
      const [[row], care] = await Promise.all([
        db
          .select({
            id: proposals.id,
            status: proposals.status,
            blocked_by_limit: proposals.blocked_by_limit,
          })
          .from(proposals)
          .where(
            and(
              eq(proposals.profile_id, access.profile_id),
              eq(proposals.originating_finding, marginReviewRef(now)),
            ),
          ),
        careState(access.profile_id),
      ]);
      proposal = row ?? null;
      held = !care
        ? "I propose once you've chosen how I work for you."
        : care.watch_ends_at && now.toISOString() < care.watch_ends_at
          ? watchingUntil(care.watch_ends_at)
          : null;
    }
    const view: BenchView = { result, gap, proposal, held };
    return NextResponse.json(view);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "benchmarks_read_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on my side" }, { status: 500 });
  }
}
