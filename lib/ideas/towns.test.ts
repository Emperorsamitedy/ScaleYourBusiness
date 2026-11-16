// Gap 7: a town outside the snapshot is queued once, counted by the daily
// job, says when it can't be found, and is given up after a few failures.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import type { IdeaAnswers } from "./check";
import { checkIdeaAnswers, runIdea } from "./check";
import type { TownNet } from "./towns";
import {
  MAX_TOWN_ATTEMPTS,
  countQueuedTowns,
  normalizeTown,
  requestTown,
  townLocal,
  townRow,
} from "./towns";

const unique = (name: string) => `${name} ${crypto.randomUUID().slice(0, 6).replace(/\d/g, "x")}`;
const COUNTS = {
  restaurants: 40,
  cafes: 12,
  bars: 9,
  hairdressers: 15,
  beauty: 20,
  fitness: 3,
  massage_spa: 2,
  health: 25,
  childcare: 8,
  car_repair: 6,
  stays: 5,
  estate_agents: 4,
  bakeries: 7,
};
const found = (population: number | null): TownNet => ({
  find: async () => ({ relation: 123, population }),
  count: async () => COUNTS,
});

describe("gap 7 — a named town is queued once and counted by the daily job", () => {
  it("one row per country and town, however it is typed", async () => {
    const name = unique("Kecskemét");
    const a = await requestTown("HU", name);
    const b = await requestTown("HU", `  ${name.toUpperCase()}  `);
    expect(b.id).toBe(a.id);
    expect(normalizeTown(`  ${name.toUpperCase()}  `)).toBe(normalizeTown(name));
    expect(townLocal("cafe", a)).toEqual({ status: "town", town: name, state: "queued" });
  });

  it("counted: the group's count, and per 10,000 residents when there is a population", async () => {
    const name = unique("Szolnok");
    await requestTown("HU", name);
    await countQueuedTowns({ limit: 50, net: found(70_000) });
    const row = (await townRow("HU", name))!;
    expect(row.status).toBe("counted");
    expect(townLocal("cafe", row)).toMatchObject({
      state: "counted",
      group: "cafes",
      count: 12,
      per_10k: 1.7, // 12 × 10 000 ÷ 70 000
    });
  });

  it("no population on the map: the count alone, never a made-up density", async () => {
    const name = unique("Tata");
    await requestTown("HU", name);
    await countQueuedTowns({ limit: 50, net: found(null) });
    expect(townLocal("bar", (await townRow("HU", name))!)).toMatchObject({
      state: "counted",
      count: 9,
      per_10k: null,
    });
  });

  it("a town the map doesn't know says so", async () => {
    const name = unique("Nowhereville");
    await requestTown("HU", name);
    await countQueuedTowns({
      limit: 50,
      net: { find: async () => null, count: async () => COUNTS },
    });
    expect(townLocal("cafe", (await townRow("HU", name))!)).toMatchObject({ state: "not_found" });
  });

  it("a town that keeps failing is given up after a few tries", async () => {
    const name = unique("Flakytown");
    await requestTown("HU", name);
    const failing: TownNet = {
      find: async () => {
        throw new Error("502");
      },
      count: async () => COUNTS,
    };
    for (let i = 0; i < MAX_TOWN_ATTEMPTS; i++) await countQueuedTowns({ limit: 50, net: failing });
    const row = (await townRow("HU", name))!;
    expect(row.status).toBe("gave_up");
    expect(townLocal("cafe", row)).toMatchObject({ state: "not_found" });
  });
});

describe("gap 7 — the town in the answers", () => {
  const base = {
    sector: "cafe",
    country: "HU",
    customer: "consumer",
    revenue_model: "recruitment",
    currency: "HUF",
  };

  it("takes a town's name in letters, only when no listed city was chosen", () => {
    expect(checkIdeaAnswers({ ...base, town: "  Székesfehérvár " }).town).toBe("Székesfehérvár");
    expect(() => checkIdeaAnswers({ ...base, town: "<script>" })).toThrow(/town/);
    expect(() => checkIdeaAnswers({ ...base, town: "12 Main St" })).toThrow(/town/);
  });

  it("a check that names a town queues it and says so", async () => {
    const name = unique("Eger");
    const answers: IdeaAnswers = {
      ...(base as unknown as IdeaAnswers),
      revenue_model: "one_off",
      price: 900,
      variable_cost: 250,
      customers_month: 1_800,
      fixed_month: 1_100_000,
      startup: 4_000_000,
      capital: 5_000_000,
      team: 2,
      ramp_months: 3,
      town: name,
    };
    const out = await runIdea({ answers, locale: "en" });
    expect(out.result.status === "worked" && out.result.local).toEqual({
      status: "town",
      town: name,
      state: "queued",
    });
  });
});
