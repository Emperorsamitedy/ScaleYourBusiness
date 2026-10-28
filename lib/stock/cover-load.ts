// Reading what runs out, and when — Phase 5 Session A (P5-02, P5-04).
// Read-only: the stock the slow-stock reader already loads (./load), the
// owner's suppliers from 1.4.1.3 (delivery time, minimum order, which
// products they supply), and the busy-season forecast (lib/seasons). Every
// figure is worked out by ./cover, which is pure. Nothing is written,
// nothing leaves the database, and no model is called.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { suppliers } from "../../db/schema";
import { readCurrentField } from "../profile/field-store";
import { loadSeasons } from "../seasons/load";
import type { StockAssessment, StockItem } from "./assess";
import type { CoverAssessment, SeasonBoost, SupplierInfo } from "./cover";
import { assessCover, leadTimeFor, rankWarnings, seasonBoost } from "./cover";
import type { StockView } from "./load";
import { loadStock } from "./load";

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : null;

/** The owner's suppliers (1.4.1.3), as answered: unknowns stay null, never guessed. */
export async function loadSuppliers(profileId: string): Promise<SupplierInfo[]> {
  const spine = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(eq(suppliers.profile_id, profileId))
    .orderBy(suppliers.created_at);
  const out: SupplierInfo[] = [];
  for (const { id } of spine) {
    const read = async (key: string) => {
      const f = await readCurrentField<unknown>(profileId, `suppliers.${id}.${key}`);
      return f?.status === "answered" ? f.value : null;
    };
    const name = await read("name");
    const offers = await read("supplies_offers");
    out.push({
      id,
      name: typeof name === "string" && name.trim() !== "" ? name.trim() : "Your supplier",
      lead_time_days: num(await read("lead_time_days")),
      moq: num(await read("moq")),
      offer_ids: Array.isArray(offers)
        ? offers
            .map((o) =>
              typeof o === "string" ? o : ((o as { code?: unknown } | null)?.code ?? null),
            )
            .filter((c): c is string => typeof c === "string")
        : [],
    });
  }
  return out;
}

export interface CoverRow {
  key: string;
  name: string;
  source: string;
  item: StockItem;
  slow: StockAssessment;
  cover: CoverAssessment;
}

export interface CoverView {
  today: string;
  rows: CoverRow[];
  /** Items whose cover falls below their delivery time: sold out first, then the soonest. */
  warnings: CoverRow[];
  boost: SeasonBoost | null;
  /** Why no stretch was counted, or the season's own headline, in words. */
  season_note: string;
  suppliers: SupplierInfo[];
  stock: StockView;
}

/** Every item read, with its cover, warning and reorder arithmetic, as of `now`. */
export async function loadCover(
  accountId: string,
  profileId: string,
  now: Date = new Date(),
  stock?: StockView,
): Promise<CoverView> {
  const view = stock ?? (await loadStock(accountId, profileId, now));
  const today = view.today;
  const owned = await loadSuppliers(profileId);
  const seasons = await loadSeasons(accountId, profileId, now);
  const boost = seasonBoost(seasons.result, today);
  const r = seasons.result;
  const seasonNote = boost
    ? boost.sentence
    : r.status === "ready"
      ? r.headline
      : r.status === "too_little"
        ? `No season counted: ${r.headline}`
        : "No season counted: nothing measured a year of sales yet.";

  const labelOf = (connectionId: string, provider: string) =>
    view.sources.find((s) => s.connection_id === connectionId)?.label ?? provider;
  const rows: CoverRow[] = view.items.map(({ item, assessment }) => {
    const source = labelOf(item.connection_id, item.provider);
    return {
      key: `${item.connection_id}:${item.ref}`,
      name: item.name,
      source,
      item,
      slow: assessment,
      cover: assessCover(item, today, leadTimeFor(item, owned), boost, source),
    };
  });
  return {
    today,
    rows,
    warnings: rankWarnings(rows),
    boost,
    season_note: seasonNote,
    suppliers: owned,
    stock: view,
  };
}
