// Country → reporting currency.
//
// Question 1.1b asks which country the business operates in, as free
// text, and nothing in the bank ever asks for a currency. Before this
// existed, every account was created with HUF hardcoded and stayed
// there, so a US owner's whole report came back labelled in forint —
// found on a live run where "$18.00" printed as "18 HUF".
//
// Free text means fuzzy input: "USA", "united states", "U.S.", "us".
// This normalises aggressively and matches against name variants plus
// ISO-3166 alpha-2/alpha-3. An unrecognised answer resolves to null and
// the caller keeps whatever it had — a wrong guess here would silently
// relabel money, which is worse than leaving it alone.

/** Strip case, accents, punctuation and articles so "U.S.A." ≡ "usa". */
export function normaliseCountry(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/\b(the|republic|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Currency by normalised country name / ISO code. */
const BY_COUNTRY: Readonly<Record<string, string>> = {
  // eurozone
  austria: "EUR",
  at: "EUR",
  aut: "EUR",
  belgium: "EUR",
  be: "EUR",
  bel: "EUR",
  croatia: "EUR",
  hr: "EUR",
  hrv: "EUR",
  cyprus: "EUR",
  cy: "EUR",
  cyp: "EUR",
  estonia: "EUR",
  ee: "EUR",
  est: "EUR",
  finland: "EUR",
  fi: "EUR",
  fin: "EUR",
  france: "EUR",
  fr: "EUR",
  fra: "EUR",
  germany: "EUR",
  de: "EUR",
  deu: "EUR",
  deutschland: "EUR",
  greece: "EUR",
  gr: "EUR",
  grc: "EUR",
  ireland: "EUR",
  ie: "EUR",
  irl: "EUR",
  italy: "EUR",
  it: "EUR",
  ita: "EUR",
  italia: "EUR",
  latvia: "EUR",
  lv: "EUR",
  lva: "EUR",
  lithuania: "EUR",
  lt: "EUR",
  ltu: "EUR",
  luxembourg: "EUR",
  lu: "EUR",
  lux: "EUR",
  malta: "EUR",
  mt: "EUR",
  mlt: "EUR",
  netherlands: "EUR",
  nl: "EUR",
  nld: "EUR",
  holland: "EUR",
  portugal: "EUR",
  pt: "EUR",
  prt: "EUR",
  slovakia: "EUR",
  sk: "EUR",
  svk: "EUR",
  slovenia: "EUR",
  si: "EUR",
  svn: "EUR",
  spain: "EUR",
  es: "EUR",
  esp: "EUR",
  espana: "EUR",

  // the rest of Europe
  hungary: "HUF",
  hu: "HUF",
  hun: "HUF",
  magyarorszag: "HUF",
  poland: "PLN",
  pl: "PLN",
  pol: "PLN",
  polska: "PLN",
  czechia: "CZK",
  cz: "CZK",
  cze: "CZK",
  czech: "CZK",
  romania: "RON",
  ro: "RON",
  rou: "RON",
  bulgaria: "BGN",
  bg: "BGN",
  bgr: "BGN",
  denmark: "DKK",
  dk: "DKK",
  dnk: "DKK",
  sweden: "SEK",
  se: "SEK",
  swe: "SEK",
  norway: "NOK",
  no: "NOK",
  nor: "NOK",
  iceland: "ISK",
  is: "ISK",
  isl: "ISK",
  switzerland: "CHF",
  ch: "CHF",
  che: "CHF",
  serbia: "RSD",
  rs: "RSD",
  srb: "RSD",
  ukraine: "UAH",
  ua: "UAH",
  ukr: "UAH",
  turkey: "TRY",
  tr: "TRY",
  tur: "TRY",
  turkiye: "TRY",

  // United Kingdom — many spellings, all one currency. NOTE: the key is
  // the FULL "united kingdom": normalising away "kingdom"/"states" would
  // collapse it and "united states" onto the same key and silently pay a
  // US business in pounds.
  "united kingdom": "GBP",
  uk: "GBP",
  gb: "GBP",
  gbr: "GBP",
  britain: "GBP",
  "great britain": "GBP",
  england: "GBP",
  scotland: "GBP",
  wales: "GBP",
  "northern ireland": "GBP",

  // Americas
  usa: "USD",
  us: "USD",
  america: "USD",
  "united states": "USD",
  "united states america": "USD",
  "u s a": "USD",
  canada: "CAD",
  ca: "CAD",
  can: "CAD",
  mexico: "MXN",
  mx: "MXN",
  mex: "MXN",
  brazil: "BRL",
  br: "BRL",
  bra: "BRL",
  brasil: "BRL",
  argentina: "ARS",
  ar: "ARS",
  arg: "ARS",
  chile: "CLP",
  cl: "CLP",
  chl: "CLP",
  colombia: "COP",
  co: "COP",
  col: "COP",

  // Asia-Pacific, Middle East, Africa
  australia: "AUD",
  au: "AUD",
  aus: "AUD",
  "new zealand": "NZD",
  nz: "NZD",
  nzl: "NZD",
  japan: "JPY",
  jp: "JPY",
  jpn: "JPY",
  china: "CNY",
  cn: "CNY",
  chn: "CNY",
  "hong kong": "HKD",
  hk: "HKD",
  hkg: "HKD",
  singapore: "SGD",
  sg: "SGD",
  sgp: "SGD",
  india: "INR",
  in: "INR",
  ind: "INR",
  indonesia: "IDR",
  id: "IDR",
  idn: "IDR",
  malaysia: "MYR",
  my: "MYR",
  mys: "MYR",
  philippines: "PHP",
  ph: "PHP",
  phl: "PHP",
  thailand: "THB",
  th: "THB",
  tha: "THB",
  vietnam: "VND",
  vn: "VND",
  vnm: "VND",
  "south korea": "KRW",
  korea: "KRW",
  kr: "KRW",
  kor: "KRW",
  israel: "ILS",
  il: "ILS",
  isr: "ILS",
  "united arab emirates": "AED",
  uae: "AED",
  ae: "AED",
  are: "AED",
  "saudi arabia": "SAR",
  sa: "SAR",
  sau: "SAR",
  "south africa": "ZAR",
  za: "ZAR",
  zaf: "ZAR",
  nigeria: "NGN",
  ng: "NGN",
  nga: "NGN",
  kenya: "KES",
  ke: "KES",
  ken: "KES",
  egypt: "EGP",
  eg: "EGP",
  egy: "EGP",
};

/**
 * Best-effort currency for a free-text country. Returns null when the
 * answer is not recognised — the caller must then leave the account's
 * currency alone rather than guess.
 */
export function currencyForCountry(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = normaliseCountry(raw);
  if (n === "") return null;
  if (BY_COUNTRY[n]) return BY_COUNTRY[n] ?? null;
  // "united states of america" normalises to "united america"; also
  // catches "i trade in germany" and similar prose answers.
  for (const [key, cur] of Object.entries(BY_COUNTRY)) {
    if (key.length < 4) continue; // never substring-match "us", "in", "at"
    if (n === key || n.includes(key)) return cur;
  }
  return null;
}
