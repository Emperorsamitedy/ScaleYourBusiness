// D98 (TASKS-IDEAS, local competition) — the snapshot behind "how many
// places like this are near you". Run by hand, never at build time or in CI:
//
//   npm run local:fetch
//
// It writes specs/local-counts-v1.json, which the app reads and nothing
// else: the app makes no network call for a local count.
//
// Two open sources:
//   · Wikidata (CC0), the query service: each country's largest cities —
//     population (P1082), OpenStreetMap relation (P402) and names in the
//     app's seven languages. One request per country.
//   · OpenStreetMap (ODbL), through the Overpass API: per city, inside its
//     own boundary relation, one count per group in specs/idea-v1.json's
//     `local.groups`, all in one request.
//
// Manners: one request at a time, a pause between them, at most 4 attempts
// each with a growing wait, and a cap on requests per run. The public
// Overpass server is often busy, so the run is RESUMABLE: the file is
// written after every city, and a city already counted is skipped on the
// next run. A city that never answered is simply left out — the app offers
// only the cities in the file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import benchmarkMap from "../specs/benchmark-map-v1.json";
import ideaFile from "../specs/idea-v1.json";

const OUT = join(process.cwd(), "specs", "local-counts-v1.json");
const WIKIDATA = "https://query.wikidata.org/sparql";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const AGENT = "idea-check-data/1.0";
const LANGS = {
  en: "en",
  de: "de-DE",
  es: "es-ES",
  fr: "fr-FR",
  hu: "hu-HU",
  ru: "ru-RU",
  zh: "zh-Hans",
};
const COUNTRIES = [
  ...(benchmarkMap as { countries: { eu27: string[] } }).countries.eu27.map((c) =>
    c === "EL" ? "GR" : c,
  ),
  "CH",
  "NO",
  "IS",
  "GB",
];
const PER_COUNTRY = ideaFile.local.cities_per_country;
const GROUPS = ideaFile.local.groups as unknown as Record<string, [string, string][]>;
const MAX_REQUESTS = 400;
const PAUSE_MS = 8_000;

let requests = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(
  url: string,
  body: string,
  accept: string,
  timeoutMs: number,
): Promise<unknown> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (requests >= MAX_REQUESTS) throw new Error(`request cap of ${MAX_REQUESTS} reached`);
    requests++;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": AGENT,
          Accept: accept,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.log(`    attempt ${attempt} failed: ${(e as Error).message}`);
      if (attempt === 4) throw e;
      await sleep(15_000 * attempt);
    }
  }
  throw new Error("unreachable");
}

interface City {
  country: string;
  wikidata: string;
  osm_relation: number;
  population: number;
  names: Record<string, string>;
  counts?: Record<string, number>;
  counted_at?: string;
}

