// Idea 44's fence: a benchmark is a published reference, never a fact
// about the business, and the app never reaches Eurostat. This reads every
// source file of the comparison (lib/benchmarks, its API route, its page
// and its screen) and fails the build if any of them:
//
//   · reaches the network (a fetch other than the screen's own read of
//     /api/benchmarks and its one button, POST /api/proposals/margin-review,
//     an http module, a URL other than Eurostat's own address in the
//     attribution);
//   · writes to the database or writes a Field (writeField, createField);
//   · imports a model client (lib/llm, the Anthropic SDK);
//   · exports an HTTP verb other than GET.
//
// I-44a (decided 2026-11-03, owner: "both"): a LARGE gap may reach the
// report as a finding and prompt a proposal, through one door only —
// lib/benchmarks/gap (the stated threshold, pure) and lib/benchmarks/gap-read
// (its reads). So the report and proposals code may import those two files
// and nothing else from lib/benchmarks, and the diagnosis (its cached
// prompt), mode, validation, watch, execution, scorer, interviewer and
// profile code import nothing from it at all. Each check has a planted
// failing case below, so the scanner can't pass by being blind.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["lib/benchmarks", "app/api/benchmarks", "app/benchmarks", "components/benchmarks"];
/** Where a benchmark must never be read. */
const FORBIDDEN_READERS = [
  "lib/diagnosis",
  "lib/mode",
  "lib/validation",
  "lib/watch",
  "lib/execution",
  "lib/scorer",
  "lib/interviewer",
  "lib/profile",
];
/** I-44a: where only the large-gap door may be read. */
const GAP_READERS = ["lib/proposals", "lib/report"];

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
  /\bfetch\s*\((?!\s*[`"']\/api\/(?:benchmarks|proposals\/margin-review)\b)|from\s+["'](?:node:)?(?:https?|net|tls|dgram)["']|https?:\/\/(?!doi\.org\/10\.2908\/)/g;
const DB_WRITE =
  /\.(?:insert|update|delete)\s*\(|\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/g;
const FIELD_WRITE = /\b(?:writeField|createField|writeFields)\b/g;
const MODEL = /from\s+["'](?:@anthropic-ai\/sdk|[^"']*\/llm(?:\/[^"']*)?)["']/g;
const VERBS = /export\s+(?:async\s+)?(?:function|const)\s+(POST|PUT|PATCH|DELETE)\b/g;
const READS_BENCHMARKS = /from\s+["'][^"']*benchmarks(?:\/[^"']*)?["']/g;
/** I-44a: the one door — lib/benchmarks/gap and lib/benchmarks/gap-read. */
const GAP_DOOR = /benchmarks\/gap(?:-read)?["']$/;

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

/** Pure: an import of lib/benchmarks other than the large-gap door (I-44a). */
function auditGapReader(file: string, text: string): Violation[] {
  return auditReader(file, text).filter((v) => !GAP_DOOR.test(v.match));
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

  it("the report and proposals read a benchmark only through the large-gap door (I-44a)", () => {
    const files = GAP_READERS.flatMap(walk);
    const found = files.flatMap((f) => auditGapReader(f, readFileSync(f, "utf8")));
    expect(found).toEqual([]);
    // The door is used: the report's findings and the margin review.
    const doors = files.filter((f) => auditReader(f, readFileSync(f, "utf8")).length > 0);
    expect(doors.map((f) => f.replace(/\\/g, "/")).sort()).toEqual([
      "lib/proposals/margin-review.ts",
      "lib/report/service.ts",
    ]);
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
    expect(
      auditGapReader("lib/report/x.ts", 'import { compare } from "../benchmarks/compare";'),
    ).toHaveLength(1);
    expect(
      auditReader("lib/diagnosis/x.ts", 'import { largeGap } from "../benchmarks/gap";'),
    ).toHaveLength(1);
    expect(auditSource("x.ts", 'await fetch("/api/proposals/other")').map((x) => x.rule)).toEqual([
      "network",
    ]);
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
    expect(
      auditGapReader(
        "lib/report/x.ts",
        'import { reportGapFinding } from "../benchmarks/gap-read";',
      ),
    ).toEqual([]);
    expect(
      auditGapReader("lib/proposals/x.ts", 'import { gapBasis } from "../benchmarks/gap";'),
    ).toEqual([]);
    expect(
      auditSource("ok.ts", 'await fetch("/api/proposals/margin-review", { method: "POST" });'),
    ).toEqual([]);
  });
});
