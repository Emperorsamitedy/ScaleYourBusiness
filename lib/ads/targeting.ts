// Who an ad is shown to, and what kind of ad it is — P3-54 (Session K). Pure:
// no database, no network. The proposal builder (lib/ads/adcreate.ts) shapes
// an ad from these tables, and the executor (lib/execution/providers/meta.ts)
// checks the same tables again before anything is sent, so the two can never
// disagree about what an ad may target.
//
// The choices, each conservative on purpose and recorded in TASKS-PHASE3:
//
//   location   the owner's country, or a radius only when real coordinates
//              are given (a brief's "Budapest" is not a place on a map yet)
//   age        18–65+ unless the owner says narrower; never under 18
//   interests  left broad: the owner's words are shown, never sent — Meta
//              finds the people, and nothing narrows an audience on a guess
//   placements Facebook feed and Instagram feed (and Reels for a video),
//              named, rather than Meta's automatic placements
//   automation Advantage+ audience OFF, so the age band and place SYB shows
//              the owner are the ones Meta uses
//
// SPECIAL AD CATEGORIES — no bypass. Housing, employment and credit ads are
// legal to run, with Meta's restricted targeting: no age band, no narrow
// radius, nothing detailed. SYB sets the category and that targeting. Social
// issues, elections and politics need Meta's own authorisation and a "paid
// for by" disclaimer, and gambling needs Meta's written permission: SYB
// refuses those outright rather than half-run them. Which business falls in
// which category is data (rule 4), read from the profile and the item.

export const SPECIAL_AD_CATEGORIES = [
  "HOUSING",
  "EMPLOYMENT",
  "FINANCIAL_PRODUCTS_SERVICES",
  "ISSUES_ELECTIONS_POLITICS",
  "ONLINE_GAMBLING_AND_GAMING",
] as const;
export type SpecialAdCategory = (typeof SPECIAL_AD_CATEGORIES)[number];

/** What SYB does with each category: set it with Meta's restricted targeting, or refuse the ad. */
export const SPECIAL_CATEGORY_HANDLING: Readonly<Record<SpecialAdCategory, "restrict" | "refuse">> =
  {
    HOUSING: "restrict",
    EMPLOYMENT: "restrict",
    FINANCIAL_PRODUCTS_SERVICES: "restrict",
    ISSUES_ELECTIONS_POLITICS: "refuse",
    ONLINE_GAMBLING_AND_GAMING: "refuse",
  };

export const SPECIAL_CATEGORY_WORD: Readonly<Record<SpecialAdCategory, string>> = {
  HOUSING: "housing",
  EMPLOYMENT: "employment",
  FINANCIAL_PRODUCTS_SERVICES: "credit and financial products",
  ISSUES_ELECTIONS_POLITICS: "social issues, elections or politics",
  ONLINE_GAMBLING_AND_GAMING: "gambling",
};

/** business_type vocabulary value → the category every ad of that business falls in. */
export const BUSINESS_TYPE_CATEGORY: Readonly<Partial<Record<string, SpecialAdCategory>>> = {
  real_estate: "HOUSING",
};

/**
 * Words that put an ad in a category, read in the owner's answer to 11.3
 * (advertising restrictions) and in the item's own caption. Broad on purpose:
 * a false match restricts the targeting or refuses the ad, both safe; a
 * missed one would run a regulated ad with targeting Meta forbids.
 */
