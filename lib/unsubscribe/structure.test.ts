// P4-15 — the unsubscribe surface's import fence, in the style of
// lib/support/structure.test.ts. A stranger holding a token reaches these
// entry points; from them, walked transitively through the module graph,
// the ONLY repo modules reachable are the unsubscribe module itself, its
// two routes, and the database layer — and the only packages are hashing,
// the query builder and Next itself. The one write it makes is a
// contact_suppressions row (plus the send's own mark and the log line),
// and a source scan holds it to that. No off switch: a new import fails
// the build.
//
// L-6 (TASKS-LANGUAGES.md): the page speaks the business's language, so the
// fence also allows the words and nothing else — lib/i18n/recipient (pure:
// no cookie, no session, no database), the language table and the review
// list it checks, the English catalogue it bundles (data, not scanned for
// imports), and next-intl's translator.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const ENTRY_POINTS = [
  "lib/unsubscribe/unsubscribe.ts",
  "app/u/[token]/page.tsx",
  "app/api/u/[token]/route.ts",
];

/** L-6: the words, and only the words. */
const LANGUAGE_FILES = [
  "lib/i18n/recipient.ts",
  "lib/i18n/locales.ts",
  "lib/i18n/review.ts",
  "messages/en.json",
];

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']\s*\)?/g;

function resolve(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith("@/")) base = path.resolve(ROOT, spec.slice(2));
  else return null; // a package
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function walk(entries: readonly string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = entries.map((e) => path.resolve(ROOT, e));
  while (queue.length > 0) {
    const file = queue.pop()!;
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (files.has(rel)) continue;
    files.add(rel);
    if (!/\.tsx?$/.test(rel)) continue; // a catalogue is data: nothing to follow
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
      const spec = match[1]!;
      const target = resolve(file, spec);
      if (target) queue.push(target);
      else if (!spec.startsWith(".") && !spec.startsWith("@/")) {
        // Only the unsubscribe surface's own packages are fenced; db/ brings pg and dotenv-free env.
        if (!rel.startsWith("db/") && rel !== "lib/env.ts") packages.add(spec);
      }
    }
  }
  return { files, packages };
}

describe("P4-15 — the unsubscribe surface's import fence", () => {
  const graph = walk(ENTRY_POINTS);

  it("the walk is real: it reaches the database layer", () => {
    expect(graph.files.has("db/index.ts")).toBe(true);
    expect(graph.files.has("db/schema.ts")).toBe(true);
  });

  it("THE BUILD GATE: what it may touch is exactly itself, its routes and the database", () => {
    const outside = [...graph.files].filter(
      (f) =>
        !f.startsWith("lib/unsubscribe/") &&
        !f.startsWith("app/u/") &&
        !f.startsWith("app/api/u/") &&
        f !== "db/index.ts" &&
        f !== "db/schema.ts" &&
        f !== "lib/env.ts" &&
        !LANGUAGE_FILES.includes(f),
    );
    expect(outside).toEqual([]);
  });

  it("L-6: the words come from the recipient translator, which reads no cookie and no session", () => {
    expect(graph.files.has("lib/i18n/recipient.ts")).toBe(true);
    for (const f of LANGUAGE_FILES.filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(path.resolve(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/cookies\(|currentSession|resolveAccess|from "\.\.\/\.\.\/db"/);
    }
  });

  it("the only packages: hashing, the query builder, Next, and next-intl's translator", () => {
    const allowed = ["drizzle-orm", "next", "next/server", "node:crypto", "next-intl"];
    expect([...graph.packages].filter((p) => !allowed.includes(p))).toEqual([]);
    expect(graph.packages.has("node:crypto")).toBe(true);
  });

  it("it reads no cookie and sets none, and holds no session", () => {
    for (const f of ENTRY_POINTS) {
      const src = readFileSync(path.resolve(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/cookies\(|set-cookie|currentSession|resolveAccess/i);
    }
  });

  it('its one write that matters is the suppression, with reason "unsubscribed"', () => {
    const src = readFileSync(path.resolve(ROOT, "lib/unsubscribe/unsubscribe.ts"), "utf8");
    const writes = (verb: string) =>
      [...src.matchAll(new RegExp(`\\b(?:tx|db)\\s*\\.${verb}\\((\\w+)\\)`, "g"))]
        .map((m) => m[1])
        .sort();
    expect(writes("insert")).toEqual(["contactSuppressions", "decisionLog"]);
    expect(writes("update")).toEqual(["campaignSends"]);
    expect(writes("delete")).toEqual([]);
    expect(src).not.toMatch(/\.execute\(/);
    expect(src).toMatch(/reason: "unsubscribed"/);
  });

  it("GET never unsubscribes: the page and the route's GET only read", () => {
    const page = readFileSync(path.resolve(ROOT, "app/u/[token]/page.tsx"), "utf8");
    expect(page).toContain("viewUnsubscribe(");
    expect(page).not.toMatch(/\bunsubscribe\(/);
    const route = readFileSync(path.resolve(ROOT, "app/api/u/[token]/route.ts"), "utf8");
    const get = route.slice(
      route.indexOf("export async function GET("),
      route.indexOf("export async function POST("),
    );
    expect(get).not.toMatch(/unsubscribe\(/);
  });
});
