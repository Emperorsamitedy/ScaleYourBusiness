// Reading abandoned carts — idea 47. Read-only: the stored carts, the
// orders the sync counted, the owner's contacts and offers; nothing is
// written, no model is called.
//
// Sources are data, not a list of platforms: every measure connection whose
// provider reads abandoned checkouts (Provider.readAbandonedCheckouts) —
// Shopify today. Who may be emailed is decided here, per contact, every
// time, by canEmailForMarketing (rule 19): a cart is matched to a contact
// by the keyed email hash, and only the contact's own recorded consent
// counts. Shopify's tick at checkout never does (I-47a). No address ever
// leaves this module: the view carries counts, and the segment ids.

import { and, eq, gte, inArray, ne } from "drizzle-orm";
import { db } from "../../db";
import { abandonedCheckouts, connections, metricObservations, offers } from "../../db/schema";
import { shiftDay } from "../anomaly/baseline";
import { sourceLabel } from "../charts/load";
import { mappingKey } from "../connectors/mapping";
import { getProvider } from "../connectors/registry";
import { isProviderId } from "../connectors/scopes";
import type { ContactRow } from "../crm/contacts";
import { canEmailForMarketing, emailHashCandidates, listContacts } from "../crm/contacts";
import { readCurrentField } from "../profile/field-store";
import type { CartFact, CartReach, CartsMeasure } from "./measure";
import { CARTS, measureCarts } from "./measure";

/** Store providers that read abandoned checkouts: read from the registry. */
export function isCartProvider(provider: string): boolean {
  return isProviderId(provider) && getProvider(provider).readAbandonedCheckouts !== undefined;
}

export interface CartSource {
  connection_id: string;
  provider: string;
  label: string;
  /** The latest read that landed a cart, or null when none has. */
  read_at: string | null;
  carts: number;
}

async function cartConnections(accountId: string) {
  const rows = await db
    .select({ id: connections.id, provider: connections.provider })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.purpose, "measure"),
        ne(connections.status, "disconnected"),
      ),
    );
  return rows.filter((r) => isCartProvider(r.provider));
}

/** Whether the carts screen exists for this account: a store connection that reads them. */
export async function cartsApply(accountId: string): Promise<boolean> {
  return (await cartConnections(accountId)).length > 0;
}

export interface StoredCart extends CartFact {
  connection_id: string;
  provider: string;
  started_at: string;
  /** The contact the hash matched, when it matched one. */
  contact_id: string | null;
}

export interface CartFacts {
  today: string;
  sources: CartSource[];
  carts: StoredCart[];
  orders: { day: string; count: number }[];
  /** The contacts matched, by id — for the segment's gate and its "no later order" check. */
  contacts: Map<string, ContactRow>;
}

/**
 * Every stored cart of the account's cart sources from the last
 * CARTS.read_days days, each with its reach decided now, and the orders the
 * sync counted on those days.
 */
