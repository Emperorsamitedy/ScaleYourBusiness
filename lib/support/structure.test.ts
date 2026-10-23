// P4-08 — rule 21 as a build gate: the support tier imports no execution,
// proposal-write, profile-write or connector path. Asserted against the
// MODULE GRAPH, transitively, from every stranger-facing entry point —
// not against a list someone promises to keep. The no-off-switch
// pattern: a forbidden import anywhere down the chain fails the build.
//
// Review 2026-10-23 (#7): the walk once followed relative imports only, so
// `import … from "@/lib/crm/contacts"` passed the gate unseen. It now
// resolves aliases through tsconfig's own `paths` (read from tsconfig.json,
// not assumed), and every bare package the tier reaches must be on an
// allow-list. A planted violation below proves the gate bites.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** Every entry point a stranger can reach, directly or through the public route. */
const ENTRY_POINTS = [
  "lib/support/chat.ts",
  "lib/support/knowledge.ts",
  "lib/support/settings.ts",
  "lib/support/tickets.ts",
  "app/api/support/public/route.ts",
  // P4-09: the inbound-email webhook — anyone can email a business.
  "app/api/support/inbound/route.ts",
  "lib/support/inbound.ts",
  "lib/support/email-tickets.ts",
  "lib/support/support-contact.ts",
  // P4-11: the chat handover's optional address, the reply-time arithmetic, the owner notice.
  "lib/support/handover.ts",
  "lib/support/sla.ts",
  "lib/support/notify-owner.ts",
];

/** Anything under these may never be reached from the support tier. */
const FORBIDDEN_PREFIXES = [
  "lib/execution/",
  "lib/proposals/",
  "lib/profile/",
  "lib/connectors/",
  "lib/content/",
  "lib/site/",
  "lib/crm/",
  "lib/chat/",
  "lib/intake/",
  "lib/interviewer/",
  "lib/diagnosis/",
  "lib/report/",
  "lib/mode/",
  "lib/anomaly/",
  "lib/trust/",
  "lib/economics/",
  "lib/auth/",
  "lib/bank/",
  "lib/validation/",
  "lib/watch/",
  // P4-10: the owner's drafting and sending. A stranger must never reach it.
  "lib/support-desk/",
];

/**
 * The only packages the support tier may import: hashing, the query
 * builder and its driver, Next's request types, the model SDK (the
 * widget's answers), and the env loader the database layer uses.
 */
const ALLOWED_PACKAGES = [
  "@anthropic-ai/sdk",
  "dotenv/config",
  "drizzle-orm",
  "drizzle-orm/node-postgres",
  "drizzle-orm/pg-core",
  "next/server",
  "node:crypto",
  "pg",
];

// Statements only, anchored at a line start, so the word "from" in a
// comment or a string is not read as an import: `import … from "x"`,
// `import "x"`, `export … from "x"` (bindings may span lines), and `import("x")`.
const STATIC_IMPORT_RE =
  /^\s*(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(source: string): string[] {
  return [...source.matchAll(STATIC_IMPORT_RE), ...source.matchAll(DYNAMIC_IMPORT_RE)].map(
    (m) => m[1]!,
  );
}

/** tsconfig's `paths`, as [prefix, target dirs] — "@/*": ["./*"] becomes ["@/", ["./"]]. */
function tsconfigPaths(): [string, string[]][] {
  const raw = readFileSync(path.resolve(ROOT, "tsconfig.json"), "utf8");
  const config = JSON.parse(raw) as { compilerOptions?: { paths?: Record<string, string[]> } };
  return Object.entries(config.compilerOptions?.paths ?? {}).map(([alias, targets]) => [
    alias.replace(/\*$/, ""),
    targets.map((t) => t.replace(/\*$/, "")),
  ]);
}

const PATHS = tsconfigPaths();

/** Files that exist only for a test: repo-relative posix path → source. */
type Planted = ReadonlyMap<string, string>;

function relOf(abs: string): string {
  return path.relative(ROOT, abs).split(path.sep).join("/");
}

function isFile(abs: string, planted: Planted): boolean {
  if (planted.has(relOf(abs))) return true;
  return existsSync(abs) && statSync(abs).isFile();
}

/** A module specifier → the repo file it names; null for a package. An alias or relative path that names nothing throws. */
function resolveSpec(fromFile: string, spec: string, planted: Planted): string | null {
  const bases: string[] = [];
  if (spec.startsWith(".")) bases.push(path.resolve(path.dirname(fromFile), spec));
  else {
    const alias = PATHS.find(([prefix]) => spec.startsWith(prefix));
    if (!alias) return null; // a package — checked against the allow-list
    for (const target of alias[1]) {
      bases.push(path.resolve(ROOT, target, spec.slice(alias[0].length)));
    }
  }
  for (const base of bases) {
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      if (isFile(candidate, planted)) return candidate;
    }
  }
  // An import of ours that resolves to nothing is a hole in the walk, not a package.
  throw new Error(`unresolved import "${spec}" in ${relOf(fromFile)}`);
}

