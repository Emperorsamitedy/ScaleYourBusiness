// Outside signals: their rules, held by reading the source
// (specs/public-holidays-v1.md).
//
//   1. Worked out, never fetched. Nothing a signal is made of sends a request,
//      reads a connector or calls a model: a public holiday is the law's own
//      list and arithmetic.
//   2. Read, never written. A signal reads the business's country and writes
//      nothing.
//   3. Beside the figure, never in it. The code that works out a forecast or a
//      stock figure does not know a signal exists: the two only meet where a
//      route hands both to a screen.
//   4. Every calendar says where it comes from: the law, where its text was
//      read, the day that text was in force and the day it was read.
//
// Each scan has a planted failing case, so it can't pass by being blind.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOLIDAY_CALENDARS } from "./holidays";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The source files of a folder, tests left out. */
const sourcesOf = (dir: string) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => `${dir}/${f}`);

/** Every file a signal is made of. */
const SIGNAL_SOURCES = [...sourcesOf("lib/signals"), ...sourcesOf("components/signals")];

/** Where the figures the signal sits beside are worked out, and put into words. */
const FIGURE_SOURCES = [
  ...sourcesOf("lib/cash"),
  ...sourcesOf("lib/stock"),
  ...sourcesOf("lib/seasons"),
  "components/cash/cash-view.ts",
  "components/stock/stock-view.ts",
];

/** Comments say what the code must not do; only the code is held to it. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

export interface Breach {
  rule: "sends_a_request" | "reads_a_connector" | "calls_a_model" | "writes";
  match: string;
}

const REQUEST = /\bfetch\(|node:https?|["']undici["']|["']axios["']|XMLHttpRequest|WebSocket\(/;
const CONNECTOR = /\/connectors\/|\/execution\/|metricObservations|\bconnections\b/;
const MODEL = /\/llm\/|@anthropic-ai\/sdk|\/interviewer\/|\/assistant\//;
const WRITES = /\.insert\(|\.update\(|\.delete\(|\bwriteField\(|\bsupersede\w*\(/;

export function breaches(source: string): Breach[] {
  const text = code(source);
  const out: Breach[] = [];
  const hit = (rule: Breach["rule"], re: RegExp) => {
    const m = re.exec(text);
    if (m) out.push({ rule, match: m[0] });
  };
  hit("sends_a_request", REQUEST);
  hit("reads_a_connector", CONNECTOR);
  hit("calls_a_model", MODEL);
  hit("writes", WRITES);
  return out;
}

/** True when the code imports anything of the outside signals. */
export function knowsSignals(source: string): boolean {
  return /from\s+["'][^"']*\/signals\/[^"']*["']|import\(\s*["'][^"']*\/signals\//.test(
    code(source),
  );
}

describe("a signal is worked out and read, never fetched and never written", () => {
  it("finds the signal's files", () => {
    expect(SIGNAL_SOURCES).toEqual(
      expect.arrayContaining([
        "lib/signals/holidays.ts",
        "lib/signals/view.ts",
        "lib/signals/outside.ts",
        "components/signals/holiday-words.ts",
      ]),
    );
  });

  for (const file of SIGNAL_SOURCES) {
    it(`${file} sends no request, reads no connector, calls no model, writes nothing`, () => {
      expect(breaches(read(file)), file).toEqual([]);
    });
  }

  it("the calendar and what a screen is handed are arithmetic: they import nothing but each other", () => {
    for (const file of ["lib/signals/holidays.ts", "lib/signals/view.ts"]) {
      const imports = [...code(read(file)).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const from of imports) expect(from, `${file} imports ${from}`).toBe("./holidays");
    }
  });
});

describe("a signal sits beside a figure and is counted in none", () => {
  it("finds the files that work the figures out", () => {
    expect(FIGURE_SOURCES).toEqual(
      expect.arrayContaining([
        "lib/cash/model.ts",
        "lib/stock/cover.ts",
        "lib/stock/reorder.ts",
        "components/cash/cash-view.ts",
        "components/stock/stock-view.ts",
      ]),
    );
  });

  for (const file of FIGURE_SOURCES) {
    it(`${file} does not know a signal exists`, () => {
      expect(knowsSignals(read(file)), file).toBe(false);
    });
  }

  it("the two meet only where a route hands both to a screen", () => {
    expect(knowsSignals(read("app/api/cash/route.ts"))).toBe(true);
    expect(knowsSignals(read("app/api/stock/route.ts"))).toBe(true);
  });
});

