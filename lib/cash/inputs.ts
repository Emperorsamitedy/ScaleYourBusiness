// The cash forecast's inputs from the profile's current facts — P5-07.
// Pure: lib/cash/load.ts reads the rows, this turns them into CashInputs,
// each figure with its basis and source. No database, no clock.

import type { Basis } from "../../components/report/basis";
import { basisOf } from "../../components/report/basis";
import { displaySourceKind } from "../connectors/measured";
import { enumCode } from "../core/enum-value";
import type { Field } from "../core/field";
import type { Answer, CostLine, CountFact, MoneyFact, OfferLine } from "./model";

const VALUE_BEARING = new Set(["answered", "inferred"]);

/** The current facts of a profile, by field key. */
export type Facts = ReadonlyMap<string, Field<unknown>>;

function basisOfField(f: Field<unknown>): Basis | null {
  return basisOf({
    status: f.status,
    source_kind: displaySourceKind(f.source),
    note: f.note,
    confidence: Number(f.confidence),
  });
}

function sourceWords(f: Field<unknown>, basis: Basis): string {
  if (basis === "OBSERVED") return f.note ?? "measured from your connected account";
  if (basis === "ESTIMATED") return "your estimate";
  if (basis === "DERIVED") return f.note ?? "worked out from your other figures";
  return "as you told me";
}

/** Pure: a Money fact with its provenance, or null when the field holds none. */
export function moneyFactOf(f: Field<unknown> | undefined): MoneyFact | null {
  if (!f || !VALUE_BEARING.has(f.status) || f.value === null) return null;
  const m = f.value as { amount_minor?: unknown; currency?: unknown };
  if (!Number.isSafeInteger(m.amount_minor) || typeof m.currency !== "string") return null;
  const basis = basisOfField(f);
  if (!basis) return null;
  return {
    amount_minor: m.amount_minor as number,
    currency: m.currency.toUpperCase(),
    basis,
    source: sourceWords(f, basis),
    on: f.observed_at.slice(0, 10),
  };
}

export function countFactOf(f: Field<unknown> | undefined): CountFact | null {
  if (!f || !VALUE_BEARING.has(f.status) || f.value === null) return null;
  const v = typeof f.value === "number" ? f.value : Number(f.value);
  if (!Number.isFinite(v) || v < 0) return null;
  const basis = basisOfField(f);
  if (!basis) return null;
  return { value: v, basis, source: sourceWords(f, basis) };
}

/** Pure: a stated Money answer — a value, "I don't know" (rule 5), or nothing yet. */
export function moneyAnswer(f: Field<unknown> | undefined): Answer<MoneyFact> {
  if (f?.status === "unknown") return { status: "unknown" };
  const fact = moneyFactOf(f);
  return fact ? { status: "known", fact } : { status: "missing" };
}

/** Pure: the codes of a select or multi-select answer. */
export function codesOf(f: Field<unknown> | undefined): string[] | null {
  if (!f || !VALUE_BEARING.has(f.status) || f.value === null) return null;
  const list = Array.isArray(f.value) ? f.value : [f.value];
  return list.map((v) => enumCode(v)).filter((c): c is string => c !== null);
}

function entityIds(f: Field<unknown> | undefined): string[] {
  if (!f || !VALUE_BEARING.has(f.status) || f.value === null) return [];
  const ids = (f.value as { entity_ids?: unknown }).entity_ids;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

/** Pure: the cost lines of 5.1 and 5.2, from the cost_items rows and their facts. */
export function costLines(
  facts: Facts,
  items: readonly { id: string; bucket: "fixed" | "variable" }[],
): CostLine[] {
  // Which list a row was entered on is the 5.2 answer's own entity ids: the
  // intake files every cost row under the "fixed" bucket, so the bucket alone
  // can't say. The forecast reads the cadence either way; this is the label.
  const variableIds = new Set(entityIds(facts.get("costs.variable")));
  return items.map((item) => {
    const fact = (k: string) => facts.get(`costs.${item.id}.${k}`);
    const label = fact("label")?.value;
    const category = codesOf(fact("category"))?.[0] ?? null;
    return {
      key: `costs.${item.id}`,
      label:
        typeof label === "string" && label.trim() !== ""
          ? label.trim()
          : category
            ? category.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
            : "A cost",
      category,
      list: variableIds.has(item.id) ? "variable" : item.bucket,
      amount: moneyFactOf(fact("amount")),
      cadence: codesOf(fact("cadence"))?.[0] ?? null,
    };
  });
}

/** Pure: the offers that aren't discontinued, with price, cost to deliver and units a month. */
export function offerLines(facts: Facts, ids: readonly string[]): OfferLine[] {
  const out: OfferLine[] = [];
  for (const id of ids) {
    const fact = (k: string) => facts.get(`offers.${id}.${k}`);
    if (codesOf(fact("lifecycle"))?.[0] === "discontinued") continue;
    const name = fact("name")?.value;
    out.push({
      key: `offers.${id}`,
      name: typeof name === "string" && name.trim() !== "" ? name.trim() : "An offer",
      price: moneyFactOf(fact("price")),
      cost: moneyFactOf(fact("cost_to_deliver")),
      volume_month: countFactOf(fact("volume_period")),
    });
  }
  return out;
}
