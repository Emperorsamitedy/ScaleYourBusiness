// Order baskets, stored — idea 48, bundles.
//
// A store sync's page hands back the baskets of the days it read
// (PullPage.baskets). The window is authoritative: the stored baskets of
// those days are deleted and the page's inserted, inside the page's own
// transaction, so a re-read (refunds and cancellations change the last 30
// days) never counts an order twice and drops an order since cancelled.

import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { db } from "../../db";
import { orderBaskets } from "../../db/schema";
import { isoDate, isoDateTime } from "../core/iso";
import type { BasketWindow } from "../connectors/provider";

export type BasketExecutor = Pick<typeof db, "insert" | "delete">;

const CHUNK = 500;

/** Replace the connection's baskets of [from, to] with the window's. Returns how many landed. */
export async function replaceBaskets(
  executor: BasketExecutor,
  conn: { id: string; account_id: string },
  window: BasketWindow,
  observedAt: string,
): Promise<number> {
  const from = isoDate(window.from);
  const to = isoDate(window.to);
  const at = isoDateTime(observedAt);
  // One order once: a page that read an order twice keeps the later read.
  const byRef = new Map<string, BasketWindow["orders"][number]>();
  for (const o of window.orders) {
    if (o.product_refs.length === 0) continue;
    const day = isoDate(o.day);
    if (day < from || day > to) continue;
    byRef.set(o.order_ref, o);
  }
  await executor
    .delete(orderBaskets)
    .where(
      and(
        eq(orderBaskets.connection_id, conn.id),
        gte(orderBaskets.day, from),
        lte(orderBaskets.day, to),
      ),
    );
  const rows = [...byRef.values()].map((o) => ({
    account_id: conn.account_id,
    connection_id: conn.id,
    order_ref: o.order_ref,
    day: o.day,
    product_refs: [...new Set(o.product_refs)].sort(),
    observed_at: at,
  }));
  for (let i = 0; i < rows.length; i += CHUNK) {
    await executor
      .insert(orderBaskets)
      .values(rows.slice(i, i + CHUNK))
      // An order that moved day (re-dated) since the last read: keep the newest.
      .onConflictDoUpdate({
        target: [orderBaskets.connection_id, orderBaskets.order_ref],
        set: {
          day: sql`excluded.day`,
          product_refs: sql`excluded.product_refs`,
          observed_at: sql`excluded.observed_at`,
        },
      });
  }
  return rows.length;
}