export async function loadCartFacts(accountId: string, now: Date = new Date()): Promise<CartFacts> {
  const today = now.toISOString().slice(0, 10);
  const conns = await cartConnections(accountId);
  if (conns.length === 0) return { today, sources: [], carts: [], orders: [], contacts: new Map() };
  const ids = conns.map((c) => c.id);
  const since = shiftDay(today, -CARTS.read_days);

  const rows = await db
    .select()
    .from(abandonedCheckouts)
    .where(and(inArray(abandonedCheckouts.connection_id, ids), gte(abandonedCheckouts.day, since)));

  const orderRows = await db
    .select({ day: metricObservations.period_date, value: metricObservations.value_num })
    .from(metricObservations)
    .where(
      and(
        inArray(metricObservations.connection_id, ids),
        eq(metricObservations.metric_key, "orders.daily"),
        gte(metricObservations.period_date, since),
      ),
    );
  const perDay = new Map<string, number>();
  for (const r of orderRows) perDay.set(r.day, (perDay.get(r.day) ?? 0) + Number(r.value ?? 0));

  // Hash → contact, over every form a contact's address may be stored under.
  const byHash = new Map<string, ContactRow>();
  if (rows.some((r) => r.email_hash !== null)) {
    for (const c of await listContacts(accountId)) {
      if (!c.email) continue;
      for (const h of emailHashCandidates(c.email)) byHash.set(h, c);
    }
  }
  const verdicts = new Map<string, CartReach>();
  const reachOf = async (contact: ContactRow): Promise<CartReach> => {
    const hit = verdicts.get(contact.id);
    if (hit) return hit;
    const v = await canEmailForMarketing(contact);
    const reach: CartReach = v.allowed
      ? "emailable"
      : v.reason.startsWith("suppressed")
        ? "suppressed"
        : v.reason.startsWith("no email")
          ? "no_email"
          : "no_consent";
    verdicts.set(contact.id, reach);
    return reach;
  };

  const matched = new Map<string, ContactRow>();
  const carts: StoredCart[] = [];
  for (const r of rows) {
    const contact = r.email_hash ? (byHash.get(r.email_hash) ?? null) : null;
    if (contact) matched.set(contact.id, contact);
    const conn = conns.find((c) => c.id === r.connection_id)!;
    carts.push({
      ref: r.checkout_ref,
      day: r.day,
      completed: r.completed_at !== null,
      total_minor: r.total_minor,
      currency: r.currency,
      lines: r.lines,
      lines_truncated: r.lines_truncated,
      shopper: r.email_hash,
      reach: r.email_hash === null ? "no_email" : contact ? await reachOf(contact) : "not_contact",
      connection_id: r.connection_id,
      provider: conn.provider,
      started_at: r.started_at,
      contact_id: contact?.id ?? null,
    });
  }

  const sources = conns.map((c) => {
    const mine = rows.filter((r) => r.connection_id === c.id);
    const read = mine.reduce<string | null>(
      (max, r) => (max === null || r.observed_at > max ? r.observed_at : max),
      null,
    );
    return {
      connection_id: c.id,
      provider: c.provider,
      label: sourceLabel(c.provider),
      read_at: read,
      carts: mine.length,
    };
  });

  return {
    today,
    sources,
    carts,
    orders: [...perDay.entries()].map(([day, count]) => ({ day, count })),
    contacts: matched,
  };
}

/**
 * A store product's name for the owner: the offer it is matched to (P2-15),
 * else the cart line's own title, else its id's tail. Never a shopper.
 */
export async function productNamer(
  profileId: string,
  providers: readonly string[],
): Promise<(ref: string, provider: string, title: string | null) => string> {
  const spine = await db
    .select({ id: offers.id })
    .from(offers)
    .where(eq(offers.profile_id, profileId));
  const byRef = new Map<string, string>(); // `${provider}|${ref}` → offer name
  for (const { id } of spine) {
    const name = await readCurrentField<unknown>(profileId, `offers.${id}.name`);
    if (typeof name?.value !== "string" || name.value.trim() === "") continue;
    for (const p of new Set(providers)) {
      const m = await readCurrentField<{ product_ref?: unknown }>(profileId, mappingKey(id, p));
      if (m?.status === "answered" && typeof m.value?.product_ref === "string") {
        byRef.set(`${p}|${m.value.product_ref}`, name.value.trim());
      }
    }
  }
  return (ref, provider, title) =>
    byRef.get(`${provider}|${ref}`) ?? title ?? `Product ${ref.split("/").at(-1) ?? ref}`;
}

export interface CartsView {
  today: string;
  sources: CartSource[];
  measure: CartsMeasure;
  /** Measured products, named for the owner. */
  product_names: Record<string, string>;
  /** What it was measured from, for the segment (never sent to a browser: it holds contacts). */
  facts: CartFacts;
}

/** The screen's read: the facts, measured, with the products named. */
export async function loadCarts(
  accountId: string,
  profileId: string,
  now: Date = new Date(),
): Promise<CartsView> {
  const facts = await loadCartFacts(accountId, now);
  const measure = measureCarts({ today: facts.today, carts: facts.carts, orders: facts.orders });
  const product_names: Record<string, string> = {};
  if (measure.status === "measured" && measure.products.length > 0) {
    const name = await productNamer(
      profileId,
      facts.sources.map((s) => s.provider),
    );
    for (const p of measure.products) {
      const provider =
        facts.carts.find((c) => c.lines.some((l) => l.product_ref === p.product_ref))?.provider ??
        "";
      product_names[p.product_ref] = name(p.product_ref, provider, p.title);
    }
  }
  return { today: facts.today, sources: facts.sources, measure, product_names, facts };
}
