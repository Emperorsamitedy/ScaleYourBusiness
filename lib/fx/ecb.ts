// The ECB's daily reference rates — the multi-market spec §A.3's one source.
//
// Fetched once a day (cron/fx-rates), parsed without a float — each rate
// stays the decimal string the ECB published — and persisted to fx_rates,
// keyed (currency, date). A date already stored is never rewritten: a
// conversion made against it must reproduce forever. The fetch carries no
// business data, only SYB's own request for public rates.

import { and, desc, eq, lte } from "drizzle-orm";
import { db } from "../../db";
import { fxRates } from "../../db/schema";
import { isIsoCurrency } from "../core/currencies";
import type { FxRate } from "../core/fx";
import { ECB_SOURCE, FxError } from "../core/fx";

export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const MAX_BYTES = 200_000;

/** Pure: the ECB's daily XML → rates. Refuses anything it can't read exactly. */
export function parseEcbDaily(xml: string): FxRate[] {
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  if (!date) throw new FxError("the ECB file has no reference date");
  const rates: FxRate[] = [];
  const re = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"](\d+(?:\.\d+)?)['"]\s*\/>/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    const [, currency, perEur] = m;
    if (!isIsoCurrency(currency!)) continue;
    rates.push({ currency: currency!, date, per_eur: perEur!, source: ECB_SOURCE });
  }
  if (rates.length === 0) throw new FxError("the ECB file has no rates");
  return rates;
}

/** Store a day's rates. A (currency, date) already held is kept as it was. */
export async function storeRates(rates: readonly FxRate[]): Promise<number> {
  if (rates.length === 0) return 0;
  const inserted = await db
    .insert(fxRates)
    .values(rates.map((r) => ({ ...r })))
    .onConflictDoNothing()
    .returning({ currency: fxRates.currency });
  return inserted.length;
}

/** Fetch today's file and store it. One attempt; the cron runs again tomorrow. */
export async function fetchAndStoreEcb(
  fetcher: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }> = (u) =>
    fetch(u, { headers: { accept: "application/xml" } }),
): Promise<{ date: string; stored: number }> {
  const res = await fetcher(ECB_DAILY_URL);
  if (!res.ok) throw new FxError("the ECB's rates couldn't be read today");
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new FxError("the ECB file is larger than expected");
  const rates = parseEcbDaily(text);
  return { date: rates[0]!.date, stored: await storeRates(rates) };
}

/** The stored rate for a currency on a day, or the latest before it (weekends, holidays). */
export async function rateOn(currency: string, date: string): Promise<FxRate | null> {
  const [row] = await db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.currency, currency), lte(fxRates.date, date)))
    .orderBy(desc(fxRates.date))
    .limit(1);
  return row
    ? { currency: row.currency, date: row.date, per_eur: row.per_eur, source: row.source }
    : null;
}
