// The business segment — the multi-market spec Part C, with the owner's
// answer of 2026-11-10 ("by form, then staff").
//
//   micro_sole  any sole-trader form (egyéni vállalkozó, Einzelunternehmen,
//               auto-entrepreneur…) or an unregistered business, whatever
//               its size → free entry and Watch only; ladder capped at 2
//   small_corp  a company form under 10 people → the primary target
//   mid_corp    a company form, 10–49 people → full product, partner-led
//   large       50 or more → out of scope for v1, routed to the waitlist
//
// Headcount is identity.team_size (it counts the owner); when it isn't
// known, the owner's own size band stands in. Revenue doesn't decide it
// (D41): a revenue band would need thresholds per currency, and comparing
// across currencies is forbidden. A business whose legal form or size
// isn't known yet has no segment — it isn't guessed into one.
//
// Derived from the current facts every time it is read, so it can't go
// stale when the owner corrects a fact; pure here, read in ./read.ts.

export const SEGMENTS = ["micro_sole", "small_corp", "mid_corp", "large"] as const;
export type Segment = (typeof SEGMENTS)[number];

/** legal_entity_type codes that make a business a sole operation. */
export const SOLE_FORMS: ReadonlySet<string> = new Set(["sole_trader", "not_registered"]);

/** Company forms, segmented by headcount. */
export const COMPANY_FORMS: ReadonlySet<string> = new Set([
  "single_member_llc",
  "llc_ltd",
  "partnership",
  "corporation",
  "nonprofit",
  "other",
]);

export interface SegmentFacts {
  /** legal.entity_type's code, or null when unknown. */
  legal_form: string | null;
  /** identity.team_size: people including the owner, or null. */
  team_size: number | null;
  /** identity.size_band: solo | small | medium | large, or null. */
  size_band: string | null;
}

export interface SegmentResult {
  segment: Segment | null;
  /** In plain words: what decided it, or what is missing. */
  basis: string;
}

/** Pure: the segment these facts make, or null with the reason. */
export function deriveSegment(f: SegmentFacts): SegmentResult {
  if (f.legal_form !== null && SOLE_FORMS.has(f.legal_form)) {
    return { segment: "micro_sole", basis: "a sole-trader form, whatever its size" };
  }
  if (f.legal_form === null || !COMPANY_FORMS.has(f.legal_form)) {
    return { segment: null, basis: "the legal form isn't known yet" };
  }
  if (f.team_size !== null && Number.isFinite(f.team_size) && f.team_size > 0) {
    const n = f.team_size;
    const segment: Segment = n < 10 ? "small_corp" : n < 50 ? "mid_corp" : "large";
    return { segment, basis: `a company with ${n} ${n === 1 ? "person" : "people"}` };
  }
  switch (f.size_band) {
    case "solo":
    case "small":
      return { segment: "small_corp", basis: "a company the owner calls small" };
    case "medium":
      return { segment: "mid_corp", basis: "a company the owner calls medium-sized" };
    case "large":
      return { segment: "large", basis: "a company the owner calls large" };
    default:
      return { segment: null, basis: "the business's size isn't known yet" };
  }
}

/** The ladder's ceiling by segment: a micro_sole never passes station 2, through any path. */
export function segmentStationCeiling(segment: Segment | null): 1 | 2 | 3 | 4 {
  return segment === "micro_sole" ? 2 : 4;
}

/** The tiers a segment may subscribe to (§C): a micro_sole gets Watch only. */
export function tierAllowed(segment: Segment | null, tier: string): boolean {
  if (segment === "micro_sole") return tier === "watch" || tier === "full_diagnosis";
  if (segment === "large") return false;
  return true;
}

export type Route =
  "watch_or_waitlist" | "full_diagnosis" | "full_diagnosis_partner_led" | "waitlist" | "ask_more";

/**
 * §C: qualification at the END of the free result — never at the gate. The
 * free one-number entry serves every segment; this only says where its
 * result page sends the owner next.
 */
export function routeAfterFreeResult(segment: Segment | null): Route {
  switch (segment) {
    case "micro_sole":
      return "watch_or_waitlist";
    case "small_corp":
      return "full_diagnosis";
    case "mid_corp":
      return "full_diagnosis_partner_led";
    case "large":
      return "waitlist";
    case null:
      return "ask_more";
  }
}
