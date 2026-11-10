// The multi-market spec, hard rule 1: "No floating-point value may exist on
// any monetary path. Integer minor units, end to end, including
// intermediate arithmetic."
//
// Asserted on the source: outside the three modules that own exact money
// arithmetic (money.ts, currency-table.ts, fx.ts), no line may divide,
// round, toFixed or parseFloat a minor-unit amount, or multiply it by a
// fraction. Adding, subtracting and multiplying whole numbers stays whole
// and is allowed; anything else goes through perUnit / scaleMinor /
// scaleMinorBy / roundMinorTo / ratioBp / formatMoney. A line that turns an
// amount into something that isn't money — a chart's pixel, a ratio shown
// as words — says so with a trailing "// not money: <why>".

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ratioOf, scaleMoney, money, multiply } from "./money";

const ROOT = path.resolve(__dirname, "../..");
const DIRS = ["lib", "app", "components"];
const OWNERS = new Set(["lib/core/money.ts", "lib/core/currency-table.ts", "lib/core/fx.ts"]);

/** A minor-unit amount on a line: amount_minor, value_minor, *_minor identifiers. */
const MINOR = String.raw`\b[a-z_]*_minor\b`;
/** A factor that is a fraction by name, or a literal with a decimal point. */
const FRACTIONAL = String.raw`(?:\d+\.\d+|\w*(?:share|ratio|pct|percent|rate|fraction|factor|weight|low|high)\w*)`;
const FLOAT_OPS = [
  // Division always leaves the integers.
  new RegExp(String.raw`${MINOR}[^;,\n]{0,40}?\s/\s`),
  new RegExp(String.raw`\s/\s[^;,\n]{0,40}?${MINOR}`),
  // Multiplying by a fraction does too; whole × whole stays whole and is allowed.
  new RegExp(String.raw`${MINOR}\s*\*\s*\(?\s*[\w.!]*${FRACTIONAL}`),
  new RegExp(String.raw`${FRACTIONAL}[\w.!]*\s*\)?\s*\*\s*[\w.!]*${MINOR}`),
  new RegExp(String.raw`Math\.(round|floor|ceil|trunc)\([^)]*${MINOR}`),
  new RegExp(String.raw`${MINOR}[^;\n]{0,40}?\.toFixed\(`),
  new RegExp(String.raw`parseFloat\([^)]*${MINOR}`),
];

function sources(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(abs, name);
    if (statSync(p).isDirectory()) out.push(...sources(path.relative(ROOT, p)));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of DIRS.flatMap(sources)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    if (OWNERS.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // An explicit exemption names why the value isn't money (a pixel, a ratio shown as words).
      if (/\/\/ not money: \S/.test(line)) return;
      const code = line.replace(/\/\/.*$/, "");
      if (/^\s*(\*|\/\*)/.test(code)) return;
      if (FLOAT_OPS.some((re) => re.test(code))) found.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe("hard rule 1 — no float on any monetary path", () => {
  it("no line outside the money modules scales a minor-unit amount by itself", () => {
    expect(offenders()).toEqual([]);
  });

  it("scaling money is exact: a ratio of integers, rounded once, half away from zero", () => {
    expect(scaleMoney(money(1_000, "EUR"), 1, 3)).toEqual(money(333, "EUR"));
    expect(scaleMoney(money(1_000, "EUR"), 2, 3)).toEqual(money(667, "EUR"));
    expect(scaleMoney(money(-1_000, "EUR"), 1, 8)).toEqual(money(-125, "EUR"));
    expect(scaleMoney(money(3_541_250, "HUF"), 1, 1)).toEqual(money(3_541_250, "HUF"));
  });

  it("multiply takes the factor's written decimal, not its binary float", () => {
    // 0.1 × 3 as floats is 0.30000000000000004; written, it is 0.3.
    expect(multiply(money(1_000, "EUR"), 0.3)).toEqual(money(300, "EUR"));
    expect(multiply(money(1_005, "EUR"), 0.5)).toEqual(money(503, "EUR"));
    expect(multiply(money(1_000, "EUR"), 1.15)).toEqual(money(1_150, "EUR"));
  });

  it("a ratio of two amounts is reported in basis points, an integer", () => {
    expect(ratioOf(money(250, "EUR"), money(1_000, "EUR"))).toBe(2_500);
    expect(() => ratioOf(money(1, "EUR"), money(1, "HUF"))).toThrow();
  });
});
