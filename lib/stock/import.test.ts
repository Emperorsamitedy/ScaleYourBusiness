// Feature 34 — the stock file import. What must hold: the column map is
// data and reads the spellings tills and spreadsheets use; every value that
// can't be read is counted and left out, never guessed; money is integer
// minor units in the currency the owner names (rule 1); and the figures
// land as observations under an import connection the sync runner never
// walks, with one decision-log entry for the batch.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  decisionLog,
  fieldRecords,
  intakeEvents,
  metricObservations,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { syncConnection } from "../connectors/sync";
import {
  STOCK_COLUMNS,
  STOCK_IMPORT_PROVIDER,
  StockImportError,
  importStockFile,
  itemRef,
  mapStockHeader,
  parseStockMoney,
  stockFileObservations,
} from "./import";

const AS_OF = "2026-10-20";
const NOW = "2026-10-22T09:00:00.000Z";

describe("the column map is data", () => {
  it("reads the spellings tills and spreadsheets use", () => {
    expect(
      mapStockHeader([
        "Product Name",
        "SKU",
        "Qty on hand",
        "Cost price",
        "Retail price",
        "Last sold",
      ]),
    ).toEqual({
      item: 0,
      sku: 1,
      on_hand: 2,
      unit_cost: 3,
      price: 4,
      last_sold: 5,
      units_sold: -1,
    });
    expect(mapStockHeader(["item", "stock", "units_sold"])).toMatchObject({
      item: 0,
      on_hand: 1,
      units_sold: 2,
    });
  });

  it("a header takes one role only, and the map itself is a const table", () => {
    // "Quantity sold" is units sold, not on hand; "Quantity" is on hand.
    expect(mapStockHeader(["Name", "Quantity", "Quantity sold"])).toMatchObject({
      on_hand: 1,
      units_sold: 2,
    });
    expect(STOCK_COLUMNS.on_hand).toContain("onhand");
  });
});

describe("money and keys", () => {
  it("parses money exactly to minor units, refusing what it can't read", () => {
    expect(parseStockMoney("€12.50", "EUR")).toBe(1250);
    expect(parseStockMoney("12,50", "EUR")).toBe(1250);
    expect(parseStockMoney("1.234,50", "EUR")).toBe(123_450);
    expect(parseStockMoney("1,234.50", "EUR")).toBe(123_450);
    expect(parseStockMoney("4990", "JPY")).toBe(4990);
    expect(parseStockMoney("12.505", "EUR")).toBeNull(); // more precise than cents: refused
    expect(parseStockMoney("about ten", "EUR")).toBeNull();
    expect(parseStockMoney("-3", "EUR")).toBeNull();
  });

  it("keys an item by its SKU, else its name", () => {
    expect(itemRef("SH-01", "Shampoo")).toBe("import:sku:sh-01");
    expect(itemRef("", "  Argan  Oil ")).toBe("import:name:argan oil");
    expect(itemRef("", "")).toBeNull();
  });
});

