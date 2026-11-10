// The ECB's daily rates (the multi-market spec §A.3) and the seeded
// currency table (§A.2): parsed without a float, stored once per day, and
// the database's currency rows equal to specs/currencies-v1.json.

import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../db";
import { currencies, fxRates } from "../../db/schema";
import { CURRENCY_ROWS } from "../core/currency-table";
import { FxError } from "../core/fx";
import { fetchAndStoreEcb, parseEcbDaily, rateOn } from "./ecb";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='1999-03-04'>
      <Cube currency='USD' rate='1.0786'/>
      <Cube currency='HUF' rate='391.48'/>
      <Cube currency='JPY' rate='162.54'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe("§A.3 — ECB daily reference rates", () => {
  it("parses each rate as the decimal string published", () => {
    expect(parseEcbDaily(SAMPLE)).toEqual([
      { currency: "USD", date: "1999-03-04", per_eur: "1.0786", source: "ECB daily reference" },
      { currency: "HUF", date: "1999-03-04", per_eur: "391.48", source: "ECB daily reference" },
      { currency: "JPY", date: "1999-03-04", per_eur: "162.54", source: "ECB daily reference" },
    ]);
  });

  it("refuses a file with no date or no rates", () => {
    expect(() => parseEcbDaily("<x/>")).toThrow(FxError);
    expect(() => parseEcbDaily("<Cube time='1999-03-04'></Cube>")).toThrow(/no rates/);
  });

  it("stores a day once; a second fetch of the same day changes nothing", async () => {
    const fetcher = async () => ({ ok: true, text: async () => SAMPLE });
    await fetchAndStoreEcb(fetcher);
    const again = await fetchAndStoreEcb(async () => ({
      ok: true,
      text: async () => SAMPLE.replace("391.48", "999.99"),
    }));
    expect(again.stored).toBe(0);
    const [row] = await db
      .select()
      .from(fxRates)
      .where(and(eq(fxRates.currency, "HUF"), eq(fxRates.date, "1999-03-04")));
    expect(row?.per_eur).toBe("391.48");
  });

  it("reads the last published rate on or before a day (weekends, holidays)", async () => {
    expect((await rateOn("HUF", "1999-03-07"))?.per_eur).toBe("391.48");
    expect(await rateOn("HUF", "1999-03-03")).toBeNull();
  });

  it("a failed fetch says so in words", async () => {
    await expect(
      fetchAndStoreEcb(async () => ({ ok: false, text: async () => "" })),
    ).rejects.toThrow(/couldn't be read today/);
  });
});

describe("§A.2 — the currencies table is the seed file, row for row", () => {
  it("matches specs/currencies-v1.json exactly", async () => {
    const rows = await db.select().from(currencies);
    const byCode = new Map(rows.map((r) => [r.code, r]));
    expect(rows).toHaveLength(CURRENCY_ROWS.length);
    for (const want of CURRENCY_ROWS) expect(byCode.get(want.code), want.code).toEqual(want);
  });
});
