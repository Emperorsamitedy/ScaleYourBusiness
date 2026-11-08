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
  // Idea 45: review notifications arrive on the same webhook, routed by the r- prefix.
  "lib/reviews/inbound.ts",
  "lib/reviews/parse.ts",
  "lib/reviews/fallback.ts",
  "lib/reviews/store.ts",
  "lib/reviews/alert.ts",
  // I-45a: the same Google review by email and from Google files once.
  "lib/reviews/twin.ts",
  // P6-02: anyone can dial the phone line. Rule 31 holds it to rule 21: it
  // answers from approved answers or takes a message, and reaches nothing else.
  "app/api/phone/voice/route.ts",
  "lib/phone/line.ts",
  "lib/phone/settings.ts",
  "lib/phone/twilio.ts",
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
  // Idea 45: the owner's review replies, removals and screen. A stranger must never reach them.
  "lib/review-desk/",
  // I-45a: the Google Business Profile access and its reader hold a write-capable grant.
  "lib/google-business/",
  // P6-02: the owner's side of the phone line (turning it on, erasing calls),
  // and everything a caller might ask the line to DO — book, pay, move money.
  // Rule 31: the line never books, promises, refunds or executes anything.
  "lib/phone-desk/",
  "lib/bookings/",
  "lib/payments/",
  "lib/cash/",
  // P6-08: the recordings' storage, sealing and deletes. The line asks Twilio
  // to record (after the notice); only the trusted side touches the audio.
  "lib/phone-recording/",
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
  // L-6 (TASKS-LANGUAGES.md): the owner's notice is written in the owner's
  // language — next-intl's translator over the catalogues, nothing else.
  "next-intl",
];

/**
 * L-6: the words for the owner's notice (lib/support/notify-owner), and only
 * the words — the recipient translator (pure: no cookie, no session, no
 * database), the language table, the review list it checks, and the English
 * catalogue it bundles. Added deliberately; held below to import nothing more.
 */
const LANGUAGE_FILES = [
  "lib/i18n/recipient.ts",
  "lib/i18n/locales.ts",
  "lib/i18n/review.ts",
  "messages/en.json",
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
        // P6-02: the phone line, its webhook and its Twilio helpers.
        file.startsWith("lib/phone/") ||
        file.startsWith("app/api/phone/voice/") ||
        file.startsWith("db/") ||
        file.startsWith("lib/llm/") ||
        // Idea 45: filing forwarded reviews (and its data file of notification formats).
        file.startsWith("lib/reviews/") ||
        file === "specs/review-notifications-v1.json" ||
        file === "lib/env.ts" ||
        // Added deliberately by the 2026-10-17 security review: a pure
        // function with no imports, reached through the model metering's
        // logs, that strips a query's bound values (PII) from error lines.
        file === "lib/core/log-safe.ts" ||
        // Added deliberately by L-5 and L-6 (rule 5 of TASKS-LANGUAGES.md):
        // the widget answers in the business's own language, so the tier
        // reads the language files — pure data and next-intl, held below to
        // reading no cookie, session or database.
        LANGUAGE_FILES.includes(file),
    );
    expect(allowed, [...graph.files].sort().join("\n")).toBe(true);
  });

  it("L-6: the language files the tier reaches import only each other, the catalogue and next-intl", () => {
    for (const f of LANGUAGE_FILES.filter((x) => x.endsWith(".ts"))) {
      for (const spec of importsOf(readFileSync(path.resolve(ROOT, f), "utf8"))) {
        const target = resolveSpec(path.resolve(ROOT, f), spec, new Map());
        if (target === null) expect(spec, f).toBe("next-intl");
        else expect(LANGUAGE_FILES, `${f} → ${spec}`).toContain(relOf(target));
      }
    }
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

  it("I-45d: review phone alerts are sent from the trusted side — the inbound path reaches nothing in lib/push", () => {
    expect([...graph.files].filter((f) => f.startsWith("lib/push/"))).toEqual([]);
    // The gate would see it: lib/reviews reaching the flush pulls in lib/profile.
    const planted = new Map([
      ["lib/reviews/__planted_push__.ts", 'export { flushPushes } from "../push/flush";\n'],
    ]);
    const reached = walk(["lib/reviews/__planted_push__.ts"], planted);
    expect([...reached.files]).toContain("lib/push/flush.ts");
    expect(offenders(reached.files)).toContain("lib/profile/field-store.ts");
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

  it("P6-02: the phone webhook sets no cookie, reads none, and verifies before it handles a step", () => {
    const source = readFileSync(path.resolve(ROOT, "app/api/phone/voice/route.ts"), "utf8");
    expect(source).not.toMatch(/cookies\(/);
    expect(source).not.toMatch(/set-cookie/i);
    expect(source.indexOf("verifyTwilioSignature(")).toBeGreaterThan(0);
    expect(source.indexOf("verifyTwilioSignature(")).toBeLessThan(source.indexOf("handleVoice("));
  });

  it("P6-08: the recording callback sets no cookie, reads none, and verifies before it acts", () => {
    const source = readFileSync(path.resolve(ROOT, "app/api/phone/recording/route.ts"), "utf8");
    expect(source).not.toMatch(/cookies\(/);
    expect(source).not.toMatch(/set-cookie/i);
    expect(source.indexOf("verifyTwilioSignature(")).toBeGreaterThan(0);
    expect(source.indexOf("verifyTwilioSignature(")).toBeLessThan(
      source.indexOf("recordingCallback(params"),
    );
    // And the line itself never reaches the audio: a planted import is caught.
    const planted = new Map([
      ["lib/phone/__planted_recording__.ts", 'export * from "../phone-recording/recordings";\n'],
    ]);
    expect(offenders(walk(["lib/phone/__planted_recording__.ts"], planted).files)).toContain(
      "lib/phone-recording/recordings.ts",
    );
  });

  it("P6-02: the gate bites on the phone line — a planted booking, payment or desk import is caught", () => {
    const planted = new Map([
      ["lib/phone/__planted_booking__.ts", 'export * from "../bookings/erase";\n'],
      ["lib/phone/__planted_desk__.ts", 'export { eraseCall } from "@/lib/phone-desk/desk";\n'],
    ]);
    expect(offenders(walk(["lib/phone/__planted_booking__.ts"], planted).files)).toContain(
      "lib/bookings/erase.ts",
    );
    expect(offenders(walk(["lib/phone/__planted_desk__.ts"], planted).files)).toContain(
      "lib/phone-desk/desk.ts",
    );
    // The passing case: the real line reaches none of it.
    expect(offenders(walk(["lib/phone/line.ts"]).files)).toEqual([]);
  });
});