export const CATEGORY_WORDS: readonly { category: SpecialAdCategory; pattern: RegExp }[] = [
  {
    category: "HOUSING",
    pattern:
      /\b(housing|real estate|estate agen\w*|letting agen\w*|lettings|flat to rent|for rent)\b/i,
  },
  {
    category: "EMPLOYMENT",
    pattern:
      /\b(we'?re hiring|now hiring|hiring|job openings?|vacanc(y|ies)|recruit\w*|apply now to join)\b/i,
  },
  {
    category: "FINANCIAL_PRODUCTS_SERVICES",
    pattern:
      /\b(credit|loans?|lending|mortgages?|financing|finance options?|insurance|pay later|instal?lments?)\b/i,
  },
  {
    category: "ISSUES_ELECTIONS_POLITICS",
    pattern: /\b(politic\w*|elections?|ballot|referendum|vote for|candidate)\b/i,
  },
  {
    category: "ONLINE_GAMBLING_AND_GAMING",
    pattern: /\b(gambl\w*|betting|casino|lottery|poker|sportsbook)\b/i,
  },
];

export interface CategoryVerdict {
  /** The categories the ad is created with — [] for an ordinary ad. */
  categories: SpecialAdCategory[];
  /** Why each was set, in words. */
  why: string[];
  /** Set when a category means SYB won't run the ad at all. */
  refused: string | null;
}

/** Pure: which special ad categories an ad falls in, from the profile and the item. */
export function specialCategories(args: {
  business_type: string | null;
  restrictions_text: string | null;
  item_text: string;
}): CategoryVerdict {
  const found = new Map<SpecialAdCategory, string>();
  const byType = args.business_type ? BUSINESS_TYPE_CATEGORY[args.business_type] : undefined;
  if (byType) found.set(byType, `your business is ${args.business_type!.replace(/_/g, " ")}`);
  for (const { category, pattern } of CATEGORY_WORDS) {
    if (found.has(category)) continue;
    const m =
      (args.restrictions_text ? pattern.exec(args.restrictions_text) : null) ??
      pattern.exec(args.item_text);
    if (m) found.set(category, `the words "${m[0]}"`);
  }
  const categories = SPECIAL_AD_CATEGORIES.filter((c) => found.has(c));
  const refusedBy = categories.find((c) => SPECIAL_CATEGORY_HANDLING[c] === "refuse");
  return {
    categories,
    why: categories.map(
      (c) => `${SPECIAL_CATEGORY_WORD[c]} (special ad category): ${found.get(c)}`,
    ),
    refused: refusedBy
      ? `This looks like an ad about ${SPECIAL_CATEGORY_WORD[refusedBy]} (${found.get(refusedBy)}). Meta needs its own authorisation for those, so SYB won't run it — you can set it up yourself in Ads Manager.`
      : null,
  };
}

/** Meta's age band: 18 at the youngest SYB targets, 65 meaning "65 and over". */
export const AD_AGE = { min: 18, max: 65 } as const;
/** A radius under a special category: Meta's 15-mile minimum (24.1 km), rounded up. */
export const SPECIAL_MIN_RADIUS_KM = 25;
/** Any radius: at least this, at most that. */
export const RADIUS_KM = { min: 1, max: 80 } as const;

/** The audience the owner (or a creative brief) asked for. Every part optional. */
export interface AdAudienceInput {
  location?: {
    /** As the owner typed it ("Hungary", "HU"). */
    country?: string;
    latitude?: number;
    longitude?: number;
    radius_km?: number;
    /** A place name — shown, not targeted, unless coordinates come with it. */
    label?: string;
  };
  age_min?: number;
  age_max?: number;
  /** Interests in words. Shown on the proposal, never sent: interests are left broad. */
  interests?: string;
}

export interface AdTargeting {
  geo_locations:
    | { countries: string[] }
    | {
        custom_locations: {
          latitude: number;
          longitude: number;
          radius: number;
          distance_unit: "kilometer";
        }[];
      };
  age_min: number;
  age_max: number;
  publisher_platforms: string[];
  facebook_positions: string[];
  instagram_positions?: string[];
  targeting_automation: { advantage_audience: 0 };
}

export interface TargetingResult {
  targeting: AdTargeting;
  /** The audience in the owner's words, for the proposal card. */
  words: { location: string; age: string; interests: string; placements: string };
  /** What was changed from what was asked, and why. */
  notes: string[];
}

/** "HU" → "Hungary", for the owner's card; the code itself when the runtime can't name it. */
function regionName(code: string): string {
  try {
    return new Intl.DisplayNames(["en-GB"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Pure: the targeting an ad is created with, or why there is none. */
export function buildTargeting(args: {
  audience: AdAudienceInput | null;
  /** ISO alpha-2 from the profile's country, when known. */
  profile_country: string | null;
  categories: readonly SpecialAdCategory[];
  instagram: boolean;
  video: boolean;
  /** A country as the owner typed it → ISO alpha-2 (lib/hours/timezone's countryCode), or null. */
  countryCode: (raw: string) => string | null;
}): TargetingResult | { refused: string } {
  const notes: string[] = [];
  const special = args.categories.length > 0;
  const a = args.audience ?? {};
  const loc = a.location ?? {};

  let geo: AdTargeting["geo_locations"];
  let where: string;
  const asked = loc.country ? args.countryCode(loc.country) : null;
  if (finite(loc.latitude) && finite(loc.longitude) && finite(loc.radius_km)) {
    if (Math.abs(loc.latitude) > 90 || Math.abs(loc.longitude) > 180) {
      return { refused: "the location's coordinates aren't on the map" };
    }
    const floor = special ? SPECIAL_MIN_RADIUS_KM : RADIUS_KM.min;
    const radius = Math.min(RADIUS_KM.max, Math.max(floor, Math.round(loc.radius_km)));
    if (radius !== Math.round(loc.radius_km)) {
      notes.push(
        special && loc.radius_km < SPECIAL_MIN_RADIUS_KM
          ? `the radius is ${radius} km — Meta's minimum for this kind of ad`
          : `the radius is held to ${radius} km`,
      );
    }
    geo = {
      custom_locations: [
        {
          latitude: loc.latitude,
          longitude: loc.longitude,
          radius,
          distance_unit: "kilometer",
        },
      ],
    };
    where = `${radius} km around ${loc.label?.trim() || "the place you gave"}`;
  } else {
    const country = asked ?? args.profile_country;
    if (!country) {
      return {
        refused:
          "I don't know which country to show it in — tell me the country the business operates in (question 1.1b)",
      };
    }
    if (loc.label && loc.label.trim() !== "") {
      notes.push(
        `"${loc.label.trim()}" isn't a place I can put on Meta's map yet, so it shows across ${regionName(country)}`,
      );
    }
    geo = { countries: [country] };
    where = `everyone in ${regionName(country)}`;
  }

  let ageMin = finite(a.age_min) ? Math.round(a.age_min) : AD_AGE.min;
  let ageMax = finite(a.age_max) ? Math.round(a.age_max) : AD_AGE.max;
  if (ageMin < AD_AGE.min) {
    notes.push(`the youngest age is ${AD_AGE.min}`);
    ageMin = AD_AGE.min;
  }
  if (ageMax > AD_AGE.max) ageMax = AD_AGE.max;
  if (ageMax < ageMin) return { refused: "the age band's oldest age is under its youngest" };
  if (special && (ageMin !== AD_AGE.min || ageMax !== AD_AGE.max)) {
    notes.push("Meta doesn't allow an age band on this kind of ad, so it shows to 18–65+");
    ageMin = AD_AGE.min;
    ageMax = AD_AGE.max;
  }

  const fb = args.video ? ["feed", "facebook_reels"] : ["feed"];
  const ig = args.video ? ["stream", "reels"] : ["stream"];
  const targeting: AdTargeting = {
    geo_locations: geo,
    age_min: ageMin,
    age_max: ageMax,
    publisher_platforms: args.instagram ? ["facebook", "instagram"] : ["facebook"],
    facebook_positions: fb,
    ...(args.instagram ? { instagram_positions: ig } : {}),
    targeting_automation: { advantage_audience: 0 },
  };
  const interests = a.interests?.trim();
  return {
    targeting,
    words: {
      location: where,
      age: `${ageMin}–${ageMax === AD_AGE.max ? "65+" : ageMax}`,
      interests: interests
        ? `left broad — "${interests}" is not sent; Meta finds the people`
        : "left broad — Meta finds the people",
      placements: [
        `Facebook ${args.video ? "feed and Reels" : "feed"}`,
        ...(args.instagram ? [`Instagram ${args.video ? "feed and Reels" : "feed"}`] : []),
      ].join(", "),
    },
    notes,
  };
}

/**
 * Pure, checked again by the executor before anything is sent: an ad set's
 * targeting must keep Meta's restrictions for its special categories, and
 * every ad set must keep SYB's own (no interest, behaviour or demographic
 * targeting at all — interests are left broad). Null = it may go.
 */
export function targetingViolation(
  categories: readonly string[],
  targeting: unknown,
): string | null {
  if (targeting === null || typeof targeting !== "object" || Array.isArray(targeting)) {
    return "the ad set has no targeting";
  }
  const t = targeting as Record<string, unknown>;
  const allowed = new Set([
    "geo_locations",
    "age_min",
    "age_max",
    "publisher_platforms",
    "facebook_positions",
    "instagram_positions",
    "targeting_automation",
  ]);
  for (const key of Object.keys(t)) {
    if (!allowed.has(key)) return `the targeting may not carry "${key}" — interests are left broad`;
  }
  const geo = t["geo_locations"] as Record<string, unknown> | undefined;
  if (!geo || typeof geo !== "object") return "the targeting names no place";
  const geoKeys = Object.keys(geo);
  if (geoKeys.length !== 1 || !["countries", "custom_locations"].includes(geoKeys[0]!)) {
    return "the targeting's place is a country or one radius, nothing else";
  }
  const ageMin = t["age_min"];
  const ageMax = t["age_max"];
  if (!finite(ageMin) || !finite(ageMax) || ageMin < AD_AGE.min || ageMax > AD_AGE.max) {
    return `the age band is ${AD_AGE.min}–65+ at its widest`;
  }
  for (const c of categories) {
    if (!(SPECIAL_AD_CATEGORIES as readonly string[]).includes(c)) {
      return `"${c}" isn't one of Meta's special ad categories`;
    }
    if (SPECIAL_CATEGORY_HANDLING[c as SpecialAdCategory] === "refuse") {
      return `SYB doesn't run ${SPECIAL_CATEGORY_WORD[c as SpecialAdCategory]} ads`;
    }
  }
  if (categories.length > 0) {
    if (ageMin !== AD_AGE.min || ageMax !== AD_AGE.max) {
      return "a special-category ad can't have an age band";
    }
    const locs = (geo as { custom_locations?: { radius?: unknown }[] }).custom_locations;
    if (
      Array.isArray(locs) &&
      locs.some((l) => !finite(l.radius) || l.radius < SPECIAL_MIN_RADIUS_KM)
    ) {
      return `a special-category ad's radius is at least ${SPECIAL_MIN_RADIUS_KM} km`;
    }
  }
  const automation = t["targeting_automation"] as { advantage_audience?: unknown } | undefined;
  if (!automation || automation.advantage_audience !== 0) {
    return "Advantage+ audience stays off, so the audience shown is the audience used";
  }
  return null;
}

/** The two kinds of ad SYB makes, as data: what each optimises for and where it sends people. */
export const AD_GOALS = {
  traffic: {
    objective: "OUTCOME_TRAFFIC",
    optimization_goal: "LINK_CLICKS",
    destination_type: "WEBSITE",
    call_to_action: "LEARN_MORE",
    words: "visits to your website",
  },
  awareness: {
    objective: "OUTCOME_AWARENESS",
    optimization_goal: "REACH",
    destination_type: null,
    call_to_action: null,
    words: "as many local people as possible seeing it",
  },
} as const;
export type AdGoal = keyof typeof AD_GOALS;

/** The optimisation goals an ad set may be sent with, per campaign objective. */
export const OPTIMIZATION_FOR_OBJECTIVE: Readonly<Record<string, string>> = {
  OUTCOME_TRAFFIC: "LINK_CLICKS",
  OUTCOME_AWARENESS: "REACH",
};

/**
 * EU and EEA countries (ISO alpha-2): an ad shown there must name who it is
 * for and who pays for it (the Digital Services Act; Meta's dsa_beneficiary
 * and dsa_payor) — _verify at build_ that Meta still refuses an EU ad set
 * without them.
 */
export const DSA_COUNTRIES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
]);
