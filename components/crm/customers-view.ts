// Pure read-model for the customers screen (the owner's instrument
// design, 2026-10-17): the headline, the lifecycle words and filters,
// the search, and the on-screen email mask. Everything is counted from
// the contacts the API returns; nothing is estimated.

export type Lifecycle = "new" | "active" | "lapsing" | "lapsed" | "unknown";

export interface ContactLite {
  name: string | null;
  email: string | null;
  lifecycle: Lifecycle;
}

/** The owner's word for each lifecycle state, and the tone that tints it. */
export const LIFECYCLE_WORD: Record<Lifecycle, { word: string; tone: "ok" | "drift" | "low" }> = {
  active: { word: "active", tone: "ok" },
  new: { word: "new", tone: "low" },
  lapsing: { word: "lapsing", tone: "drift" },
  lapsed: { word: "gone quiet", tone: "drift" },
  unknown: { word: "no history", tone: "low" },
};

/** Filter order on screen. */
export const LIFECYCLE_ORDER: readonly Lifecycle[] = [
  "active",
  "new",
  "lapsing",
  "lapsed",
  "unknown",
];

function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function customersHeadline(total: number, lapsed: number): string {
  if (total === 0) return "No customers imported yet.";
  const first = `${group(total)} ${total === 1 ? "customer" : "customers"}.`;
  if (lapsed === 0) return `${first} None have gone quiet.`;
  if (lapsed === total && total > 1) return `${first} All of them have gone quiet.`;
  return `${first} ${group(lapsed)} ${lapsed === 1 ? "has" : "have"} gone quiet.`;
}

/**
 * The address as the screen shows it: "le•••@gmail.com". The full
 * address stays in the record — the mask only keeps it off a screen
 * someone else might be looking at.
 */
export function maskEmail(email: string | null): string {
  if (!email) return "no email";
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const keep = local.length <= 2 ? 1 : 2;
  return `${local.slice(0, keep)}•••${email.slice(at)}`;
}

/** Name or email contains the query, case-insensitively; an empty query keeps all. */
export function matchesQuery(c: ContactLite, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (c.name ?? "").toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q);
}

export function filterContacts<T extends ContactLite>(
  contacts: readonly T[],
  lifecycle: Lifecycle | "all",
  query: string,
): T[] {
  return contacts.filter(
    (c) => (lifecycle === "all" || c.lifecycle === lifecycle) && matchesQuery(c, query),
  );
}
