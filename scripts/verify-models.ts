// M-1 — the Haiku 5.5 move (PR #34) checked against the real API.
//
// The eight checks PR #34 listed, each through the app's OWN live LLM
// function (the same code path production runs, real client) on synthetic
// inputs only (lib/llm/verify-run.ts). A tape on the client records every
// response; the app's own llm_call lines are captured as it logs them.
// lib/llm/verify-models.ts judges them into numbered PASS / FAIL lines
// with the measured facts.
//
// Writes nothing but the llm_calls rows the app itself writes, all under
// one synthetic account id (printed at the end). Exits 0 when all eight
// pass, 1 when any fails, 2 when it refuses to run.
//
//   npm run verify:models -- --help

import "dotenv/config";
import { costCeilingEur, PLANNED_CALLS, summarize, VERIFY_MODEL } from "../lib/llm/verify-models";

/** Every llm_calls row this script causes is filed under this id — no real account. */
const VERIFY_ACCOUNT_ID = "00000000-0000-4000-8000-00000000a1a1";

const HELP = `npm run verify:models -- --yes [--database <postgres url>]

Runs PR #34's eight real-API checks of the Haiku 5.5 move (TASKS-FEEDBACK
M-1) through the app's own live functions, on synthetic inputs only, and
prints numbered PASS / FAIL lines with the measured facts.

  --yes               required: spend the (pennies) estimated up front
  --database <url>    the database the app's llm_calls rows go to.
                      Recommended: a scratch or local database, e.g.
                      postgresql://syb:syb_local_dev@127.0.0.1:5433/syb
                      Default: DATABASE_URL from .env.

Needs ANTHROPIC_API_KEY. Writes nothing but llm_calls rows, all under the
synthetic account ${VERIFY_ACCOUNT_ID}.`;

function parseArgs(argv: readonly string[]): {
  yes: boolean;
  database: string | null;
  help: boolean;
} {
  const out = { yes: false, database: null as string | null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") out.yes = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--database") out.database = argv[++i] ?? null;
    else if (a?.startsWith("--database=")) out.database = a.slice("--database=".length);
    else throw new Error(`unknown argument "${a}" — see --help`);
  }
  return out;
}

/* ── the run ── */

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("refusing: ANTHROPIC_API_KEY is not set — these checks call the real API.\n");
    console.error(HELP);
    return 2;
  }
  if (args.database !== null) process.env.DATABASE_URL = args.database;

  const ceiling = costCeilingEur();
  console.log(
    `verify:models — ${PLANNED_CALLS.length} planned call groups on ${VERIFY_MODEL}, plus one free count_tokens`,
  );
  for (const c of PLANNED_CALLS) {
    console.log(
      `  · ${c.label}: ≤${c.max_tokens} output tokens, ~${c.input_tokens} input, ${c.searches} search(es)`,
    );
  }
  console.log(
    `estimated ceiling: €${ceiling.toFixed(3)} (every call at its whole output cap; real runs cost less)`,
  );
  console.log(
    `llm_calls rows go to: ${redact(process.env.DATABASE_URL ?? "(DATABASE_URL unset)")}`,
  );
  if (!args.yes) {
    console.error("\nnot spending anything without --yes. Re-run: npm run verify:models -- --yes");
    return 2;
  }

  // Imported only now: the database pool reads DATABASE_URL at import.
  const { runVerifyModels } = await import("../lib/llm/verify-run");
  const { verdicts, spent_eur } = await runVerifyModels({ accountId: VERIFY_ACCOUNT_ID });

  const { passed, failed } = summarize(verdicts);
  console.log(
    `\n${passed} passed, ${failed} failed · logged €${spent_eur.toFixed(5)} of a €${ceiling.toFixed(3)} ceiling`,
  );
  console.log(`llm_calls rows are under account ${VERIFY_ACCOUNT_ID}; delete them with`);
  console.log(`  DELETE FROM llm_calls WHERE account_id = '${VERIFY_ACCOUNT_ID}';`);
  return failed === 0 ? 0 : 1;
}

function redact(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@/]*@/, "//$1:***@");
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(2);
  },
);
