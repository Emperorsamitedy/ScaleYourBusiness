// Entity-list sub-form service — Session O (step 28, P0-68..70).
//
// An entity answer is rows, not a value: each row becomes a spine record
// plus per-entity field records ("offers.<id>.price"), so entity facts
// supersede and carry provenance exactly like profile facts. The chip
// collapses the whole list to "4 products · 3 with costs" with per-row
// detail lines for expansion.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  bankEntitySchemas,
  bankVersions,
  channels,
  competitors,
  costItems,
  customerSegments,
  goals,
  offers,
  staffRoles,
  suppliers,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { Money } from "../core/money";
import { presentAmount } from "../i18n/format";
import type { InputSpec } from "../interviewer/harness/answers";
import { coerceParsedValue } from "../parser/coerce";
import { writeField } from "../profile/field-store";
import type { ApplicableQuestion } from "../resolver/applicability";
import type { BankWords } from "../bank/words";
import { ENGLISH_WORDS } from "../bank/words";
import type { EntityField, IntakeOption } from "./types";

export interface EntityFieldSpec extends EntityField {
  input: InputSpec;
}

const OFFER_KIND_BY_CODE: Readonly<
  Record<string, "physical" | "service" | "digital" | "subscription" | "marketplace_access">
> = {
  physical: "physical",
  service: "service",
  digital: "digital",
  subscription: "subscription",
  marketplace_access: "marketplace_access",
};

const NOUNS: Readonly<Record<string, string>> = {
  offer: "products",
  supplier: "suppliers",
  channel: "channels",
  competitor: "competitors",
  staff_role: "roles",
  cost_item: "costs",
  customer_segment: "segments",
  goal: "goals",
};

interface RawSchemaField {
  key: string;
  prompt?: Record<string, string>;
  input: InputSpec;
  priority?: EntityField["priority"];
}

/** Load an entity schema's fields from the current bank, worded in the person's language (L-2). */
export async function loadEntityFields(
  schemaKey: string,
  optionsFor: (spec: InputSpec) => Promise<IntakeOption[]>,
  currency: string,
  words: BankWords = ENGLISH_WORDS,
): Promise<EntityFieldSpec[]> {
  const [current] = await db.select().from(bankVersions).where(eq(bankVersions.is_current, true));
  if (!current) return [];
  const [row] = await db
    .select()
    .from(bankEntitySchemas)
    .where(eq(bankEntitySchemas.bank_version, current.version))
    .then((rows) => rows.filter((r) => r.key === schemaKey));
  if (!row) return [];
  const fields = row.fields as RawSchemaField[];
  return Promise.all(
    fields.map(async (f) => ({
      key: f.key,
      prompt: words.entityField(schemaKey, f.key, (f.prompt?.en ?? f.key).trim()),
      input_type: f.input.type,
      options: await optionsFor(f.input),
      priority: f.priority ?? "important",
      currency,
      input: f.input,
    })),
  );
}

/**
 * Which cost list a row was entered on is its question's target, so the
 * spine's bucket follows it: 5.1 (costs.fixed_monthly) files fixed, 5.2
 * (costs.variable) files variable. Until 2026-10-28 every row was filed
 * fixed, and unit economics counted per-sale costs among the monthly ones;
 * migration 0065 refiled the rows 5.2's answer names.
 */
export const COST_BUCKET_BY_TARGET: Readonly<Record<string, "fixed" | "variable">> = {
  "costs.fixed_monthly": "fixed",
  "costs.variable": "variable",
};

/** The bucket a cost row entered on this question belongs in; fixed when the target isn't a cost list. */
export function costBucketFor(writesTo: string): "fixed" | "variable" {
  return COST_BUCKET_BY_TARGET[writesTo] ?? "fixed";
}

async function createSpineRow(
  profileId: string,
  schemaKey: string,
  kindCode: string | null,
  writesTo: string,
): Promise<string> {
  switch (schemaKey) {
    case "offer": {
      const kind = (kindCode && OFFER_KIND_BY_CODE[kindCode]) || "physical";
      const [r] = await db
        .insert(offers)
        .values({ profile_id: profileId, kind })
        .returning({ id: offers.id });
      if (!r) throw new Error("offer insert failed");
      return r.id;
    }
    case "supplier": {
      const [r] = await db
        .insert(suppliers)
        .values({ profile_id: profileId })
        .returning({ id: suppliers.id });
      if (!r) throw new Error("supplier insert failed");
      return r.id;
    }
    case "channel": {
      const [r] = await db
        .insert(channels)
        .values({ profile_id: profileId })
        .returning({ id: channels.id });
      if (!r) throw new Error("channel insert failed");
      return r.id;
    }
    case "competitor": {
      const [r] = await db
        .insert(competitors)
        .values({ profile_id: profileId, source: { kind: "owner_input" } })
        .returning({ id: competitors.id });
      if (!r) throw new Error("competitor insert failed");
      return r.id;
    }
    case "staff_role": {
      const [r] = await db
        .insert(staffRoles)
        .values({ profile_id: profileId })
        .returning({ id: staffRoles.id });
      if (!r) throw new Error("staff_role insert failed");
      return r.id;
    }
    case "cost_item": {
      const bucket = costBucketFor(writesTo);
      const [r] = await db
        .insert(costItems)
        .values({ profile_id: profileId, bucket, scales_with_sales: bucket === "variable" })
        .returning({ id: costItems.id });
      if (!r) throw new Error("cost_item insert failed");
      return r.id;
    }
    case "customer_segment": {
      const [r] = await db
        .insert(customerSegments)
        .values({ profile_id: profileId })
        .returning({ id: customerSegments.id });
      if (!r) throw new Error("customer_segment insert failed");
      return r.id;
    }
    case "goal": {
      const [r] = await db
        .insert(goals)
        .values({ profile_id: profileId })
        .returning({ id: goals.id });
      if (!r) throw new Error("goal insert failed");
      return r.id;
    }
    default:
      throw new Error(`unknown entity schema "${schemaKey}"`);
  }
}

