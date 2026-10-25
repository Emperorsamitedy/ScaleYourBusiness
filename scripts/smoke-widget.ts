// npm run smoke:widget -- --profile <uuid>
// The site key, the snippet and the test page, and what to try; see
// scripts/smoke/widget.ts. Read-only. The database modules load only after
// the script has decided to run, so a refusal never needs DATABASE_URL to parse.
import "dotenv/config";
import { runMain } from "./smoke/common";
import { runSmokeWidget } from "./smoke/widget";
import { widgetDeps } from "./smoke/real-deps";

runMain(process.env, (print) =>
  runSmokeWidget({ env: process.env, argv: process.argv.slice(2), print, deps: widgetDeps }),
);