describe("every calendar says where it comes from", () => {
  const DAY = /^\d{4}-\d{2}-\d{2}$/;

  it("has at least one, keyed by its own country", () => {
    expect(Object.keys(HOLIDAY_CALENDARS).length).toBeGreaterThan(0);
    for (const [code, calendar] of Object.entries(HOLIDAY_CALENDARS)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(calendar.country).toBe(code);
    }
  });

  for (const [country, calendar] of Object.entries(HOLIDAY_CALENDARS)) {
    it(`${country}: the law, where it was read, and the two days`, () => {
      expect(calendar.law.trim().length).toBeGreaterThan(0);
      expect(new URL(calendar.url).protocol).toBe("https:");
      expect(calendar.in_force_on).toMatch(DAY);
      expect(calendar.read_on).toMatch(DAY);
      expect(Number.isNaN(Date.parse(`${calendar.in_force_on}T00:00:00Z`))).toBe(false);
      expect(Number.isNaN(Date.parse(`${calendar.read_on}T00:00:00Z`))).toBe(false);
      // A text is read once it is in force: a calendar never answers from a day not yet read.
      expect(calendar.in_force_on <= calendar.read_on).toBe(true);
    });

    it(`${country}: every day on the list is a real day of the year, named once`, () => {
      const keys = [...calendar.fixed.map((f) => f[2]), ...calendar.movable.map((m) => m[1])];
      expect(new Set(keys).size).toBe(keys.length);
      for (const [month, day] of calendar.fixed) {
        const made = new Date(Date.UTC(2028, month - 1, day));
        expect(made.getUTCMonth()).toBe(month - 1);
        expect(made.getUTCDate()).toBe(day);
      }
      for (const [offset] of calendar.movable) expect(Number.isInteger(offset)).toBe(true);
    });
  }
});

describe("the scans see what they are looking for", () => {
  it("catches a request", () => {
    expect(
      breaches('const r = await fetch("https://date.example/api/v3/2027/HU");'),
    ).toContainEqual(expect.objectContaining({ rule: "sends_a_request" }));
    expect(breaches('import https from "node:https";')).toContainEqual(
      expect.objectContaining({ rule: "sends_a_request" }),
    );
  });

  it("catches a connector and a model", () => {
    expect(breaches('import { syncConnection } from "../connectors/sync";')).toContainEqual(
      expect.objectContaining({ rule: "reads_a_connector" }),
    );
    expect(breaches('import { complete } from "../llm/client";')).toContainEqual(
      expect.objectContaining({ rule: "calls_a_model" }),
    );
  });

  it("catches a write", () => {
    expect(breaches("await writeField(profileId, field)")).toContainEqual(
      expect.objectContaining({ rule: "writes" }),
    );
    expect(breaches("await db.insert(holidays).values({})")).toContainEqual(
      expect.objectContaining({ rule: "writes" }),
    );
  });

  it("catches a figure that reads a signal", () => {
    expect(knowsSignals('import { publicHolidays } from "../signals/holidays";')).toBe(true);
    expect(knowsSignals('const m = await import("../../lib/signals/view");')).toBe(true);
    expect(knowsSignals('import { addDays } from "../seasons/forecast";')).toBe(false);
  });

  it("does not take a comment about a rule for a breach of it", () => {
    expect(breaches("// never a fetch( here\nconst a = 1;")).toEqual([]);
    expect(knowsSignals('// see "../signals/holidays" for the days\nconst a = 1;')).toBe(false);
  });

  it("lets a calendar name the page its law was read on: a citation is not a request", () => {
    expect(breaches('const url = "https://njt.jog.gov.hu/jogszabaly/2012-1-00-00";')).toEqual([]);
  });
});
