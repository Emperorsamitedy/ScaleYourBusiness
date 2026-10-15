// Business timezone — P2-26 (Phase 2 Session F, trading hours).
//
// Hour-by-hour revenue needs the business's own clock: a bar's 21:00 is
// not UTC's. The profile holds the country (legal.country, free text).
// Where a country has exactly one timezone the zone follows from it with
// no judgement involved, and it is written as an inferred fact naming
// legal.country and the method (rule 6). Where it has several — the US,
// Canada, Australia, Brazil, Russia… — or the country can't be read, the
// zone is unknown and every hourly figure says so. Never guessed.
//
// An owner-stated presence.timezone always wins and is never touched.

import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { readCurrentField, writeField } from "../profile/field-store";

export const COUNTRY_KEY = "legal.country";
export const TIMEZONE_KEY = "presence.timezone";
export const TIMEZONE_METHOD = "single-zone-country-map-v1";

/**
 * Countries with one timezone: ISO alpha-2 → IANA zone, plus the names
 * owners actually type. Coverage follows the bank's market scope first
 * (Europe), then common single-zone markets. Extend freely; every entry
 * is checked against Intl by a test.
 */
const SINGLE_ZONE: Record<string, { zone: string; names: string[] }> = {
  HU: { zone: "Europe/Budapest", names: ["hungary", "magyarország", "magyarorszag"] },
  AT: { zone: "Europe/Vienna", names: ["austria", "österreich", "osterreich"] },
  DE: { zone: "Europe/Berlin", names: ["germany", "deutschland"] },
  CH: { zone: "Europe/Zurich", names: ["switzerland", "schweiz", "suisse", "svizzera"] },
  FR: { zone: "Europe/Paris", names: ["france"] },
  IT: { zone: "Europe/Rome", names: ["italy", "italia"] },
  NL: {
    zone: "Europe/Amsterdam",
    names: ["netherlands", "the netherlands", "holland", "nederland"],
  },
  BE: { zone: "Europe/Brussels", names: ["belgium", "belgië", "belgie", "belgique"] },
  LU: { zone: "Europe/Luxembourg", names: ["luxembourg"] },
  IE: { zone: "Europe/Dublin", names: ["ireland", "éire", "eire"] },
  GB: {
    zone: "Europe/London",
    names: [
      "united kingdom",
      "uk",
      "great britain",
      "britain",
      "england",
      "scotland",
      "wales",
      "northern ireland",
    ],
  },
  PL: { zone: "Europe/Warsaw", names: ["poland", "polska"] },
  CZ: { zone: "Europe/Prague", names: ["czechia", "czech republic", "česko", "cesko"] },
  SK: { zone: "Europe/Bratislava", names: ["slovakia", "slovensko"] },
  SI: { zone: "Europe/Ljubljana", names: ["slovenia", "slovenija"] },
  HR: { zone: "Europe/Zagreb", names: ["croatia", "hrvatska"] },
  RS: { zone: "Europe/Belgrade", names: ["serbia", "srbija"] },
  RO: { zone: "Europe/Bucharest", names: ["romania", "românia"] },
  BG: { zone: "Europe/Sofia", names: ["bulgaria", "българия"] },
  GR: { zone: "Europe/Athens", names: ["greece", "ελλάδα", "hellas"] },
  SE: { zone: "Europe/Stockholm", names: ["sweden", "sverige"] },
  NO: { zone: "Europe/Oslo", names: ["norway", "norge"] },
  DK: { zone: "Europe/Copenhagen", names: ["denmark", "danmark"] },
  FI: { zone: "Europe/Helsinki", names: ["finland", "suomi"] },
  EE: { zone: "Europe/Tallinn", names: ["estonia", "eesti"] },
  LV: { zone: "Europe/Riga", names: ["latvia", "latvija"] },
  LT: { zone: "Europe/Vilnius", names: ["lithuania", "lietuva"] },
  MT: { zone: "Europe/Malta", names: ["malta"] },
  CY: { zone: "Asia/Nicosia", names: ["cyprus"] },
  UA: { zone: "Europe/Kyiv", names: ["ukraine", "україна"] },
  IS: { zone: "Atlantic/Reykjavik", names: ["iceland", "ísland"] },
  IL: { zone: "Asia/Jerusalem", names: ["israel"] },
  AE: { zone: "Asia/Dubai", names: ["united arab emirates", "uae"] },
  IN: { zone: "Asia/Kolkata", names: ["india"] },
  SG: { zone: "Asia/Singapore", names: ["singapore"] },
  JP: { zone: "Asia/Tokyo", names: ["japan"] },
  KR: { zone: "Asia/Seoul", names: ["south korea", "korea"] },
  NZ: { zone: "Pacific/Auckland", names: ["new zealand"] },
  ZA: { zone: "Africa/Johannesburg", names: ["south africa"] },
  NG: { zone: "Africa/Lagos", names: ["nigeria"] },
  KE: { zone: "Africa/Nairobi", names: ["kenya"] },
  ET: { zone: "Africa/Addis_Ababa", names: ["ethiopia"] },
  EG: { zone: "Africa/Cairo", names: ["egypt"] },
};

