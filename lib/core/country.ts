// Countries as owners type them (legal.country is free text) — pure, no
// imports, so any tier may read it: the phone line's import fence
// (lib/support/structure.test.ts) forbids lib/profile, which the timezone
// module that first held these maps needs. lib/hours/timezone re-exports
// countryCode, so its callers are unchanged.

/**
 * Countries with one timezone: ISO alpha-2 → IANA zone, plus the names
 * owners actually type. Coverage follows the bank's market scope first
 * (Europe), then common single-zone markets. Extend freely; every entry
 * is checked against Intl by a test.
 */
export const SINGLE_ZONE: Record<string, { zone: string; names: string[] }> = {
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
export const MULTI_ZONE: Record<string, string[]> = {
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

export const normCountry = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Pure: the ISO alpha-2 code for a country as the owner typed it, or null. */
export function countryCode(raw: string): string | null {
  const text = normCountry(raw);
  if (text === "") return null;
  for (const [code, entry] of Object.entries(SINGLE_ZONE)) {
    if (text === code.toLowerCase() || entry.names.includes(text)) return code;
  }
  for (const [code, names] of Object.entries(MULTI_ZONE)) {
    if (text === code.toLowerCase() || names.includes(text)) return code;
  }
  return null;
}
