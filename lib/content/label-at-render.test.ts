// Architecture-v2 hard rule 7: every generated asset is labelled at render
// time, never at upload. Held by the source: the stamping functions are
// called from the two render paths and nowhere else — not from the owner's
// footage upload (their own footage isn't generated) and not from any route.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const STAMP_CALL = /\bstamp(?:Video|Jpeg)\s*\(/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      out.push(...sources(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("hard rule 7 — generated assets are labelled when rendered, never on upload", () => {
  const callers = [...sources(path.join(ROOT, "lib")), ...sources(path.join(ROOT, "app"))]
    .filter((f) => !f.endsWith(path.join("generate", "label.ts")))
    .filter((f) => STAMP_CALL.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
    .sort();

  it("stamps a label only in the two render paths", () => {
    expect(callers).toEqual(["lib/content/candidates.ts", "lib/content/generation.ts"]);
  });

  it("the upload paths stamp nothing", () => {
    for (const upload of ["lib/content/footage.ts", "app/api/content/media/route.ts"]) {
      expect(STAMP_CALL.test(readFileSync(path.join(ROOT, upload), "utf8")), upload).toBe(false);
    }
  });
});