describe("reading a file — counted, never guessed", () => {
  const csv = [
    "Item,SKU,On hand,Unit cost,Price,Last sold,Units sold",
    "Argan oil 100 ml,AO-100,14,9.50,24.00,2026-07-02,0",
    "Shampoo 250 ml,SH-250,30,4.20,12.00,2026-10-18,22",
    "Hair wax,,8,lots,9.00,someday,3",
    ",,5,1.00,2.00,,",
    "Brush,BR-1,many,3.00,8.00,,",
    "Argan oil again,AO-100,2,9.50,24.00,,",
    "Future sale,FS-1,4,1.00,2.00,2026-10-21,",
  ].join("\n");
  const { observations, result } = stockFileObservations(
    csv,
    { as_of: AS_OF, currency: "EUR", window_days: 90 },
    NOW,
  );

  it("counts what it left out, by reason", () => {
    expect(result.imported).toBe(4);
    expect(result.skipped).toEqual({ no_item: 1, on_hand_unreadable: 1, duplicate_in_file: 1 });
    // "lots" (cost), "someday" (last sold), and a sale dated after the count.
    expect(result.unreadable).toEqual({ unit_cost: 1, price: 0, last_sold: 2, units_sold: 0 });
  });

  it("turns each item into observations, money in minor units with the file's currency", () => {
    const of = (ref: string) => observations.filter((o) => o.dimensions.product_ref === ref);
    const argan = of("import:sku:ao-100");
    expect(argan.map((o) => [o.metric_key, o.value_num ?? o.value_minor])).toEqual([
      ["stock.on_hand", 14],
      ["stock.value_at_cost", 14 * 950],
      ["stock.value_at_price", 14 * 2400],
      ["stock.days_since_sale", 110],
      ["stock.units_sold_window", 0],
    ]);
    expect(argan[1]!.dimensions).toMatchObject({ currency: "EUR", item_name: "Argan oil 100 ml" });
    expect(argan[4]!.dimensions.window_days).toBe("90");
    for (const o of observations) {
      expect(o.period_date).toBe(AS_OF);
      expect(o.observed_at).toBe(NOW);
    }
    // The wax's cost was unreadable: no value at cost, never a guess.
    expect(of("import:name:hair wax").map((o) => o.metric_key)).not.toContain(
      "stock.value_at_cost",
    );
  });

  it("refuses a file it can't read at all, saying what's missing", () => {
    const read = (text: string, opts = {}) =>
      stockFileObservations(text, { as_of: AS_OF, currency: "EUR", window_days: 90, ...opts }, NOW);
    expect(() => read("colour,size\nred,M")).toThrow(/no item column/);
    expect(() => read("item,price\nWax,9")).toThrow(/no stock column/);
    expect(() => read("item,on hand,price\nWax,3,9", { currency: "" })).toThrow(/which currency/);
    expect(() => read("item,on hand,sold\nWax,3,1", { window_days: undefined })).toThrow(
      /how many days/,
    );
    expect(() => read("item,on hand\n")).toThrow(StockImportError);
  });
});

/* ── against the database ── */

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const accountIds = created.map((s) => s.account_id);
  const ids = created.map((s) => s.profile_id);
  if (accountIds.length === 0) return;
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.account_id, accountIds));
  if (conns.length > 0) {
    await db.delete(metricObservations).where(
      inArray(
        metricObservations.connection_id,
        conns.map((c) => c.id),
      ),
    );
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
  }
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

describe("importStockFile", () => {
  it("stores observations under an import connection with no secret, and logs the batch", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const now = new Date(NOW);
    const csv = "item,on hand,unit cost,price\nArgan oil,14,9.50,24.00\nShampoo,30,4.20,12.00";
    const result = await importStockFile(s.account_id, csv, { currency: "EUR", as_of: AS_OF, now });
    expect(result.imported).toBe(2);

    const [conn] = await db
      .select()
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    expect(conn).toMatchObject({
      provider: STOCK_IMPORT_PROVIDER,
      purpose: "import",
      encrypted_secret: null,
      granted_scopes: [],
    });
    const rows = await db
      .select()
      .from(metricObservations)
      .where(eq(metricObservations.connection_id, conn!.id));
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.metric_key === "stock.value_at_cost")).toMatchObject({
      currency: "EUR",
    });

    const [entry] = await db
      .select()
      .from(decisionLog)
      .where(
        and(eq(decisionLog.profile_id, s.profile_id), eq(decisionLog.ref_id, result.batch_id)),
      );
    expect(entry).toMatchObject({ kind: "import", actor: "owner" });
    expect(entry!.payload_hash).toMatch(/^[0-9a-f]{64}$/);

    // A second file the same day replaces that day's figures; it doesn't add a second connection.
    await importStockFile(s.account_id, "item,on hand\nArgan oil,10", { as_of: AS_OF, now });
    const again = await db
      .select()
      .from(metricObservations)
      .where(
        and(
          eq(metricObservations.connection_id, conn!.id),
          eq(metricObservations.metric_key, "stock.on_hand"),
        ),
      );
    expect(again.find((r) => r.dimensions.product_ref === "import:name:argan oil")?.value_num).toBe(
      "10.0000",
    );
    const all = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    expect(all).toHaveLength(1);

    // The sync runner never pulls from an import connection.
    expect((await syncConnection(conn!.id, now)).skipped).toBe("not_measurement");
  });

  it("refuses a count date in the future", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await expect(
      importStockFile(s.account_id, "item,on hand\nWax,3", {
        as_of: "2026-10-23",
        now: new Date(NOW),
      }),
    ).rejects.toThrow(/future/);
  });
});