/** Every file reachable from the entry points (repo-relative posix paths), and every package named. */
function walk(
  entries: readonly string[],
  planted: Planted = new Map(),
): { files: Set<string>; packages: Map<string, string> } {
  const files = new Set<string>();
  const packages = new Map<string, string>(); // package → the first file importing it
  const queue = entries.map((e) => path.resolve(ROOT, e));
  while (queue.length > 0) {
    const file = queue.pop()!;
    const rel = relOf(file);
    if (files.has(rel)) continue;
    files.add(rel);
    const source = planted.get(rel) ?? readFileSync(file, "utf8");
    for (const spec of importsOf(source)) {
      const target = resolveSpec(file, spec, planted);
      if (target) queue.push(target);
      else if (!packages.has(spec)) packages.set(spec, rel);
    }
  }
  return { files, packages };
}

function offenders(files: Iterable<string>): string[] {
  return [...files].filter((file) => FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

function strayPackages(packages: Map<string, string>): string[] {
  return [...packages]
    .filter(([pkg]) => !ALLOWED_PACKAGES.includes(pkg))
    .map(([pkg, by]) => `${pkg} (from ${by})`);
}

describe("P4-08 — rule 21, held by the module graph", () => {
  const graph = walk(ENTRY_POINTS);

  it("the walk is real: it reaches the database layer and the schema", () => {
    expect(graph.files.has("db/index.ts")).toBe(true);
    expect(graph.files.has("db/schema.ts")).toBe(true);
    expect(graph.files.size).toBeGreaterThan(ENTRY_POINTS.length);
  });

  it("the walk follows tsconfig's alias: db/index.ts reaches lib/env.ts only through '@/lib/env'", () => {
    expect(PATHS).toContainEqual(["@/", ["./"]]);
    expect(readFileSync(path.resolve(ROOT, "db/index.ts"), "utf8")).toMatch(/from "@\/lib\/env"/);
    expect(graph.files.has("lib/env.ts")).toBe(true);
  });

  it("THE BUILD GATE: nothing reachable from the support tier is an execution, proposal, profile, connector or other trusted-side module", () => {
    expect(offenders(graph.files)).toEqual([]);
  });

  it("THE BUILD GATE: every package the support tier reaches is on the allow-list", () => {
    expect(strayPackages(graph.packages)).toEqual([]);
  });

  it("what the support tier may touch is exactly: itself, the database, the model client and its metering", () => {
    const allowed = [...graph.files].every(
      (file) =>
        file.startsWith("lib/support/") ||
        file.startsWith("app/api/support/public/") ||
        file.startsWith("app/api/support/inbound/") ||
        file.startsWith("db/") ||
        file.startsWith("lib/llm/") ||
        file === "lib/env.ts" ||
        // Added deliberately by the 2026-10-17 security review: a pure
        // function with no imports, reached through the model metering's
        // logs, that strips a query's bound values (PII) from error lines.
        file === "lib/core/log-safe.ts",
    );
    expect(allowed, [...graph.files].sort().join("\n")).toBe(true);
  });

  it("the gate bites: a planted '@/' import of lib/crm, a relative one of lib/support-desk, and a stray package are each caught", () => {
    const planted = new Map([
      [
        "lib/support/__planted_alias__.ts",
        'import { addContact } from "@/lib/crm/contacts";\nexport const x = addContact;\n',
      ],
      [
        "lib/support/__planted_relative__.ts",
        'export { approveReply } from "../support-desk/replies";\n',
      ],
      [
        "lib/support/__planted_package__.ts",
        'import Stripe from "stripe";\nexport const s = Stripe;\n',
      ],
      ["lib/support/__planted_clean__.ts", 'import { db } from "@/db";\nexport const d = db;\n'],
    ]);
    const alias = walk(["lib/support/__planted_alias__.ts"], planted);
    expect(offenders(alias.files)).toContain("lib/crm/contacts.ts");
    const relative = walk(["lib/support/__planted_relative__.ts"], planted);
    expect(offenders(relative.files)).toContain("lib/support-desk/replies.ts");
    const pkg = walk(["lib/support/__planted_package__.ts"], planted);
    expect(strayPackages(pkg.packages)).toEqual([
      "stripe (from lib/support/__planted_package__.ts)",
    ]);
    // The passing case: an allowed "@/" import resolves and offends nothing.
    const clean = walk(["lib/support/__planted_clean__.ts"], planted);
    expect(clean.files.has("db/index.ts")).toBe(true);
    expect(offenders(clean.files)).toEqual([]);
    expect(strayPackages(clean.packages)).toEqual([]);
    // An "@/" path that names nothing is a hole in the walk, and fails loudly.
    const hole = new Map([["lib/support/__planted_hole__.ts", 'import "@/lib/no/such/module";\n']]);
    expect(() => walk(["lib/support/__planted_hole__.ts"], hole)).toThrow(/unresolved import/);
  });

  it("the public route sets no cookie and reads none", () => {
    const source = readFileSync(path.resolve(ROOT, "app/api/support/public/route.ts"), "utf8");
    expect(source).not.toMatch(/cookies\(/);
    expect(source).not.toMatch(/set-cookie/i);
    expect(source).toMatch(/Access-Control-Allow-Origin/);
  });

  it("P4-09: the inbound webhook sets no cookie, reads none, and verifies before it reads", () => {
    const source = readFileSync(path.resolve(ROOT, "app/api/support/inbound/route.ts"), "utf8");
    expect(source).not.toMatch(/cookies\(/);
    expect(source).not.toMatch(/set-cookie/i);
    expect(source.indexOf("verifyWebhook(")).toBeGreaterThan(0);
    expect(source.indexOf("verifyWebhook(")).toBeLessThan(source.indexOf("JSON.parse("));
  });
});
