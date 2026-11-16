// Gap 7 (TASKS-IDEAS, 2026-11-17): a town the local snapshot doesn't hold.
//
// The person names it; it is queued (one row per country and town, so a
// town asked for twice is counted once) and the daily job counts a few
// queued towns on OpenStreetMap — the city's own boundary found through
// Nominatim (with its population where OSM has one), then one Overpass
// query with the snapshot's own groups (specs/idea-v1.json). Nothing is
// fetched while a person waits: the public servers are too slow for that
// (D98). A count is a floor, never a total (rule 37). A town that can't be
// found says so; one that keeps failing is given up on after a few tries.
//
// The two network calls are injectable, so every rule is tested offline.

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { localTowns } from "../../db/schema";
import ideaFile from "../../specs/idea-v1.json";
import type { Local } from "./local";

const GROUPS = ideaFile.local.groups as unknown as Record<string, [string, string][]>;
const BY_TYPE = ideaFile.local.by_type as Record<string, string>;
export const MAX_TOWN_ATTEMPTS = 3;
const AGENT = "idea-check/1.0";

/** Letters first, then letters, marks, spaces, apostrophes, dots and hyphens; up to 60. */
export const TOWN_RE = /^\p{L}[\p{L}\p{M}' .-]{1,59}$/u;

export function normalizeTown(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export type TownRow = typeof localTowns.$inferSelect;

/** Queue a town (once per country and town) and return its row as it stands. */
export async function requestTown(country: string, name: string): Promise<TownRow> {
  const display = name.trim().replace(/\s+/g, " ");
  const normalized = normalizeTown(display);
  await db.insert(localTowns).values({ country, name: display, normalized }).onConflictDoNothing();
  const [row] = await db
    .select()
    .from(localTowns)
    .where(and(eq(localTowns.country, country), eq(localTowns.normalized, normalized)));
  return row!;
}

export async function townRow(country: string, name: string): Promise<TownRow | null> {
  const [row] = await db
    .select()
    .from(localTowns)
    .where(and(eq(localTowns.country, country), eq(localTowns.normalized, normalizeTown(name))));
  return row ?? null;
}

/** Pure: what a queued or counted town says for this kind of business. */
export function townLocal(typeCode: string, row: TownRow): Local {
  if (row.status === "queued") return { status: "town", town: row.name, state: "queued" };
  if (row.status !== "counted") return { status: "town", town: row.name, state: "not_found" };
  const group = BY_TYPE[typeCode];
  const counts = (row.counts ?? {}) as Record<string, number>;
  const count = group ? counts[group] : undefined;
  if (!group || count === undefined) return { status: "town", town: row.name, state: "not_found" };
  return {
    status: "town",
    town: row.name,
    state: "counted",
    group,
    count,
    per_10k:
      row.population && row.population > 0
        ? Math.round((count * 100_000) / row.population) / 10 // not money: places per 10,000 residents
        : null,
    counted_at: row.counted_at ?? row.requested_at,
  };
}

export interface TownNet {
  /** The town's own boundary relation and its population, or null when OSM has no such town. */
  find(
    country: string,
    name: string,
  ): Promise<{ relation: number; population: number | null } | null>;
  /** One count per group inside the boundary. */
  count(relation: number): Promise<Record<string, number>>;
}

export function overpassQuery(relation: number): string {
  const area = 3_600_000_000 + relation;
  const lines = Object.values(GROUPS).map(
    (sels) => `(${sels.map(([k, re]) => `nwr["${k}"~"${re}"](area.a);`).join("")});out count;`,
  );
  return `[out:json][timeout:200];area(id:${area})->.a;\n${lines.join("\n")}`;
}

export const liveTownNet: TownNet = {
  async find(country, name) {
    const q = new URLSearchParams({
      city: name,
      countrycodes: country.toLowerCase(),
      format: "jsonv2",
      limit: "3",
      extratags: "1",
    });
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${q}`, {
      headers: { "User-Agent": AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const hits = (await res.json()) as {
      osm_type: string;
      osm_id: number;
      extratags?: { population?: string };
    }[];
    const rel = hits.find((h) => h.osm_type === "relation");
    if (!rel) return null;
    const pop = Number.parseInt((rel.extratags?.population ?? "").replace(/[\s,.]/g, ""), 10);
    return { relation: rel.osm_id, population: Number.isSafeInteger(pop) && pop > 0 ? pop : null };
  },
  async count(relation) {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "User-Agent": AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(overpassQuery(relation))}`,
      signal: AbortSignal.timeout(220_000),
    });
    if (!res.ok) throw new Error(`overpass ${res.status}`);
    const j = (await res.json()) as {
      elements: { type: string; tags?: { total?: string } }[];
      remark?: string;
    };
    if (j.remark && /timed out|runtime error/i.test(j.remark)) throw new Error(j.remark);
    const totals = j.elements.filter((e) => e.type === "count").map((e) => Number(e.tags?.total));
    const keys = Object.keys(GROUPS);
    if (totals.length !== keys.length || totals.some((n) => !Number.isSafeInteger(n))) {
      throw new Error(`expected ${keys.length} counts, got ${totals.length}`);
    }
    return Object.fromEntries(keys.map((k, i) => [k, totals[i]!]));
  },
};

/** The daily job: count the oldest queued towns, a few at a time. */
export async function countQueuedTowns(args: {
  limit: number;
  net?: TownNet;
  now?: Date;
}): Promise<{ counted: number; not_found: number; failed: number }> {
  const net = args.net ?? liveTownNet;
  const out = { counted: 0, not_found: 0, failed: 0 };
  const queued = await db
    .select()
    .from(localTowns)
    .where(eq(localTowns.status, "queued"))
    .orderBy(asc(localTowns.requested_at))
    .limit(args.limit);
  for (const t of queued) {
    try {
      const place = await net.find(t.country, t.name);
      if (!place) {
        await db.update(localTowns).set({ status: "not_found" }).where(eq(localTowns.id, t.id));
        out.not_found++;
        continue;
      }
      const counts = await net.count(place.relation);
      await db
        .update(localTowns)
        .set({
          status: "counted",
          osm_relation: place.relation,
          population: place.population,
          counts,
          counted_at: (args.now ?? new Date()).toISOString(),
        })
        .where(eq(localTowns.id, t.id));
      out.counted++;
    } catch {
      out.failed++;
      await db
        .update(localTowns)
        .set({
          attempts: sql`${localTowns.attempts} + 1`,
          status: t.attempts + 1 >= MAX_TOWN_ATTEMPTS ? "gave_up" : "queued",
        })
        .where(eq(localTowns.id, t.id));
    }
  }
  return out;
}
