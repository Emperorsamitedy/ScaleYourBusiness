// The abandoned-cart segment — idea 47, I-47.3.
//
// Who is in it: contacts whose email hash matches a cart they left
// CARTS.winback_min_days to CARTS.winback_max_days days ago (UTC days, so
// a cart from today waits for tomorrow) with no later order: the cart was
// never finished, no later cart of theirs was, and their last purchase on
// record isn't after it. Who may be emailed: the consent gate
// (canEmailForMarketing, rule 19) decides per contact, every time, and a
// contact proposed a cart reminder in the last CARTS.recontact_days days
// is left out. Everyone else is counted in words, never listed.
//
// The segment carries contact ids and counts, never an address or a name
// (rule 22). What it names is the products left behind, for the draft.

import { shiftDay } from "../anomaly/baseline";
import type { Segment } from "../crm/segments";
import type { CartFacts, StoredCart } from "./load";
import { CARTS } from "./measure";

export interface CartSegment extends Segment {
  key: "abandoned_cart";
  /** Contacts left out because they were proposed a reminder in the last 30 days. */
  recently_proposed: number;
  /** Carts of the last week whose shopper isn't a contact, or left no address SYB could read. */
  unmatched_carts: number;
  /** The products in the emailable shoppers' carts, most carts first: ref, provider and line title. */
  products: { ref: string; provider: string; title: string | null; carts: number }[];
}

/** Pure: the segment from the loaded facts. `recentlyProposed` holds contact ids. */
export function abandonedCartSegment(
  facts: Pick<CartFacts, "today" | "carts" | "contacts">,
  recentlyProposed: ReadonlySet<string>,
): CartSegment {
  const from = shiftDay(facts.today, -CARTS.winback_max_days);
  const to = shiftDay(facts.today, -CARTS.winback_min_days);
  const recent = facts.carts.filter((c) => c.day >= from && c.day <= to && !c.completed);

  // "No later order": a later finished cart of theirs, or a purchase on record after it.
  const finishedBy = new Map<string, string>(); // hash → latest finished start
  for (const c of facts.carts) {
    if (!c.completed || c.shopper === null) continue;
    const cur = finishedBy.get(c.shopper);
    if (!cur || c.started_at > cur) finishedBy.set(c.shopper, c.started_at);
  }
  const boughtSince = (c: StoredCart): boolean => {
    if (c.shopper !== null) {
      const later = finishedBy.get(c.shopper);
      if (later && later > c.started_at) return true;
    }
    const contact = c.contact_id ? facts.contacts.get(c.contact_id) : undefined;
    const last = contact?.last_purchase_at;
    return !!last && Date.parse(last) > Date.parse(c.started_at);
  };

  const unmatched = recent.filter((c) => c.contact_id === null).length;
  const byContact = new Map<string, StoredCart[]>();
  for (const c of recent) {
    if (c.contact_id === null || boughtSince(c)) continue;
    byContact.set(c.contact_id, [...(byContact.get(c.contact_id) ?? []), c]);
  }

  const contact_ids = [...byContact.keys()].sort();
  const emailable_ids: string[] = [];
  const excluded = { no_email: 0, no_consent: 0, suppressed: 0 };
  let recently_proposed = 0;
  for (const id of contact_ids) {
    const reach = byContact.get(id)![0]!.reach;
    if (reach === "emailable") {
      if (recentlyProposed.has(id)) recently_proposed += 1;
      else emailable_ids.push(id);
    } else if (reach === "suppressed") excluded.suppressed += 1;
    else if (reach === "no_email") excluded.no_email += 1;
    else excluded.no_consent += 1;
  }

  const products = new Map<
    string,
    { ref: string; provider: string; title: string | null; carts: Set<string> }
  >();
  for (const id of emailable_ids) {
    for (const c of byContact.get(id)!) {
      for (const l of c.lines) {
        if (l.product_ref === null || l.quantity <= 0) continue;
        const key = `${c.provider}|${l.product_ref}`;
        const p = products.get(key) ?? {
          ref: l.product_ref,
          provider: c.provider,
          title: l.title,
          carts: new Set<string>(),
        };
        p.carts.add(c.ref);
        products.set(key, p);
      }
    }
  }

  const n = contact_ids.length;
  return {
    key: "abandoned_cart",
    label: "Shoppers who left a cart",
    contact_ids,
    emailable_ids,
    excluded,
    recently_proposed,
    unmatched_carts: unmatched,
    products: [...products.values()]
      .map((p) => ({ ref: p.ref, provider: p.provider, title: p.title, carts: p.carts.size }))
      .sort((a, b) => b.carts - a.carts || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
    evidence: [
      `abandoned cart = a contact whose cart, left ${CARTS.winback_min_days}–${CARTS.winback_max_days} days before ${facts.today}, was never finished, with no later order of theirs on record`,
      `${n} contact${n === 1 ? "" : "s"} match; ${emailable_ids.length} hold explicit email consent and no suppression and weren't proposed a reminder in the last ${CARTS.recontact_days} days (${recently_proposed} were), ${excluded.no_consent} lack consent, ${excluded.suppressed} are suppressed`,
      `${unmatched} cart${unmatched === 1 ? "" : "s"} of the same days ${unmatched === 1 ? "is" : "are"} from shoppers who aren't your contacts or left no address I can read, so they aren't emailed`,
    ],
  };
}
