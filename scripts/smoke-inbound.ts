// npm run smoke:inbound -- --profile <uuid> --from you@your-domain [--timeout 180]
// Watches (read-only) for the ticket your test email becomes; see
// scripts/smoke/inbound.ts. The database modules load only after the script
// has decided to run, so a refusal never needs DATABASE_URL to parse.
import "dotenv/config";
import { runMain } from "./smoke/common";
import { runSmokeInbound } from "./smoke/inbound";
import { inboundDeps } from "./smoke/real-deps";

runMain(process.env, (print) =>
  runSmokeInbound({ env: process.env, argv: process.argv.slice(2), print, deps: inboundDeps }),
);
