// Case studies — the multi-market spec §D.3.
//
// A case study travels across borders by its MECHANISM, not its amount: "a
// nine-person café cut 14% of its food waste by changing Tuesday staffing"
// travels; "saved HUF 1.4m" does not. So a case study can't exist without a
// mechanism in plain words, and without the ledger entries that prove it —
// each one a verified gain of this business, standing (not corrected away).
//
// local_amount is the entries' net, in the business's own currency. The EUR
// equivalent is SYB's internal projection at the stored rate and date, never
// what a cross-border reader is shown.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { caseStudies, ledgerEntries } from "../../db/schema";
import { typeEntry, isMapped } from "../benchmarks/map";
import { toEur } from "../core/fx";
import { money } from "../core/money";
import { rateOn } from "../fx/ecb";
import { readCurrentField } from "../profile/field-store";
import { businessCountryIso } from "../phone/countries";
import { segmentOf } from "../segments/read";

export type CaseStudy = typeof caseStudies.$inferSelect;

export class CaseStudyError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "CaseStudyError";
    this.status = status;
  }
}

export const MIN_MECHANISM_CHARS = 20;

export async function createCaseStudy(args: {
  profileId: string;
  mechanism: string;
  ledgerEntryIds: readonly string[];
  now?: Date;
}): Promise<CaseStudy> {
  const mechanism = args.mechanism.trim();
  if (mechanism.length < MIN_MECHANISM_CHARS) {
    throw new CaseStudyError(
      "a case study says how it worked, in plain words — the mechanism is required",
    );
  }
  const ids = [...new Set(args.ledgerEntryIds)];
  if (ids.length === 0) throw new CaseStudyError("a case study is backed by ledger entries");

  const entries = await db
    .select()
    .from(ledgerEntries)
    .where(and(inArray(ledgerEntries.id, ids), eq(ledgerEntries.profile_id, args.profileId)));
  if (entries.length !== ids.length) {
    throw new CaseStudyError("every backing entry must be this business's own");
  }
  // Each must be its plan's standing entry: a corrected-away gain proves nothing.
  const planIds = [...new Set(entries.map((e) => e.plan_id))];
  const all = await db.select().from(ledgerEntries).where(inArray(ledgerEntries.plan_id, planIds));
  const standing = new Map<string, number>();
  for (const e of all) standing.set(e.plan_id, Math.max(standing.get(e.plan_id) ?? 0, e.seq));
  for (const e of entries) {
    if (e.verdict !== "verified_gain")
      throw new CaseStudyError("only verified gains back a case study");
    if (standing.get(e.plan_id) !== e.seq)
      throw new CaseStudyError("a corrected entry can't back a case study");
  }
  const currencies = new Set(entries.map((e) => e.currency));
  if (currencies.size !== 1) throw new CaseStudyError("a case study's entries share one currency");
  const currency = entries[0]!.currency;
  const local = entries.reduce((n, e) => n + (e.net_minor ?? 0), 0);

  const [country, type, segment] = await Promise.all([
    businessCountryIso(args.profileId),
    readCurrentField<unknown>(args.profileId, "identity.business_type"),
    segmentOf(args.profileId),
  ]);
  const entry = typeEntry(type?.value);
  if (!country || !isMapped(entry) || !segment.segment) {
    throw new CaseStudyError(
      "a case study names the business's country, sector and size — fill those in first",
    );
  }

  const day = (args.now ?? new Date()).toISOString().slice(0, 10);
  let fx: {
    eur_equivalent_minor: number;
    fx_rate_to_eur: string;
    fx_rate_date: string;
    fx_source: string;
  } | null = null;
  if (currency === "EUR") {
    fx = null;
  } else {
    const rate = await rateOn(currency, day);
    if (rate) {
      const eur = toEur(money(local, currency), rate);
      fx = {
        eur_equivalent_minor: eur.amount_minor,
        fx_rate_to_eur: eur.fx_rate_to_eur,
        fx_rate_date: eur.fx_rate_date,
        fx_source: eur.fx_source,
      };
    }
  }
  const [row] = await db
    .insert(caseStudies)
    .values({
      profile_id: args.profileId,
      country,
      currency,
      nace: entry.nace,
      segment: segment.segment,
      local_amount_minor: local,
      mechanism,
      ledger_entry_ids: ids,
      ...(fx ?? {}),
    })
    .returning();
  return row!;
}

/** What a reader in another market sees: the mechanism, never the amount. */
export function crossBorderView(c: CaseStudy): {
  mechanism: string;
  country: string;
  nace: string;
  segment: string;
} {
  return { mechanism: c.mechanism, country: c.country, nace: c.nace, segment: c.segment };
}
