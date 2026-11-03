// Compared with similar businesses — idea 44.
//
//   GET /api/benchmarks   the business's own figures set beside one named,
//                         dated Eurostat cell each (lib/benchmarks/compare.ts),
//                         from the committed snapshot. No network, no model.
//
// Read-only, and there is no POST: a benchmark is a reference, never a fact,
// a finding or a proposal (lib/benchmarks/fence.test.ts). Reading needs the
// intake cookie, as every owner screen does.
//
// L-4b: the sentences come back in the reader's language (the request's
// "benchmarksWords"), figures in its locale with the business's currency.
// Nothing here is stored, so nothing needs keeping in English.

import { NextResponse } from "next/server";
import { resolveAccess } from "../../../lib/auth/access";
import { logSafeError } from "../../../lib/core/log-safe";
import type { BenchResult } from "../../../lib/benchmarks/compare";
import { compareWithSimilar } from "../../../lib/benchmarks/compare";
import { loadBenchInputs } from "../../../lib/benchmarks/load";
import { BENCH_WORDS } from "../../../lib/benchmarks/map";
import { SNAPSHOT } from "../../../lib/benchmarks/snapshot";
import { requestWords } from "../../../lib/i18n/request-words";

export interface BenchView {
  result: BenchResult;
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const [inputs, words] = await Promise.all([
      loadBenchInputs(access.profile_id),
      requestWords(BENCH_WORDS),
    ]);
    const view: BenchView = { result: compareWithSimilar(inputs, SNAPSHOT, words) };
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
