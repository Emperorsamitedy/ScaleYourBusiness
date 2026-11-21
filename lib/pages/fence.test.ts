// Guided page set-up: its three rules, held by reading the source
// (specs/page-setup-v1.md).
//
//   1. The owner creates; ScaleX prepares. Nothing in the guide's code asks a
//      platform for anything: no request leaves for Facebook or Instagram,
//      and the route only reads.
//   2. No platform password, ever. The guide has no field to type into at
//      all, let alone one for a password.
//   3. Free on every plan. Nothing in the guide reads what the owner pays.
//
// Each check has a planted failing case, so the scanner can't pass by being
// blind.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Every file the guide is made of. */
const SOURCES = [
  ...readdirSync(join(ROOT, "lib/pages"))
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => `lib/pages/${f}`),
  "app/api/page-setup/route.ts",
  "components/connections/PageSetupSection.tsx",
];

/** Comments say what the code must not do; only the code is held to it. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

export interface Breach {
  rule: "asks_a_platform" | "takes_typing" | "reads_the_plan" | "writes";
  match: string;
}

const PLATFORM_CALL =
  /graph\.facebook\.com|graph\.instagram\.com|META_GRAPH_ORIGIN|metaExecution|createMetaExecution|\/me\/accounts/;
const TYPING = /<input\b|<textarea\b|type=["']password["']|contentEditable/;
const PLAN = /lib\/billing|\/billing\/|planOf\(|subscription|paymentsConfigured|entitle/i;
const WRITES = /\.insert\(|\.update\(|\.delete\(|method:\s*["'](POST|PUT|PATCH|DELETE)["']/;

export function breaches(source: string): Breach[] {
  const text = code(source);
  const out: Breach[] = [];
  const hit = (rule: Breach["rule"], re: RegExp) => {
    const m = re.exec(text);
    if (m) out.push({ rule, match: m[0] });
  };
  hit("asks_a_platform", PLATFORM_CALL);
  hit("takes_typing", TYPING);
  hit("reads_the_plan", PLAN);
  hit("writes", WRITES);
  return out;
}

describe("the guide's own files keep its three rules", () => {
  it("finds the guide's files", () => {
    expect(SOURCES).toEqual(
      expect.arrayContaining([
        "lib/pages/kit.ts",
        "lib/pages/kit-load.ts",
        "app/api/page-setup/route.ts",
        "components/connections/PageSetupSection.tsx",
      ]),
    );
  });

  for (const file of SOURCES) {
    it(`${file} asks no platform, takes no typing, reads no plan, writes nothing`, () => {
      expect(breaches(read(file)), file).toEqual([]);
    });
  }

  it("the route can only be read: it exports GET and nothing that changes anything", () => {
    const route = code(read("app/api/page-setup/route.ts"));
    const verbs = [...route.matchAll(/export\s+(?:async\s+)?function\s+([A-Z]+)\b/g)].map(
      (m) => m[1],
    );
    expect(verbs).toEqual(["GET"]);
  });

  it("the only request the screen makes is for its own data", () => {
    const screen = code(read("components/connections/PageSetupSection.tsx"));
    const calls = [...screen.matchAll(/fetch\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    expect(calls).toEqual(["/api/page-setup"]);
  });

  it("the links out go to the platforms' own sites, in a new tab, with no way back in", () => {
    const screen = code(read("components/connections/PageSetupSection.tsx"));
    const outward = [...screen.matchAll(/<a\b[^>]*>/gs)].map((m) => m[0]);
    expect(outward.length).toBeGreaterThanOrEqual(2);
    for (const tag of outward) {
      expect(tag).toContain('target="_blank"');
      expect(tag).toContain('rel="noopener noreferrer"');
    }
  });
});

describe("the scanner sees what it is looking for", () => {
  it("catches a request to a platform", () => {
    expect(breaches('await fetch("https://graph.facebook.com/v26.0/me/accounts")')).toContainEqual(
      expect.objectContaining({ rule: "asks_a_platform" }),
    );
  });

  it("catches a field to type into, and a password field above all", () => {
    expect(breaches('<input type="password" name="fb" />')).toContainEqual(
      expect.objectContaining({ rule: "takes_typing" }),
    );
    expect(breaches("<textarea />")).toContainEqual(
      expect.objectContaining({ rule: "takes_typing" }),
    );
  });

  it("catches a look at what the owner pays", () => {
    expect(breaches('import { planOf } from "../../lib/billing/plan";')).toContainEqual(
      expect.objectContaining({ rule: "reads_the_plan" }),
    );
  });

  it("catches a write", () => {
    expect(breaches("await db.insert(pages).values({})")).toContainEqual(
      expect.objectContaining({ rule: "writes" }),
    );
    expect(breaches('fetch("/api/x", { method: "POST" })')).toContainEqual(
      expect.objectContaining({ rule: "writes" }),
    );
  });

  it("does not take a comment about a rule for a breach of it", () => {
    expect(breaches('// never a <input type="password"> here\nconst a = 1;')).toEqual([]);
  });
});
