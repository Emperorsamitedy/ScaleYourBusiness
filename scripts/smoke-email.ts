// npm run smoke:email -- --to you@your-domain [--yes]
// One sign-in email through the real sendLoginEmail path; see scripts/smoke/email.ts.
import "dotenv/config";
import { sendLoginEmail } from "../lib/auth/email";
import { runMain } from "./smoke/common";
import { runSmokeEmail } from "./smoke/email";

runMain(process.env, (print) =>
  runSmokeEmail({
    env: process.env,
    argv: process.argv.slice(2),
    print,
    deps: { send: sendLoginEmail },
  }),
);
