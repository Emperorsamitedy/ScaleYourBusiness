// P0-87/88 analysis: per-question hesitation, dwell, skips, unknowns and
// abandonment points across all recorded intakes. This output — not gut
// feel — decides which questions get rewritten in P0-88.
// Usage: npx tsx scripts/intake-report.ts

import "dotenv/config";
import { summarizeIntakeTelemetry } from "../lib/intake/telemetry";

function fmt(ms: number | null): string {
  if (ms === null) return "—";
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const rows = await summarizeIntakeTelemetry();
  if (rows.length === 0) {
    console.log("no intake events recorded yet");
    process.exit(0);
  }
  console.log("question   shown  ans  skip  unk  reopen  hesitation  dwell  ABANDONED");
  for (const r of rows) {
    console.log(
      [
        r.question_id.padEnd(10),
        String(r.shown).padStart(5),
        String(r.answered).padStart(4),
        String(r.skipped).padStart(5),
        String(r.unknown).padStart(4),
        String(r.reopened).padStart(7),
        fmt(r.median_hesitation_ms).padStart(11),
        fmt(r.median_dwell_ms).padStart(6),
        r.abandonments > 0 ? `  ← ${r.abandonments}` : "",
      ].join(" "),
    );
  }
  const worst = rows.filter((r) => r.abandonments > 0);
  if (worst.length > 0) {
    console.log(
      `\nabandonment points: ${worst.map((r) => `${r.question_id} (${r.abandonments})`).join(", ")}`,
    );
  }
  process.exit(0);
}

void main();
