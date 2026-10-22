import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SizeFeatureTable } from "./size-features";
import {
  SIZE_BANDS,
  SIZE_FEATURES,
  featuresFor,
  isSizeFeatureKey,
  showsFor,
} from "./size-features";
import { GROUPS } from "../../components/nav/AppFrame";

// Every source file that could name a feature key.
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}
const CODE = ["app", "components", "lib"].flatMap(sources);
const TABLE_FILE = join("lib", "core", "size-features.ts");

// A feature key in code is written as `feature: "…"` or `showsFor("…"`.
const USE = /(?:feature:\s*|showsFor\(\s*)"([a-z0-9_.]+)"/g;

describe("the size-feature table", () => {
  it("has a row for every feature key used in code", () => {
    const used = new Set<string>();
    for (const file of CODE) {
      for (const m of readFileSync(file, "utf8").matchAll(USE)) used.add(m[1] ?? "");
    }
    expect(used.size).toBeGreaterThan(0);
    for (const key of used) expect(isSizeFeatureKey(key), key).toBe(true);
  });

  it("has no row that code never uses", () => {
    const code = CODE.filter((f) => f !== TABLE_FILE)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const key of Object.keys(SIZE_FEATURES)) expect(code.includes(`"${key}"`), key).toBe(true);
  });

  it("gives every menu item a feature key with a row", () => {
    for (const item of GROUPS.flatMap((g) => g.items)) {
      expect(isSizeFeatureKey(item.feature), item.href).toBe(true);
    }
  });

  it("gives every row at least one band and a one-line reason", () => {
    for (const [key, row] of Object.entries(SIZE_FEATURES)) {
      expect(row.bands.length, key).toBeGreaterThan(0);
      for (const b of row.bands) expect(SIZE_BANDS, key).toContain(b);
      expect(row.reason.trim(), key).not.toBe("");
      expect(row.reason, key).not.toMatch(/\n/);
    }
  });

  it("is conservative while provisional: nothing hides for a solo owner yet", () => {
    expect(featuresFor("solo")).toEqual(featuresFor(null));
  });
});

// The mechanism, on a table of its own so it is proven whatever the review decides.
const TABLE: SizeFeatureTable = {
  "x.everyone": { bands: SIZE_BANDS, reason: "everyone" },
  "x.teams": { bands: ["small", "medium", "large"], reason: "not solo" },
  "x.big": { bands: ["large"], reason: "large only" },
};

describe("showsFor / featuresFor — the visibility mechanism", () => {
  it("shows everything when the band is unknown", () => {
    for (const key of Object.keys(TABLE)) expect(showsFor(key, null, TABLE)).toBe(true);
    expect(featuresFor(null, TABLE)).toEqual(["x.big", "x.everyone", "x.teams"]);
    expect(featuresFor(null)).toEqual(Object.keys(SIZE_FEATURES).sort());
  });

  it("hides a row only for the bands it leaves out", () => {
    expect(showsFor("x.teams", "solo", TABLE)).toBe(false);
    expect(showsFor("x.teams", "small", TABLE)).toBe(true);
    expect(showsFor("x.big", "medium", TABLE)).toBe(false);
    expect(showsFor("x.big", "large", TABLE)).toBe(true);
  });

  it("never hides a key the table has no row for", () => {
    expect(showsFor("x.unlisted", "solo", TABLE)).toBe(true);
  });

  it("gives each band the same set on every call, sorted", () => {
    expect(featuresFor("solo", TABLE)).toEqual(["x.everyone"]);
    expect(featuresFor("small", TABLE)).toEqual(["x.everyone", "x.teams"]);
    expect(featuresFor("medium", TABLE)).toEqual(["x.everyone", "x.teams"]);
    expect(featuresFor("large", TABLE)).toEqual(["x.big", "x.everyone", "x.teams"]);
    for (const b of SIZE_BANDS) {
      expect(featuresFor(b)).toEqual(featuresFor(b));
      expect(featuresFor(b, TABLE)).toEqual(featuresFor(b, TABLE));
    }
  });
});
