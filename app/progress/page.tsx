// /progress — Insights · Goals (Session J, P3-42..47; the owner's Goals design).
//
// The weekly candles are read here, on the server, behind the same door
// every profile route uses (lib/auth/access): a goal's series is many
// daily rows, and only its weekly candles need to reach the browser.

import type { Metadata } from "next";
import { ProgressScreen } from "../../components/care/ProgressScreen";
import { resolveAccess } from "../../lib/auth/access";
import type { GoalChart } from "../../lib/care/charts";
import { loadGoalCharts } from "../../lib/care/charts";
import { logSafeError } from "../../lib/core/log-safe";

export const metadata: Metadata = { title: "Goals — Ledgerline" };
export const dynamic = "force-dynamic";

export default async function ProgressPage() {
  let charts: GoalChart[] | null = null;
  try {
    const access = await resolveAccess();
    if (access) charts = await loadGoalCharts(access.profile_id);
  } catch (error) {
    // The charts are a read; the cards still show their figures without them.
    console.error(JSON.stringify({ event: "goal_charts_failed", ...logSafeError(error) }));
  }
  return <ProgressScreen charts={charts} />;
}
