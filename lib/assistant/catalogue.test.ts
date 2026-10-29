// Feature 33 — the change catalogue's coverage. Every row points at a
// screen that exists, at a section that screen actually renders, and has
// a handler; the kinds, the rows and the dispatch table are one set.

import "dotenv/config";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANGE_CATALOGUE, deepLink, entryFor, entryOwningField, sectionId } from "./catalogue";
import { HANDLED_KINDS } from "./changes";
import { CHANGE_KINDS } from "./kinds";
import { ROLE_ACTIONS, isRoleAction } from "../auth/roles";

const ROOT = join(__dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) ? [readFileSync(path, "utf8")] : [];
  });
}

describe("the change catalogue", () => {
  it("idea 52: every row names the role action its screen's route checks", () => {
    for (const e of CHANGE_CATALOGUE) expect(isRoleAction(e.role_action), e.kind).toBe(true);
    // Stopping is anyone's; starting again, connections and facts are an owner's.
    expect(ROLE_ACTIONS[entryFor("stop").role_action].min).toBe("viewer");
    expect(ROLE_ACTIONS[entryFor("resume").role_action].min).toBe("owner");
    expect(ROLE_ACTIONS[entryFor("connection").role_action].min).toBe("owner");
    expect(ROLE_ACTIONS[entryFor("standing_rule").role_action].min).toBe("owner");
    expect(ROLE_ACTIONS[entryFor("content_item").role_action].min).toBe("manager");
  });

  it("has exactly one row per kind, and the dispatch table handles every kind", () => {
    expect(CHANGE_CATALOGUE.map((e) => e.kind).sort()).toEqual([...CHANGE_KINDS].sort());
    expect([...HANDLED_KINDS].sort()).toEqual([...CHANGE_KINDS].sort());
  });

  it("every row's route is a real page in the app", () => {
    for (const entry of CHANGE_CATALOGUE) {
      const page = join(ROOT, "app", ...entry.route.split("/").filter(Boolean), "page.tsx");
      expect(existsSync(page), `${entry.kind} → ${entry.route}`).toBe(true);
    }
  });

  it("every row's section is an element id its screens render", () => {
    const ui = sources(join(ROOT, "components")).join("\n");
    for (const entry of CHANGE_CATALOGUE) {
      const fixed = entry.section.split("{slot}")[0] as string;
      expect(fixed.length, entry.kind).toBeGreaterThan(0);
      // A per-record id ("fact-presence.opening_hours") is rendered by its template ("fact-${key}").
      const prefix = fixed.slice(0, fixed.indexOf("-") + 1);
      const rendered =
        ui.includes(`id="${fixed}"`) ||
        ui.includes(`data-focus="${fixed}"`) ||
        ui.includes(`id={\`${fixed}\${`) ||
        (prefix !== "" && ui.includes(`id={\`${prefix}\${`));
      expect(rendered, `${entry.kind} → #${entry.section}`).toBe(true);
    }
  });

  it("a confirm button exactly where the assistant may prepare; none where it only links", () => {
    for (const entry of CHANGE_CATALOGUE) {
      if (entry.prepare === "link") expect(entry.confirm, entry.kind).toBeNull();
      else expect(entry.confirm, entry.kind).toMatch(/\S/);
      expect(entry.note.length, entry.kind).toBeGreaterThan(10);
      expect(entry.cues.length, entry.kind).toBeGreaterThan(0);
    }
    // The ones the brief names: connecting needs the owner's login; the stop is one click.
    expect(entryFor("connection").prepare).toBe("link");
    expect(entryFor("stop").prepare).toBe("direct");
    expect(entryFor("standing_rule_remove").prepare).toBe("link");
    // Customer-facing words and anything published go through the queue (rule 12).
    expect(entryFor("knowledge_answer").prepare).toBe("proposal");
    expect(entryFor("content_item").prepare).toBe("proposal");
  });

  it("builds the deep link as the route plus ?focus= for the exact section", () => {
    expect(deepLink(entryFor("reply_time"))).toBe("/support?focus=sp-time");
    expect(deepLink(entryFor("fact_value"), "identity.team_size")).toBe(
      "/profile?focus=fact-identity.team_size",
    );
    expect(deepLink(entryFor("connection"))).toBe("/connections");
    expect(sectionId(entryFor("goal"), "g1")).toBe("goal-g1");
  });

  it("a fact another row owns is changed by that row", () => {
    expect(entryOwningField("presence.opening_hours")?.kind).toBe("opening_hours");
    expect(entryOwningField("identity.size_band")?.kind).toBe("size_band");
    expect(entryOwningField("goals.owner_boundaries")?.kind).toBe("standing_rule");
    expect(entryOwningField("identity.team_size")).toBeNull();
  });
});
