// D98: local competition from the dated snapshot — every business type
// either counted or saying why, the per-10,000 figure worked from the
// snapshot's own numbers, and a city only ever from the chosen country.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import benchmarkMap from "../../specs/benchmark-map-v1.json";
import ideaFile from "../../specs/idea-v1.json";
import snapshot from "../../specs/local-counts-v1.json";
import { checkIdeaAnswers } from "./check";
import { cleanDescribed } from "./describe";
import { citiesOf, localFor } from "./local";

type Snap = {
  cities: {
    country: string;
    wikidata: string;
    population: number;
    names: Record<string, string>;
    counts?: Record<string, number>;
  }[];
};
const counted = (snapshot as unknown as Snap).cities.filter((c) => c.counts);
const LOCAL = ideaFile.local as unknown as {
  groups: Record<string, unknown>;
  by_type: Record<string, string>;
  not_counted: Record<string, string[]>;
};

describe("D98 — every business type is counted or says why", () => {
  it("places every type once, and every group it names exists", () => {
    const types = Object.keys((benchmarkMap as { business_types: object }).business_types);
    const placed = [...Object.keys(LOCAL.by_type), ...Object.values(LOCAL.not_counted).flat()];
    expect([...placed].sort()).toEqual([...types].sort());
    for (const g of Object.values(LOCAL.by_type)) expect(LOCAL.groups).toHaveProperty(g);
  });

  it("an online, broad or rarely mapped type gets a reason and no number", () => {
    expect(localFor("consulting", "HU", null)).toEqual({ status: "not_counted", why: "online" });
    expect(localFor("retail_shop", "HU", null)).toEqual({
      status: "not_counted",
      why: "too_broad",
    });
    expect(localFor("cleaning_services", "HU", null)).toEqual({
      status: "not_counted",
      why: "rarely_mapped",
    });
  });
});

describe("D98 — a counted city", () => {
  it("has at least one city counted in the snapshot", () => {
    expect(counted.length).toBeGreaterThan(0);
  });

  it("gives the count and places per 10,000 residents from the snapshot's own numbers", () => {
    const c = counted[0]!;
    const got = localFor("cafe", c.country, c.wikidata);
    if (got.status !== "shown") throw new Error(`expected shown, got ${got.status}`);
    const cafes = c.counts!.cafes!;
    expect(got.city.count).toBe(cafes);
    expect(got.city.per_10k).toBe(Math.round((cafes * 100_000) / c.population) / 10);
    expect(got.others.every((o) => o.id !== c.wikidata)).toBe(true);
    expect(got.group).toBe("cafes");
  });

  it("no city chosen says whether there were cities to choose", () => {
    const c = counted[0]!;
    expect(localFor("cafe", c.country, null)).toEqual({ status: "no_city", offered: true });
    expect(localFor("cafe", "XX", null)).toEqual({ status: "no_city", offered: false });
  });

  it("a city is only ever from the chosen country", () => {
    const c = counted[0]!;
    const other = ["HU", "AT", "DE", "FR"].find((iso) => iso !== c.country)!;
    expect(citiesOf(c.country).map((x) => x.id)).toContain(c.wikidata);
    expect(localFor("cafe", other, c.wikidata)).toMatchObject({ status: "no_city" });
    const base = {
      sector: "cafe",
      customer: "consumer",
      revenue_model: "recruitment",
      currency: "EUR",
    };
    expect(checkIdeaAnswers({ ...base, country: c.country, city: c.wikidata }).city).toBe(
      c.wikidata,
    );
    expect(() => checkIdeaAnswers({ ...base, country: other, city: c.wikidata })).toThrow(/city/);
  });

  it("a description names a city in English, read only within its country", () => {
    const c = counted[0]!;
    expect(cleanDescribed({ country: c.country, city: c.names.en })).toMatchObject({
      city: c.wikidata,
    });
    expect(cleanDescribed({ country: c.country, city: "Atlantis" }).city).toBeUndefined();
  });
});
