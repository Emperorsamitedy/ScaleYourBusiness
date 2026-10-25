// M-2 — the recalibration run that must come before SONNET_MODEL or
// DIAGNOSIS_MODEL is ever moved.
//
// Diagnosis mode (default): each business's stored snapshot is diagnosed
// by BOTH claude-opus-4-8 and claude-opus-5-5 with the same prompt, and the
// two are compared side by side — findings count, findings matched by
// topic, severity differences, grounding validity (the app's own P1-24
// check), refusals, tokens and cost. --sonnet instead compares the
// interviewer's next-question pick on claude-sonnet-5 and claude-sonnet-5-5
// over stored intake states.
//
// Writes nothing to any profile and persists no report: the only rows are
// the llm_calls rows every model call writes, under a synthetic account.
// The markdown goes to --out. Exits 0 when it ran, 2 when it refused.
//
//   npm run recalibrate:diagnosis -- --help

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Every llm_calls row this run causes is filed here — no business's spend moves. */
const RECALIBRATE_ACCOUNT_ID = "00000000-0000-4000-8000-00000000ca1b";

const HELP = `npm run recalibrate:diagnosis -- --yes [--profiles <id,id,…> | --latest N]
                                   [--sonnet] [--out <file.md>] [--database <url>]

Runs the diagnosis on each business's STORED snapshot with claude-opus-4-8 and
claude-opus-5-5 and compares them (TASKS-FEEDBACK M-2). Nothing is written to
any profile and no report is saved; only llm_calls rows, under the synthetic
account ${RECALIBRATE_ACCOUNT_ID}.

  --profiles <ids>    comma-separated profile ids
  --latest N          the N most recently reported businesses (default 5)
  --sonnet            compare the interviewer's next-question pick on
                      claude-sonnet-5 vs claude-sonnet-5-5 instead, over the
                      profiles' stored intake states (--latest: newest profiles)
  --out <file.md>     the markdown report (default var/recalibrate-<mode>-<date>.md)
  --yes               required: spend the estimate printed first
  --database <url>    the database to read the snapshots from and write
                      llm_calls to. Default: DATABASE_URL from .env. The real
                      businesses live in production; a restored copy of it is
                      the safer place to point this.

Needs ANTHROPIC_API_KEY.`;

interface Args {
  yes: boolean;
  help: boolean;
  sonnet: boolean;
  profiles: string[];
  latest: number | null;
  out: string | null;
  database: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {
    yes: false,
    help: false,
    sonnet: false,
    profiles: [],
    latest: null,
    out: null,
    database: null,
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") out.yes = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--sonnet") out.sonnet = true;
    else if (a === "--profiles") {
      out.profiles = value(++i, a)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--latest") {
      const n = Number(value(++i, a));
      if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("--latest takes 1 to 50");
      out.latest = n;
    } else if (a === "--out") out.out = value(++i, a);
    else if (a === "--database") out.database = value(++i, a);
    else throw new Error(`unknown argument "${a}" — see --help`);
  }
  if (out.profiles.length > 0 && out.latest !== null) {
    throw new Error("give --profiles or --latest, not both");
  }
  return out;
}

function redact(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@/]*@/, "//$1:***@");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("refusing: ANTHROPIC_API_KEY is not set — this run calls the real API.\n");
    console.error(HELP);
    return 2;
  }
  if (args.database !== null) process.env.DATABASE_URL = args.database;
  const mode = args.sonnet ? "sonnet" : "diagnosis";
  const outPath = args.out ?? `var/recalibrate-${mode}-${new Date().toISOString().slice(0, 10)}.md`;
  const selection = {
    ...(args.profiles.length > 0 ? { profiles: args.profiles } : {}),
    latest: args.latest ?? 5,
  };

  // Imported only now: the database pool reads DATABASE_URL at import.
  const run = await import("../lib/diagnosis/recalibrate-run");
  const cmp = await import("../lib/diagnosis/recalibrate");
  const { OPUS_4_8, OPUS_5_5, SONNET_5, SONNET_5_5 } = await import("../lib/llm/models");
  console.log(
    `recalibrate:${mode} — reading from ${redact(process.env.DATABASE_URL ?? "(unset)")}`,
  );

  if (args.sonnet) {
    const models = [SONNET_5, SONNET_5_5] as const;
    const targets = await run.intakeTargets(selection);
    if (targets.length === 0) {
      console.error("nothing to compare — no profiles among the ones chosen.");
      return 2;
    }
    const est = await run.estimateSonnetEur(targets.length, models);
    console.log(`${targets.length} intake state(s): ${targets.map((t) => t.label).join(", ")}`);
    console.log(
      `estimated ceiling: €${est.total.toFixed(3)} — each pick writes the ~${est.bank_tokens}-token bank to cache, ` +
        "with its one retry, on both models (real runs read the cache after the first call)",
    );
    if (!args.yes) {
      console.error("\nnot spending anything without --yes.");
      return 2;
    }
    const rows = await run.runPickComparison({
      targets,
      models,
      accountId: RECALIBRATE_ACCOUNT_ID,
    });
    const report = { models: { a: SONNET_5, b: SONNET_5_5 }, rows };
    console.log(`\n${cmp.renderPicksText(report)}`);
    write(
      outPath,
      `# Interviewer recalibration\n\nGenerated ${new Date().toISOString()}.\n\n${cmp.renderSonnetMarkdown(report)}\n`,
    );
    return 0;
  }

  const models = [OPUS_4_8, OPUS_5_5] as const;
  const targets = await run.diagnosisTargets(selection);
  const { prepared, skipped } = await run.prepareDiagnosis(targets);
  for (const s of skipped) console.log(`skipping ${s.target.label}: ${s.reason}`);
  if (prepared.length === 0) {
    console.error("nothing to diagnose — no stored snapshot among the profiles chosen.");
    return 2;
  }
  const est = run.estimateDiagnosisEur(prepared, models);
  console.log(`${prepared.length} business(es): ${prepared.map((p) => p.target.label).join(", ")}`);
  console.log(
    `snapshot prompts total ~${est.input_tokens} input tokens per model (estimated at 3 characters a token, on purpose high)`,
  );
  for (const m of models) {
    console.log(`  ${m}: ≤ €${(est.per_model[m] ?? 0).toFixed(3)} (prompt + its whole output cap)`);
  }
  console.log(
    `estimated ceiling: €${est.total.toFixed(3)} — real runs use far less than the output caps`,
  );
  if (!args.yes) {
    console.error("\nnot spending anything without --yes.");
    return 2;
  }

  const rows = await run.runDiagnosisComparison({
    prepared,
    models,
    accountId: RECALIBRATE_ACCOUNT_ID,
    render: (c) => `\n${cmp.renderBusinessText(c)}`,
  });
  console.log(`\n${cmp.renderTotalsText(cmp.totals(rows), { a: OPUS_4_8, b: OPUS_5_5 })}`);
  write(
    outPath,
    cmp.renderMarkdown({
      generated_at: new Date().toISOString(),
      models: { a: OPUS_4_8, b: OPUS_5_5 },
      rows,
    }),
  );
  return 0;
}

function write(path: string, markdown: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, "utf8");
  console.log(`\nreport written to ${path}`);
  console.log(
    `llm_calls rows are under account ${RECALIBRATE_ACCOUNT_ID}. Moving SONNET_MODEL or DIAGNOSIS_MODEL is the owner's call on this report.`,
  );
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
