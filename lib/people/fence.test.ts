// Rule 28 amended (P6-06): per-person figures are facts about the work,
// shown to the owner — never ranked into a verdict, never turned into a
// proposal about the person. A build-failing scan of the module:
//
//   · nothing scores, ranks, grades or rates a person — not as an export,
//     not as a local function, not as a call — and the only ordering is the
//     alphabetical one;
//   · no word the owner reads about a person passes a verdict ("top",
//     "under-performing", "needs coaching" …), in English or in the six
//     other languages;
//   · nothing about a person can become a proposal: the module imports no
//     proposal, watch, execution or notice code, and nothing outside the
//     /team people section and the bookings store imports the module;
//   · the owner role alone reads or changes it.
//
// Comments are stripped first, so the files can explain the rule in words.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { ROLE_ACTIONS, ROLES, roleAllows } from "../auth/role-actions";
import { LOCALES } from "../i18n/locales";
import * as figures from "./figures";
import * as staff from "./staff-key";

const ROOT = process.cwd();

const FILES = [
  "lib/people/figures.ts",
  "lib/people/service.ts",
  "lib/people/staff-key.ts",
  "app/api/team/people/route.ts",
  "components/team/PeopleFigures.tsx",
];

/** The code with comments removed (block, then line; URLs aren't in these files). */
function code(file: string): string {
  return readFileSync(join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** And with string literals emptied too: owner-facing words may say what it never does. */
const bare = (file: string) => code(file).replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

const SCORING =
  /\b\w*(score|rank|grade|rating|appraise|perform|leaderboard|verdict|benchmark)\w*\b/i;

/** Words that judge a person, in English. */
const VERDICT_EN =
  /\b(top|best|worst|stars?|leader\w*|rank\w*|scor\w*|rating\w*|grad(e|ed|ing)|\w*perform\w*|coach\w*|improv\w*|weak\w*|strong\w*|poor\w*|excellent|good|bad|great|lag\w*|behind|ahead|struggl\w*|warn\w*|concern\w*|should|must|compar\w*|average|above|below|better|worse|fail\w*|slow|fast|lazy|reliab\w*|unreliab\w*|attention|problem\w*|issue\w*)\b/i;

/** And a handful in each of the other six: best, worst, performance, coaching, ranking. */
const VERDICT_OTHER: Record<string, RegExp> = {
  "de-DE": /(beste|schlechteste|leistung|coaching|rangliste|spitzen|bewertung)/i,
  "es-ES": /(mejor|peor|rendimiento|coaching|clasificaci|puntuaci)/i,
  "fr-FR": /(meilleur|pire|performance|coaching|classement|note )/i,
  "hu-HU": /(legjobb|legrosszabb|teljesítmény|coaching|rangsor|pontsz)/i,
  "ru-RU": /(лучш|худш|эффективност|коучинг|рейтинг|оценк)/i,
  "zh-Hans": /(最佳|最差|绩效|排名|表现|评分|辅导)/,
};

type Tree = { [k: string]: string | Tree };
const strings = (t: Tree): string[] =>
  Object.values(t).flatMap((v) => (typeof v === "string" ? [v] : strings(v)));
const catalogue = (locale: string): Tree =>
  JSON.parse(readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8")) as Tree;

describe("rule 28 amended — nothing scores, ranks or orders by a figure", () => {
  it("exports nothing that scores, ranks or rates", () => {
    const names = [...Object.keys(figures), ...Object.keys(staff)];
    expect(names.length).toBeGreaterThan(3);
    for (const n of names) expect(n, n).not.toMatch(SCORING);
  });

  it("has no scoring or ranking identifier anywhere in the module's code", () => {
    for (const f of FILES) {
      const hit = SCORING.exec(bare(f));
      expect(hit?.[0] ?? null, f).toBeNull();
    }
  });

  it("sorts once, alphabetically, and nowhere else", () => {
    for (const f of FILES) {
      const sorts = [...bare(f).matchAll(/\.sort\(/g)].length;
      expect(sorts, f).toBe(f === "lib/people/figures.ts" ? 1 : 0);
    }
    expect(bare("lib/people/figures.ts")).toMatch(/\.sort\(\(a, b\) => collator\.compare\(a, b\)/);
  });

  it("the scans are not vacuous", () => {
    expect(SCORING.test("export function scoreStylist(p) {}")).toBe(true);
    expect(SCORING.test("const ranked = people.sort(byRevenue)")).toBe(true);
    expect(SCORING.test("const lines = personLines(p)")).toBe(false);
  });
});

describe("rule 28 amended — no word about a person is a verdict", () => {
  it("reads no verdict in any English word the section shows", () => {
    const words = [
      ...strings(en.people as Tree),
      en.roleWords.refusal.people_read,
      en.roleWords.refusal.people_manage,
    ];
    expect(words.length).toBeGreaterThan(30);
    for (const w of words) expect(VERDICT_EN.exec(w)?.[0] ?? null, w).toBeNull();
  });

  it("reads none in the six other languages either", () => {
    for (const locale of LOCALES) {
      if (locale === "en") continue;
      const people = catalogue(locale).people;
      expect(people, locale).toBeDefined();
      for (const w of strings(people as Tree)) {
        expect(VERDICT_OTHER[locale]?.exec(w)?.[0] ?? null, `${locale}: ${w}`).toBeNull();
      }
    }
  });

  it("the word scan is not vacuous", () => {
    for (const s of [
      "Aoife is a top performer",
      "Marta is under-performing",
      "Sinead needs coaching",
      "Best stylist this month",
      "Below the team average",
    ]) {
      expect(VERDICT_EN.test(s), s).toBe(true);
    }
    expect(VERDICT_EN.test("6 of 120 due appointments")).toBe(false);
    expect(VERDICT_OTHER["de-DE"]?.test("die beste Stylistin")).toBe(true);
  });

  it("puts no words of its own on the figures: the server sends names, numbers and codes", () => {
    const src = bare("lib/people/figures.ts") + bare("lib/people/service.ts");
    expect(src).not.toMatch(/\btr\(|englishTr|requestTr/);
  });
});

describe("rule 28 amended — nothing about a person becomes a proposal", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }
  const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

  it("imports no proposal, watch, execution, notice or model code", () => {
    for (const f of FILES) {
      const imports = [...code(f).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
      for (const i of imports) {
        expect(i, `${f} imports ${i}`).not.toMatch(
          /\/(proposals|watch|execution|notify|push|alerts|summary|llm|anthropic|chat|content|crm)\b/,
        );
      }
    }
  });

  it("is imported only by its own section, its route and the bookings store", () => {
    const allowed = new Set([
      ...FILES,
      "app/team/page.tsx",
      "lib/bookings/store.ts", // honours a removal (staff-key only)
      "scripts/seed-demo.ts",
    ]);
    const importers = ["lib", "app", "components", "scripts"]
      .flatMap((d) => walk(join(ROOT, d)))
      .filter((p) => /from\s+"[^"]*\/people\/[^"]*"|PeopleFigures"/.test(readFileSync(p, "utf8")))
      .map(rel);
    expect(importers.length).toBeGreaterThan(1);
    for (const f of importers) expect(allowed.has(f), f).toBe(true);
    expect(code("lib/bookings/store.ts")).not.toMatch(/people\/(figures|service)/);
  });
});

describe("rule 28 amended — shown to the owner only", () => {
  it("lets only the owner read or change per-person figures", () => {
    for (const a of ["people.read", "people.manage"] as const) {
      expect(ROLE_ACTIONS[a].min, a).toBe("owner");
      for (const r of ROLES) expect(roleAllows(r, a), `${r} ${a}`).toBe(r === "owner");
    }
  });

  it("checks the role in every handler before anything is read", () => {
    const src = code("app/api/team/people/route.ts");
    for (const [method, action, call] of [
      ["GET", "people.read", "peopleView("],
      ["POST", "people.manage", "stateCapacity("],
      ["DELETE", "people.manage", "removePerson("],
    ] as const) {
      const start = src.indexOf(`export async function ${method}(`);
      const end = src.indexOf("\nexport", start + 1);
      const handler = src.slice(start, end === -1 ? undefined : end);
      const gate = handler.indexOf(`requireRole(access, "${action}")`);
      expect(gate, method).toBeGreaterThan(0);
      expect(handler.indexOf(call), method).toBeGreaterThan(gate);
    }
  });
});
