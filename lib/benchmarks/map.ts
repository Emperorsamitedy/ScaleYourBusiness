// Which Eurostat group a business is compared with — idea 44, I-44.2.
// specs/benchmark-map-v1.json is the mapping (rule 4: data, never an if on
// a business type); this file only applies it. Pure: no database, no
// network, no clock.

import { enumCode } from "../core/enum-value";
import type { SizeBand } from "../core/size-features";
import mapSpec from "../../specs/benchmark-map-v1.json";

export interface MappedType {
  nace: string;
  /** The code one level up, tried when the code's own cell is missing; null for a section. */
  parent: string | null;
  /** The group in the owner's words: "restaurants, cafés and bars". */
  group: string;
  /** One line on what the code covers. */
  covers: string;
}
export interface UnmappedType {
  nace: null;
  why: string;
}
export type TypeEntry = MappedType | UnmappedType;

export interface SizeClass {
  code: string;
  min: number;
  max: number | null;
  words: string;
}

export type CostTreatment = "running" | "staff" | "financing";

interface MapSpec {
  version: string;
  dataset: string;
  business_types: Record<string, TypeEntry>;
  parent_groups: Record<string, string>;
  size_classes: SizeClass[];
  all_sizes: { code: string; words: string };
  size_bands: Record<SizeBand, string[]> & { about: string };
  countries: { eurostat_geo: Record<string, string>; eu27: string[] };
  cost_categories: Record<string, CostTreatment | string>;
}

export const BENCHMARK_MAP = mapSpec as unknown as MapSpec;
export const ALL_SIZES = BENCHMARK_MAP.all_sizes;

/** The type's entry; null for a code the map doesn't name (an answer from a newer bank). */
export function typeEntry(value: unknown, map: MapSpec = BENCHMARK_MAP): TypeEntry | null {
  const code = enumCode(value);
  if (code === null || !Object.hasOwn(map.business_types, code)) return null;
  return map.business_types[code] ?? null;
}

export function isMapped(e: TypeEntry | null): e is MappedType {
  return e !== null && e.nace !== null;
}

export type GeoLookup =
  { status: "eu"; geo: string } | { status: "outside"; iso: string } | { status: "unknown" };

/** Pure: Eurostat's geo code for an ISO alpha-2 country, or that it's outside the EU27. */
export function geoFor(iso: string | null, map: MapSpec = BENCHMARK_MAP): GeoLookup {
  if (iso === null || iso.trim() === "") return { status: "unknown" };
  const code = iso.trim().toUpperCase();
  const geo = map.countries.eurostat_geo[code] ?? code;
  return map.countries.eu27.includes(geo)
    ? { status: "eu", geo }
    : { status: "outside", iso: code };
}

export interface SizePick {
  /** Eurostat size classes to try, most specific first. Empty: compare with every size. */
  codes: string[];
  /** What picked them. */
  via: "team_size" | "size_band" | "none";
  /** Persons employed, the owner included, when the headcount is known. */
  persons: number | null;
}

const width = (c: SizeClass) => (c.max ?? Infinity) - c.min;

/**
 * Pure: the size classes for a business. The headcount (1.6, "including
 * you", which is what Eurostat's persons employed counts) picks every class
 * that holds it, narrowest first; without it, the stated or inferred band;
 * a band that spans two classes picks none.
 */
export function sizeClassesFor(
  teamSize: number | null,
  band: SizeBand | null,
  map: MapSpec = BENCHMARK_MAP,
): SizePick {
  if (teamSize !== null && Number.isFinite(teamSize) && teamSize >= 0) {
    const n = Math.round(teamSize);
    const codes = map.size_classes
      .filter((c) => n >= c.min && (c.max === null || n <= c.max))
      .sort((a, b) => width(a) - width(b))
      .map((c) => c.code);
    return { codes, via: "team_size", persons: n };
  }
  if (band !== null)
    return { codes: [...(map.size_bands[band] ?? [])], via: "size_band", persons: null };
  return { codes: [], via: "none", persons: null };
}

/** Pure: "with 2–9 people" / "of every size". */
export function sizeWords(code: string, map: MapSpec = BENCHMARK_MAP): string {
  if (code === map.all_sizes.code) return map.all_sizes.words;
  const c = map.size_classes.find((s) => s.code === code);
  return c ? `with ${c.words}` : code;
}

/** Pure: how a cost category enters the margin. An unknown or missing one counts as running. */
export function costTreatment(
  category: string | null,
  map: MapSpec = BENCHMARK_MAP,
): CostTreatment {
  const t =
    category !== null && Object.hasOwn(map.cost_categories, category)
      ? map.cost_categories[category]
      : null;
  return t === "staff" || t === "financing" ? t : "running";
}

/** Pure: the group in words for a parent code. */
export function parentGroup(code: string, map: MapSpec = BENCHMARK_MAP): string {
  return Object.hasOwn(map.parent_groups, code) && code !== "about"
    ? map.parent_groups[code]!
    : code;
}

/** Every NACE code the map names, as a type's code or its parent. */
export function mappedNaceCodes(map: MapSpec = BENCHMARK_MAP): string[] {
  const out = new Set<string>();
  for (const e of Object.values(map.business_types)) {
    if (e.nace === null) continue;
    out.add(e.nace);
    if (e.parent) out.add(e.parent);
  }
  return [...out].sort();
}