async function citiesOf(iso: string): Promise<City[]> {
  const q = `SELECT ?city ?pop ?osm ?l WHERE {
  ?country wdt:P297 "${iso}" .
  ?city wdt:P17 ?country ; wdt:P31/wdt:P279* wd:Q515 ; wdt:P1082 ?pop ; wdt:P402 ?osm .
  OPTIONAL { ?city rdfs:label ?l . FILTER(LANG(?l) IN (${Object.keys(LANGS)
    .map((l) => `"${l}"`)
    .join(",")})) }
  FILTER(?pop > 20000)
}`;
  const j = (await post(
    WIKIDATA,
    `query=${encodeURIComponent(q)}`,
    "application/sparql-results+json",
    90_000,
  )) as {
    results: {
      bindings: {
        city: { value: string };
        pop: { value: string };
        osm: { value: string };
        l?: { value: string; "xml:lang": string };
      }[];
    };
  };
  const byCity = new Map<string, City>();
  for (const b of j.results.bindings) {
    const id = b.city.value.replace(/^.*\//, "");
    const osm = Number(b.osm.value);
    const pop = Math.round(Number(b.pop.value));
    if (!Number.isSafeInteger(osm) || !Number.isFinite(pop)) continue;
    const c = byCity.get(id) ?? {
      country: iso,
      wikidata: id,
      osm_relation: osm,
      population: pop,
      names: {},
    };
    // Several truthy populations (no preferred rank): the largest is kept, said so in the file.
    c.population = Math.max(c.population, pop);
    if (b.l) {
      const app = LANGS[b.l["xml:lang"] as keyof typeof LANGS];
      if (app) c.names[app] = b.l.value;
    }
    byCity.set(id, c);
  }
  return [...byCity.values()]
    .filter((c) => c.names.en)
    .sort((a, b) => b.population - a.population)
    .slice(0, PER_COUNTRY);
}

function overpassQuery(relation: number): string {
  const area = 3_600_000_000 + relation;
  const lines = Object.values(GROUPS).map(
    (sels) => `(${sels.map(([k, re]) => `nwr["${k}"~"${re}"](area.a);`).join("")});out count;`,
  );
  return `[out:json][timeout:240];area(id:${area})->.a;\n${lines.join("\n")}`;
}

async function count(city: City): Promise<Record<string, number>> {
  const j = (await post(
    OVERPASS,
    `data=${encodeURIComponent(overpassQuery(city.osm_relation))}`,
    "application/json",
    260_000,
  )) as { elements: { type: string; tags?: { total?: string } }[]; remark?: string };
  if (j.remark && /timed out|runtime error/i.test(j.remark)) throw new Error(j.remark);
  const totals = j.elements.filter((e) => e.type === "count").map((e) => Number(e.tags?.total));
  const keys = Object.keys(GROUPS);
  if (totals.length !== keys.length || totals.some((n) => !Number.isSafeInteger(n))) {
    throw new Error(`expected ${keys.length} counts, got ${totals.length}`);
  }
  return Object.fromEntries(keys.map((k, i) => [k, totals[i]!]));
}

function write(cities: City[], retrieved: string): void {
  const head = {
    version: "1",
    about:
      "Local competition (D98): places of each kind mapped on OpenStreetMap inside each city's own boundary, for each country's largest cities. A count is a floor, never a total: OpenStreetMap is volunteer-mapped and misses places, more in some cities than others.",
    sources: {
      cities:
        "Wikidata (CC0): population P1082 (largest truthy value), OpenStreetMap relation P402, labels.",
      counts:
        "© OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright), through the Overpass API.",
      retrieved,
    },
    groups: GROUPS,
    absent: "A city missing here never answered within the run's attempts; it is not offered.",
  };
  const headText = JSON.stringify(head, null, 2).replace(/\n}$/, "");
  const body = cities.map((c) => `    ${JSON.stringify(c)}`).join(",\n");
  writeFileSync(OUT, `${headText},\n  "cities": [\n${body}\n  ]\n}\n`);
}

async function main(): Promise<void> {
  const retrieved = new Date().toISOString().slice(0, 10);
  const before: City[] = existsSync(OUT)
    ? (JSON.parse(readFileSync(OUT, "utf8")) as { cities: City[] }).cities
    : [];
  const cities: City[] = [...before];
  for (const iso of COUNTRIES) {
    let list = cities.filter((c) => c.country === iso);
    if (list.length < PER_COUNTRY) {
      console.log(`wikidata ${iso}`);
      await sleep(1_500);
      for (const c of await citiesOf(iso)) {
        if (!cities.some((x) => x.wikidata === c.wikidata)) cities.push(c);
      }
      write(cities, retrieved);
      list = cities.filter((c) => c.country === iso);
    }
    for (const c of list) {
      if (c.counts) continue;
      console.log(`  overpass ${iso} ${c.names.en}`);
      await sleep(PAUSE_MS);
      try {
        c.counts = await count(c);
        c.counted_at = new Date().toISOString().slice(0, 10);
        console.log(`    ${JSON.stringify(c.counts)}`);
      } catch (e) {
        console.log(`    left out for now: ${(e as Error).message}`);
      }
      write(cities, retrieved);
    }
  }
  const done = cities.filter((c) => c.counts).length;
  console.log(`\n${done} of ${cities.length} cities counted, in ${requests} requests`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
