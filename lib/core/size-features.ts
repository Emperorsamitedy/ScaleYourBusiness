// What each business size sees, as data — PROVISIONAL PENDING THE
// CO-FOUNDER'S REVIEW (feature by feature, October 2026).
//
// The co-founder's finding from customer interviews: some functions are
// noise for a small business, because the owner knows the answer from
// the top of their head, and useful for a bigger one. The owner states
// the size in their own words (question 1.6a, identity.size_band); until
// they do, a band is inferred from the headcount (lib/profile/size-band.ts).
//
// The rules this table runs under:
//   · One row per feature key, naming the bands it shows for and why.
//     Visibility is read from here, never written as an `if` on a band
//     in a screen (rule 4's spirit: the decision is data).
//   · An unknown band shows everything. Nothing is hidden on a guess: a
//     band counts only when the owner stated it or it was inferred from a
//     headcount they gave; with neither, every feature shows.
//   · Hiding is presentation only. A hidden screen is still reachable by
//     its address, and nothing underneath it changes.
//   · Conservative until reviewed. Today no row hides anything: I found no
//     screen whose irrelevance to a one-person business is obvious, so
//     every row lists every band and says why it matters at the smallest
//     size. The review moves rows; the mechanism is already wired.
//
// Not tuned by size, on purpose: the stated-vs-measured comparison. Its
// fix is materiality (lib/connectors/materiality.ts), applied the same
// at every size. The relative test already scales with the business, and
// a stricter bar for a solo owner would hide the one surprise they would
// most want to see.

export const SIZE_BANDS = ["solo", "small", "medium", "large"] as const;
export type SizeBand = (typeof SIZE_BANDS)[number];

export function isSizeBand(v: unknown): v is SizeBand {
  return typeof v === "string" && (SIZE_BANDS as readonly string[]).includes(v);
}

export interface SizeFeatureRow {
  /** The bands this feature shows for. An unknown band always shows it. */
  bands: readonly SizeBand[];
  /** One line: why it shows (or doesn't) at these sizes. */
  reason: string;
}

const EVERY: readonly SizeBand[] = SIZE_BANDS;

/** feature key → the bands it shows for, with the reason. Keys are used by the menu (components/nav/AppFrame.tsx). */
export const SIZE_FEATURES = {
  "nav.proposals": {
    bands: EVERY,
    reason: "Nothing I do runs without your approval, whatever the size of the business.",
  },
  "nav.report": {
    bands: EVERY,
    reason: "The diagnosis is the product; a sole trader needs it as much as anyone.",
  },
  "nav.watch": {
    bands: EVERY,
    reason: "The watch is how I learn the business before acting, at every size.",
  },
  "nav.goals": {
    bands: EVERY,
    reason: "Targets are the owner's own, and a one-person business has them too.",
  },
  "nav.hours": {
    bands: EVERY,
    reason: "Whether an hour pays for itself depends on the till, not the headcount.",
  },
  "nav.team": {
    bands: EVERY,
    reason:
      "Off by default and switched on by the owner; once on, a small team feels a short-staffed Saturday as much as a big one.",
  },
  "nav.patterns": {
    bands: EVERY,
    reason:
      "A one-person business feels its busy season hardest, and knowing what sells together is free money at any size.",
  },
  "nav.cash": {
    bands: EVERY,
    reason:
      "A one-person business has the thinnest cushion, so seeing the tight week coming matters most there.",
  },
  "nav.payments": {
    bands: EVERY,
    reason:
      "A one-person business pays its suppliers by hand too; a checked IBAN and a ready bank file save the same mistakes at any size.",
  },
  "nav.stock": {
    bands: EVERY,
    reason:
      "Cash sitting on a shelf hurts a one-person shop most; only businesses that hold stock see it.",
  },
  "nav.blindspots": {
    bands: EVERY,
    reason: "A blindspot is by definition what the owner doesn't know offhand.",
  },
  "nav.competitors": {
    bands: EVERY,
    reason:
      "A one-person salon loses customers to the one down the road too; their prices are worth seeing.",
  },
  "nav.benchmarks": {
    bands: EVERY,
    reason:
      "A one-person business has nobody to compare notes with; a named group of businesses like it is a reference at any size.",
  },
  "nav.content": {
    bands: EVERY,
    reason: "A solo owner has the least time to write posts, so drafts help most there.",
  },
  "nav.studio": {
    bands: EVERY,
    reason:
      "A one-person business can least afford an agency, so seeing what its niche keeps running, and a brief to film from, helps most there.",
  },
  "nav.site": {
    bands: EVERY,
    reason: "Every business with a website can lose customers on it.",
  },
  "nav.simulate": {
    bands: EVERY,
    reason:
      "Before any spend, the likely range from your own numbers; a solo owner can least afford a campaign that misses.",
  },
  "nav.customers": {
    bands: EVERY,
    reason: "Lapsed customers are lost revenue whoever serves them.",
  },
  "nav.reviews": {
    bands: EVERY,
    reason: "One poor review costs a one-chair salon as much as a chain, often more.",
  },
  "nav.carts": {
    bands: EVERY,
    reason:
      "A one-person shop feels every cart left at the till; only businesses whose shop connection reads carts see it.",
  },
  "nav.pipeline": {
    bands: EVERY,
    reason:
      "A one-person studio selling to cafés loses a deal to silence as easily as a sales team does; only businesses that sell to businesses see it.",
  },
  "nav.support": {
    bands: EVERY,
    reason: "A solo owner answers every message personally; drafted replies save them the most.",
  },
  "nav.factsheet": {
    bands: EVERY,
    reason: "The record of what you told me is yours to check, at any size.",
  },
  "nav.connections": {
    bands: EVERY,
    reason: "Measured numbers beat estimates for everyone; materiality keeps the comparison quiet.",
  },
  "nav.mode": {
    bands: EVERY,
    reason: "How I work for you is decided per business and always explained.",
  },
  "nav.history": {
    bands: EVERY,
    reason: "The decision log is the audit trail; it is never hidden.",
  },
  "nav.team_access": {
    bands: EVERY,
    reason: "Who can sign in to the business is the owner's to see, at any size.",
  },
  "nav.language": {
    bands: EVERY,
    reason: "The language you read and the currency every figure is in matter at any size.",
  },
} as const satisfies Record<string, SizeFeatureRow>;

export type SizeFeatureKey = keyof typeof SIZE_FEATURES;
export type SizeFeatureTable = Readonly<Record<string, SizeFeatureRow>>;

export function isSizeFeatureKey(v: string): v is SizeFeatureKey {
  return Object.hasOwn(SIZE_FEATURES, v);
}

/**
 * Whether a feature shows for a band. Null (no stated band and no
 * headcount to infer one from) shows everything, and so does a key the
 * table has no row for: the table can only ever hide, never guess.
 */
export function showsFor(
  feature: string,
  band: SizeBand | null,
  table: SizeFeatureTable = SIZE_FEATURES,
): boolean {
  if (band === null) return true;
  const row = Object.hasOwn(table, feature) ? table[feature] : undefined;
  return row === undefined ? true : row.bands.includes(band);
}

/** Every feature key a band sees, sorted — the same set on every call. */
export function featuresFor(
  band: SizeBand | null,
  table: SizeFeatureTable = SIZE_FEATURES,
): string[] {
  return Object.keys(table)
    .filter((k) => showsFor(k, band, table))
    .sort();
}
