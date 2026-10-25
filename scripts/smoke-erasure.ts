// npm run smoke:erasure -- --account <uuid> [--email smoke@example.test] --yes
// A throwaway contact on a reserved domain, erased through the real path; see
// scripts/smoke/erasure.ts. The database modules load only after the script
// has decided to run, so a refusal never needs DATABASE_URL to parse.
import "dotenv/config";
import { runMain } from "./smoke/common";
import { runSmokeErasure } from "./smoke/erasure";
import { erasureDeps } from "./smoke/real-deps";

runMain(process.env, (print) =>
  runSmokeErasure({ env: process.env, argv: process.argv.slice(2), print, deps: erasureDeps }),
);
