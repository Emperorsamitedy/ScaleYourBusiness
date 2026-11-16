// Local competition — D98 (TASKS-IDEAS, the owner's choice of 2026-11-17).
// Pure: reads the dated snapshot specs/local-counts-v1.json and nothing
// else (no network at run time).
//
// For the city the person chose, how many places of the same kind are
// mapped on OpenStreetMap inside its boundary, and how many that is for
// every 10,000 residents, beside the same figure for the country's other
// big cities in the snapshot. Two honesty rules (rule 37):
//   · a count is a FLOOR: OpenStreetMap is volunteer-mapped and misses
//     places, more in some cities than others — the words always say so;
//   · it is a reference beside the plan, never merged into it, and a
//     business type that can't be counted honestly says why, with no number.

import snapshot from "../../specs/local-counts-v1.json";
import ideaFile from "../../specs/idea-v1.json";

interface SnapCity {
  country: string;
  wikidata: string;
  osm_relation: number;
  population: number;
  names: Record<string, string>;
  counts?: Record<string, number>;
  counted_at?: string;
}

const SNAP = snapshot as unknown as { sources: { retrieved: string }; cities: SnapCity[] };
const CITIES = SNAP.cities.filter((c) => c.counts && c.population > 0);
const LOCAL = ideaFile.local as unknown as {
  by_type: Record<string, string>;
  not_counted: Record<"online" | "too_broad" | "rarely_mapped", string[]>;
};

export const LOCAL_RETRIEVED = SNAP.sources.retrieved;

export interface CityOption {
  id: string;
  names: Record<string, string>;
}

/** The counted cities of a country, largest first: what the city question offers. */
export function citiesOf(iso: string): CityOption[] {
  return CITIES.filter((c) => c.country === iso)
    .sort((a, b) => b.population - a.population)
    .map((c) => ({ id: c.wikidata, names: c.names }));
}

export function isCityOf(iso: string, id: string): boolean {
  return CITIES.some((c) => c.country === iso && c.wikidata === id);
}

/** Every counted city's English name → its id, for reading a description. */
export function cityByEnglishName(iso: string | undefined, name: string): string | undefined {
  const n = name.trim().toLowerCase();
  return CITIES.find(
    (c) => (iso === undefined || c.country === iso) && c.names.en?.toLowerCase() === n,
  )?.wikidata;
}

export const CITY_NAMES_EN: readonly string[] = [
  ...new Set(CITIES.map((c) => c.names.en).filter((n): n is string => !!n)),
];

export interface CityFigure {
  id: string;
  names: Record<string, string>;
  count: number;
  /** Places for every 10,000 residents, one decimal (not money). */
  per_10k: number;
}

export type Local =
  | {
      status: "shown";
      group: string;
      city: CityFigure;
      population: number;
      /** The country's other counted cities, for comparison. */
      others: CityFigure[];
      counted_at: string;
    }
  | { status: "not_counted"; why: "online" | "too_broad" | "rarely_mapped" }
  /** No city chosen, or none counted; `offered` when the country has counted cities to choose. */
  | { status: "no_city"; offered: boolean }
  /** Gap 7: a town the person named, queued for the daily count or already counted. */
  | { status: "town"; town: string; state: "queued" }
  | { status: "town"; town: string; state: "not_found" }
  | {
      status: "town";
      town: string;
      state: "counted";
      group: string;
      count: number;
      /** Null when OpenStreetMap has no population for the town. */
      per_10k: number | null;
      counted_at: string;
    };

const per10k = (count: number, population: number) =>
  Math.round((count * 100_000) / population) / 10; // not money: places per 10,000 residents, one decimal

const figure = (c: SnapCity, group: string): CityFigure => ({
  id: c.wikidata,
  names: c.names,
  count: c.counts![group]!,
  per_10k: per10k(c.counts![group]!, c.population),
});

/** Pure: the local count for a business type in a chosen city, or why there isn't one. */
export function localFor(typeCode: string, iso: string, cityId: string | null): Local {
  for (const [why, types] of Object.entries(LOCAL.not_counted)) {
    if (types.includes(typeCode)) return { status: "not_counted", why: why as "online" };
  }
  const group = LOCAL.by_type[typeCode];
  if (!group) return { status: "not_counted", why: "too_broad" };
  const city = cityId ? CITIES.find((c) => c.wikidata === cityId && c.country === iso) : undefined;
  if (!city || city.counts?.[group] === undefined) {
    return { status: "no_city", offered: citiesOf(iso).length > 0 };
  }
  return {
    status: "shown",
    group,
    city: figure(city, group),
    population: city.population,
    others: CITIES.filter(
      (c) => c.country === iso && c.wikidata !== city.wikidata && c.counts?.[group] !== undefined,
    )
      .sort((a, b) => b.population - a.population)
      .map((c) => figure(c, group)),
    counted_at: city.counted_at ?? LOCAL_RETRIEVED,
  };
}
