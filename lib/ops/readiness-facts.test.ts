// The database half of launch readiness, against this machine's database
// (migrated through the journal's newest entry and seeded, as the suite
// expects): the facts it reads, and the verdicts they produce.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import journal from "../../db/migrations/meta/_journal.json";
import { BUNDLED_BANK_VERSION, bundledMigrations, readReadinessFacts } from "./readiness-facts";
import { launchReadiness } from "./readiness";

const known = { law_review: null, first_campaigns_waiting: 0 };

describe("readReadinessFacts — what the database says", () => {
  it("bundledMigrations is the journal this build carries, newest last", () => {
    const b = bundledMigrations();
    expect(b.count).toBe(journal.entries.length);
    expect(b.latest_tag).toBe(journal.entries[journal.entries.length - 1]!.tag);
    expect(
      bundledMigrations([
        { idx: 0, when: 1, tag: "0000_a" },
        { idx: 1, when: 2, tag: "0001_b" },
      ]),
    ).toEqual({ count: 2, latest_tag: "0001_b", latest_when: 2 });
    expect(() => bundledMigrations([])).toThrow(/empty/);
  });

  it("a migrated, seeded database reads as all migrations applied and the bundled bank current", async () => {
    const facts = await readReadinessFacts(known);
    expect(facts.migrations).not.toBeNull();
    expect(facts.migrations!.latest_applied_at).toBe(facts.bundled_migrations.latest_when);
    expect(facts.migrations!.latest_applied_tag).toBe(facts.bundled_migrations.latest_tag);
    expect(facts.bank).toEqual({ seeded: BUNDLED_BANK_VERSION });
    expect(typeof facts.keyed_suppressions).toBe("number");

    const items = launchReadiness({}, facts).groups.find((g) => g.key === "database")!.items;
    expect(items.map((i) => i.status)).toEqual(["ready", "ready"]);
  });

  it("the facts passed in are carried through untouched", async () => {
    const facts = await readReadinessFacts({
      law_review: { state: "stale", words: "It changed." },
      first_campaigns_waiting: 3,
    });
    expect(facts.law_review).toEqual({ state: "stale", words: "It changed." });
    expect(facts.first_campaigns_waiting).toBe(3);
  });
});