export interface EntityWriteResult {
  entity_ids: string[];
  rows_with_costs: number;
  detail: string[];
  noun: string;
}

const COST_KEYS = new Set(["cost_to_deliver", "amount", "purchase_price", "cost_monthly"]);
const NAME_KEYS = ["name", "label", "role_title", "category"];

/**
 * Write entity rows: spine record per row, per-entity field records for
 * every provided sub-field, marker record at the question's writes_to.
 * Rows arrive as { fieldKey: wireValue } with only filled fields present.
 */
export async function writeEntityRows(args: {
  profileId: string;
  question: ApplicableQuestion;
  schemaKey: string;
  fields: readonly EntityFieldSpec[];
  rows: readonly Record<string, unknown>[];
  currency: string;
}): Promise<EntityWriteResult> {
  const prefix = args.question.writes_to.split(".")[0] ?? args.question.writes_to;
  const at = isoDateTime(new Date().toISOString());
  const byKey = new Map(args.fields.map((f) => [f.key, f]));
  const entityIds: string[] = [];
  const detail: string[] = [];
  let rowsWithCosts = 0;

  // VALIDATE EVERY ROW BEFORE WRITING ANYTHING.
  //
  // These writes are not one transaction — writeField owns its own. So a
  // value that fails to coerce halfway through used to leave the earlier
  // rows written, the later ones lost, and (because the spine row exists)
  // the question no longer askable: an owner who mistyped one field lost
  // their whole product list with no way to re-enter it. Found on a live
  // run where a bad `purchase_type` code stranded a five-product list as
  // one nameless offer. Coerce first, write only if all of it is good.
  const prepared: { row: Record<string, unknown>; values: [string, unknown][] }[] = [];
  for (const row of args.rows) {
    const values: [string, unknown][] = [];
    for (const [key, wire] of Object.entries(row)) {
      if (wire === null || wire === undefined || wire === "") continue;
      if (args.schemaKey === "offer" && key === "kind") continue; // spine column
      const field = byKey.get(key);
      if (!field) {
        // An unknown key used to be skipped silently, which turned a
        // caller's typo into invisible data loss: a row of channels sent
        // as {channel_type: "website"} created four spine rows with no
        // type at all, and every later reference to them fell back to
        // "Channel 1". Found live. A wrong key is a 422 like any other
        // bad input — loud, before anything is written.
        throw Object.assign(
          new Error(
            `unknown field "${key}" for ${args.schemaKey}; expected one of: ${[...byKey.keys()].join(", ")}`,
          ),
          { status: 422, code: "unknown_field", values: { field: key } },
        );
      }
      const coerced = coerceParsedValue(
        field.input,
        wire,
        field.options.map((o) => o.code),
        args.currency,
      );
      if (!coerced.ok) {
        // The field's own words travel with the code, so the screen can say
        // which field in the person's language (intake.error.field).
        throw Object.assign(new Error(`${field.prompt}: ${coerced.reason}`), {
          status: 422,
          code: coerced.code,
          values: { ...(coerced.values ?? {}), field: field.prompt },
        });
      }
      values.push([key, coerced.value]);
    }
    prepared.push({ row, values });
  }

  for (const { row, values } of prepared) {
    const kindWire = typeof row.kind === "string" ? row.kind : null;
    const entityId = await createSpineRow(
      args.profileId,
      args.schemaKey,
      kindWire,
      args.question.writes_to,
    );
    entityIds.push(entityId);

    let rowHasCost = false;
    const labelParts: string[] = [];
    for (const [key, value] of values) {
      await writeField(
        args.profileId,
        createField<unknown>({
          id: fieldId(`${prefix}.${entityId}.${key}`),
          value,
          status: "answered",
          confidence: 0.75,
          source: { kind: "owner_input" },
          observed_at: at,
          recorded_at: at,
          note: null,
        }),
      );
      if (COST_KEYS.has(key)) rowHasCost = true;
      if (NAME_KEYS.includes(key) && labelParts.length === 0) {
        labelParts.push(String(value));
      }
      if (key === "price" || key === "amount") {
        const m = value as Money;
        labelParts.push(`${presentAmount(m, "en")} ${m.currency}`);
      }
    }
    if (rowHasCost) rowsWithCosts++;
    detail.push(labelParts.join(" · ") || `Row ${entityIds.length}`);
  }

  await writeField(
    args.profileId,
    createField<unknown>({
      id: fieldId(args.question.writes_to),
      value: { entity_ids: entityIds },
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note: null,
    }),
  );

  return {
    entity_ids: entityIds,
    rows_with_costs: rowsWithCosts,
    detail,
    noun: NOUNS[args.schemaKey] ?? "items",
  };
}

/** "4 products · 3 with costs" — the collapsed chip line (P0-70). */
export function entityChipDisplay(result: EntityWriteResult): string {
  const head = `${result.entity_ids.length} ${result.noun}`;
  return result.rows_with_costs > 0 ? `${head} · ${result.rows_with_costs} with costs` : head;
}
