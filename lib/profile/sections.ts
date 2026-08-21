// The fourteen profile sections — data-model-v1.md §5.1.
//
// The split follows MAIN.txt deliberately: any question in the original
// document can be pointed at and found here. Sections are the first path
// segment of every field_key ("identity.legal_name", "revenue.monthly_
// revenue", "offers.<offer_id>.price"), so the section of a record is
// always derivable from — and must agree with — its key.

export const PROFILE_SECTIONS = [
  "identity", //  1 — who the business is
  "presence", //  2 — where it exists (site, store, socials)
  "offers", //  3 — what it sells
  "revenue", //  4 — what comes in
  "costs", //  5 — what goes out
  "customers", //  6 — who buys
  "channels", //  7 — where they come from
  "marketing", //  8 — how they hear about it
  "operations", //  9 — how the work gets done
  "tooling", // 10 — what software/infrastructure runs it
  "legal", // 11 — structure, compliance, contracts
  "competitors", // 12 — who else is selling
  "goals", // 13 — where the owner wants to go
  "assets", // 14 — uploads and artifacts
] as const;

export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

export function isProfileSection(value: string): value is ProfileSection {
  return (PROFILE_SECTIONS as readonly string[]).includes(value);
}

export class InvalidFieldKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFieldKeyError";
  }
}

// The question bank writes to six namespaces beyond the fourteen section
// prefixes; each belongs to exactly one section. Offer-branch detail
// namespaces live with offers; positioning and market intelligence live
// with competitors. Derived from the bank's own question sections and
// checked by the loader against every writes_to.
export const EXTRA_PREFIX_SECTIONS: Readonly<Record<string, ProfileSection>> = {
  suppliers: "offers",
  fulfilment: "offers",
  service: "offers",
  digital: "offers",
  positioning: "competitors",
  market: "competitors",
};

/**
 * A field_key's home section: its first path segment, either one of the
 * fourteen or a bank namespace that maps onto one. (A question's flow
 * section can differ — 1.1b asks the country mid-identity but the fact is
 * legal.country; the FIELD lives in legal.) Throws for keys outside the
 * map — a record filed nowhere is unreachable by resolver and scorer.
 */
export function sectionOfFieldKey(fieldKey: string): ProfileSection {
  const [head] = fieldKey.split(".");
  if (head !== undefined && head !== "" && isProfileSection(head)) {
    return head;
  }
  const mapped = head === undefined ? undefined : EXTRA_PREFIX_SECTIONS[head];
  if (mapped === undefined) {
    throw new InvalidFieldKeyError(
      `field_key "${fieldKey}" does not start with a profile section or a mapped bank namespace`,
    );
  }
  return mapped;
}
