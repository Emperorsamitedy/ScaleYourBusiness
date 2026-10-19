// P4-08 — rule 21 as a build gate: the support tier imports no execution,
// proposal-write, profile-write or connector path. Asserted against the
// MODULE GRAPH, transitively, from every stranger-facing entry point —
// not against a list someone promises to keep. The no-off-switch
// pattern: a forbidden import anywhere down the chain fails the build.

import { existsSync, readFileSync } from "node:fs";
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

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']\s*\)?/g;

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // packages are not our modules
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && !candidate.endsWith(path.sep)) {
      try {
        if (readFileSync(candidate, "utf8") !== null) return candidate;
      } catch {
        /* a directory — try the next */
      }
    }
  }
  return null;
}

/** Every file reachable from the entry points, as repo-relative posix paths. */
function reachable(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entries.map((e) => path.resolve(ROOT, e));
  while (queue.length > 0) {
    const file = queue.pop()!;
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const target = resolveRelative(file, match[1]!);
      if (target) queue.push(target);
    }
  }
  return seen;
}

describe("P4-08 — rule 21, held by the module graph", () => {
  const graph = reachable(ENTRY_POINTS);

  it("the walk is real: it reaches the database layer and the schema", () => {
    expect(graph.has("db/index.ts")).toBe(true);
    expect(graph.has("db/schema.ts")).toBe(true);
    expect(graph.size).toBeGreaterThan(ENTRY_POINTS.length);
  });

  it("THE BUILD GATE: nothing reachable from the support tier is an execution, proposal, profile, connector or other trusted-side module", () => {
    const offenders = [...graph].filter((file) =>
      FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix)),
    );
    expect(offenders).toEqual([]);
  });

  it("what the support tier may touch is exactly: itself, the database, the model client and its metering", () => {
    const allowed = [...graph].every(
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
    expect(allowed, [...graph].sort().join("\n")).toBe(true);
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