/** Countries with several zones — named so the answer can say why it is unknown. */
const MULTI_ZONE: Record<string, string[]> = {
  US: ["united states", "united states of america", "usa", "us", "america"],
  CA: ["canada"],
  AU: ["australia"],
  BR: ["brazil", "brasil"],
  MX: ["mexico", "méxico"],
  RU: ["russia", "россия"],
  ID: ["indonesia"],
  KZ: ["kazakhstan"],
  ES: ["spain", "españa", "espana"], // Canary Islands
  PT: ["portugal"], // Azores
  AR: ["argentina"],
  CL: ["chile"],
  CN: ["china"],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export type ZoneLookup = { zone: string; country: string } | { zone: null; reason: string };

/** Pure: the zone for a country as the owner typed it, or why there is none. */
export function zoneForCountry(raw: string): ZoneLookup {
  const text = norm(raw);
  if (text === "") return { zone: null, reason: "no country given" };
  for (const [code, entry] of Object.entries(SINGLE_ZONE)) {
    if (text === code.toLowerCase() || entry.names.includes(text)) {
      return { zone: entry.zone, country: code };
    }
  }
  for (const [code, names] of Object.entries(MULTI_ZONE)) {
    if (text === code.toLowerCase() || names.includes(text)) {
      return { zone: null, reason: `${raw.trim()} has more than one timezone` };
    }
  }
  return { zone: null, reason: `"${raw.trim()}" isn't a country this map knows` };
}

/** Pure: the ISO alpha-2 code for a country as the owner typed it, or null. Shared with P4-16. */
export function countryCode(raw: string): string | null {
  const text = norm(raw);
  if (text === "") return null;
  for (const [code, entry] of Object.entries(SINGLE_ZONE)) {
    if (text === code.toLowerCase() || entry.names.includes(text)) return code;
  }
  for (const [code, names] of Object.entries(MULTI_ZONE)) {
    if (text === code.toLowerCase() || names.includes(text)) return code;
  }
  return null;
}

export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Every zone the map holds — for the test that checks them against Intl. */
export const KNOWN_ZONES = Object.values(SINGLE_ZONE).map((e) => e.zone);

/** The owner states the zone themselves — the way in for multi-zone countries. Always wins. */
export async function setTimezone(profileId: string, zone: string): Promise<void> {
  if (!isValidZone(zone)) throw new Error(`"${zone}" isn't a timezone`);
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<string>({
      id: fieldId(TIMEZONE_KEY),
      value: zone,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note: null,
    }),
  );
}

/**
 * The business's timezone: the owner's statement if there is one, else
 * derived from a single-zone country (written once, as an inferred fact),
 * else null with the reason.
 */
export async function ensureTimezone(
  profileId: string,
): Promise<{ zone: string; via: "owner" | "reused" | "derived" } | { zone: null; reason: string }> {
  const current = await readCurrentField<string>(profileId, TIMEZONE_KEY);
  if (current && typeof current.value === "string" && isValidZone(current.value)) {
    return { zone: current.value, via: current.status === "inferred" ? "reused" : "owner" };
  }
  const country = await readCurrentField<string>(profileId, COUNTRY_KEY);
  if (!country || country.status !== "answered" || typeof country.value !== "string") {
    return { zone: null, reason: "the country isn't known" };
  }
  const found = zoneForCountry(country.value);
  if (found.zone === null) return found;
  await writeField(
    profileId,
    createField<string>({
      id: fieldId(TIMEZONE_KEY),
      value: found.zone,
      status: "inferred",
      confidence: confidence(0.9),
      source: { kind: "inferred", derived_from: [fieldId(COUNTRY_KEY)], method: TIMEZONE_METHOD },
      observed_at: country.observed_at,
      recorded_at: isoDateTime(new Date().toISOString()),
      note: null,
    }),
  );
  return { zone: found.zone, via: "derived" };
}
