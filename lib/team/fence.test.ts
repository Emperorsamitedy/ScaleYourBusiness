// Rule 28's fence (P5-19): staff planning is about roles, never people.
// A build-failing scan of every Session E source file:
//
//   · no per-person scoring, ranking or rating function exists — not as an
//     export, not as a local function, not as a call;
//   · the code never touches a name or a per-person column: the bookings'
//     team-member and client columns, a 9.2 row's tasks, cost or
//     replaceability, a user's display name, anything's `.name`;
//   · the loader selects only the booking columns and role fields it needs.
//
// Comments are stripped first, so the files can explain the rule in words.
//
// P6-06 amended rule 28 (TASKS-PHASE6.md): the owner may now see each
// person's own figures. They live apart, in lib/people and its /team
// section, under their own fence (lib/people/fence.test.ts); this one
// still holds the role-level cover to roles and hours, unchanged.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as coverage from "./coverage";
import * as load from "./load";
import * as mod from "./module";

const FILES = [
  "lib/team/coverage.ts",
  "lib/team/load.ts",
  "lib/team/module.ts",
  "app/api/team/route.ts",
  "app/team/page.tsx",
  "components/team/TeamScreen.tsx",
];

/** The code with comments removed (block, then line; URLs aren't in these files). */
function code(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SCORING = /\b\w*(score|rank|grade|rating|appraise|perform|leaderboard)\w*\b/i;
const PERSONAL =
  /\b(staff_ref|client_key|main_tasks|cost_monthly|replaceability|display_name|engagement|first_name|last_name|full_name|employee)\b|\.name\b/;

describe("rule 28 — no per-person scoring function exists", () => {
  it("exports nothing that scores, ranks or concerns a person", () => {
    const names = [...Object.keys(coverage), ...Object.keys(load), ...Object.keys(mod)];
    expect(names.length).toBeGreaterThan(5);
    for (const n of names) {
      expect(n, n).not.toMatch(
        /score|rank|grade|rating|person|people|individual|employee|perform/i,
      );
    }
  });

  it("has no scoring or ranking identifier anywhere in Session E's code", () => {
    for (const f of FILES) {
      // Owner-facing sentences may say what it never does ("it never scores…").
      const hit = SCORING.exec(code(f).replace(/"(?:[^"\\\n]|\\.)*"/g, '""'));
      expect(hit?.[0] ?? null, f).toBeNull();
    }
  });

  it("the scan is not vacuous: it catches a scoring function and a name read", () => {
    expect(SCORING.test("export function scoreStylist(p) {}")).toBe(true);
    expect(SCORING.test("const ranked = rows.sort(byHours)")).toBe(true);
    expect(PERSONAL.test("rows.map((r) => r.name)")).toBe(true);
    expect(PERSONAL.test("select({ staff_ref: bookingAppointments.staff_ref })")).toBe(true);
    expect(SCORING.test("const cover = rolesOf(roles, hours)")).toBe(false);
  });
});

describe("rule 28 — names and per-person columns are never read", () => {
  it("never touches a name or a per-person column", () => {
    for (const f of FILES) {
      const hit = PERSONAL.exec(code(f));
      expect(hit?.[0] ?? null, f).toBeNull();
    }
  });

  it("selects only the booking columns coverage needs", () => {
    const src = code("lib/team/load.ts");
    const used = new Set([...src.matchAll(/bookingAppointments\.(\w+)/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual(["connection_id", "day", "id", "start_time", "status"]);
  });

  it("reads only the role title and hours from a 9.2 row", () => {
    expect([...load.ROLE_FIELDS]).toEqual(["role_title", "hours_per_week"]);
  });
});
