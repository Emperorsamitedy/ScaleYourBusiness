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
import { MULTI_ZONE, SINGLE_ZONE, countryCode, normCountry as norm } from "../core/country";

// The country maps and countryCode live in lib/core/country (pure, importable
// by the phone line's fenced tier); re-exported so callers are unchanged.
export { countryCode };

export const COUNTRY_KEY = "legal.country";
export const TIMEZONE_KEY = "presence.timezone";
export const TIMEZONE_METHOD = "single-zone-country-map-v1";

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
