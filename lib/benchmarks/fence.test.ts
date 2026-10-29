// Idea 44's fence: a benchmark is a published reference, never a fact
// about the business, and the app never reaches Eurostat. This reads every
// source file of the comparison (lib/benchmarks, its API route, its page
// and its screen) and fails the build if any of them:
//
//   · reaches the network (a fetch other than the screen's own read of
//     /api/benchmarks, an http module, a URL other than Eurostat's own
//     address in the attribution);
//   · writes to the database or writes a Field (writeField, createField);
//   · imports a model client (lib/llm, the Anthropic SDK);
//   · exports an HTTP verb other than GET.
//
// And it fails if the diagnosis, proposals, report, mode, validation or
// watch code imports lib/benchmarks: nothing from it reaches the diagnosis
// or a proposal until I-44a decides otherwise. Each check has a planted
// failing case below, so the scanner can't pass by being blind.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["lib/benchmarks", "app/api/benchmarks", "app/benchmarks", "components/benchmarks"];
/** Where a benchmark must never be read. */
const FORBIDDEN_READERS = [
  "lib/diagnosis",
  "lib/proposals",
  "lib/report",
  "lib/mode",
  "lib/validation",
  "lib/watch",
  "lib/execution",
  "lib/scorer",
  "lib/interviewer",
  "lib/profile",
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

interface Violation {
  file: string;
  rule: "network" | "db_write" | "field_write" | "model" | "verb" | "reader";
  match: string;
}

const NETWORK =
  /\bfetch\s*\((?!\s*[`"']\/api\/benchmarks\b)|from\s+["'](?:node:)?(?:https?|net|tls|dgram)["']|https?:\/\/(?!doi\.org\/10\.2908\/)/g;
const DB_WRITE =
  /\.(?:insert|update|delete)\s*\(|\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/g;
const FIELD_WRITE = /\b(?:writeField|createField|writeFields)\b/g;
const MODEL = /from\s+["'](?:@anthropic-ai\/sdk|[^"']*\/llm(?:\/[^"']*)?)["']/g;
const VERBS = /export\s+(?:async\s+)?(?:function|const)\s+(POST|PUT|PATCH|DELETE)\b/g;
const READS_BENCHMARKS = /from\s+["'][^"']*benchmarks(?:\/[^"']*)?["']/g;

/** Pure: every fence violation in one of the comparison's own source texts. */
function auditSource(file: string, text: string): Violation[] {
  const v: Violation[] = [];
  const all = (re: RegExp, rule: Violation["rule"], group = 0) => {
    for (const m of text.matchAll(re)) v.push({ file, rule, match: m[group] ?? m[0] });
  };
  all(NETWORK, "network");
  all(DB_WRITE, "db_write");
  all(FIELD_WRITE, "field_write");
  all(MODEL, "model");
  all(VERBS, "verb", 1);
  return v;
}

/** Pure: an import of lib/benchmarks from code that feeds the diagnosis or a proposal. */
function auditReader(file: string, text: string): Violation[] {
  return [...text.matchAll(READS_BENCHMARKS)].map((m) => ({ file, rule: "reader", match: m[0] }));
}

describe("the benchmark fence", () => {
  it("covers real files", () => {
    expect(ROOTS.flatMap(walk).length).toBeGreaterThan(1);
  });

  it("no comparison source reaches the network, writes, or calls a model", () => {
    const found = ROOTS.flatMap(walk).flatMap((f) => auditSource(f, readFileSync(f, "utf8")));
    expect(found).toEqual([]);
  });

  it("nothing that feeds the diagnosis or a proposal reads a benchmark", () => {
    const found = FORBIDDEN_READERS.flatMap(walk).flatMap((f) =>
      auditReader(f, readFileSync(f, "utf8")),
    );
    expect(found).toEqual([]);
  });

  it("catches each planted violation", () => {
    const planted = [
      'await fetch("https://ec.europa.eu/eurostat/api")',
      'import https from "node:https";',
      "await db.insert(fieldRecords).values(row);",
      "await writeField(profileId, f);",
      'import { callModel } from "../llm/client";',
      'import Anthropic from "@anthropic-ai/sdk";',
      "export async function POST() {}",
    ].join("\n");
    const rules = auditSource("planted.ts", planted).map((x) => x.rule);
    expect(rules).toEqual(
      expect.arrayContaining(["network", "db_write", "field_write", "model", "verb"]),
    );
    expect(
      auditReader("lib/diagnosis/x.ts", 'import { compare } from "../benchmarks/compare";'),
    ).toHaveLength(1);
  });

  it("passes what the screen may do", () => {
    const allowed = [
      'const res = await fetch("/api/benchmarks");',
      'const doi = "https://doi.org/10.2908/SBS_SC_OVW";',
      "export async function GET() {}",
      'import { readCurrentField } from "../profile/field-store";',
    ].join("\n");
    expect(auditSource("ok.ts", allowed)).toEqual([]);
    expect(auditReader("lib/diagnosis/x.ts", 'import { x } from "../report/y";')).toEqual([]);
  });
});
