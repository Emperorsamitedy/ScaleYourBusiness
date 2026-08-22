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
import type { InputSpec } from "../interviewer/harness/answers";
import { coerceParsedValue } from "../parser/coerce";
import { writeField } from "../profile/field-store";
import type { ApplicableQuestion } from "../resolver/applicability";
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

/** Load an entity schema's fields from the current bank. */
export async function loadEntityFields(
  schemaKey: string,
  optionsFor: (spec: InputSpec) => Promise<IntakeOption[]>,
  currency: string,
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
      prompt: (f.prompt?.en ?? f.key).trim(),
      input_type: f.input.type,
      options: await optionsFor(f.input),
      priority: f.priority ?? "important",
      currency,
      input: f.input,
    })),
  );
}

async function createSpineRow(
  profileId: string,
  schemaKey: string,
  kindCode: string | null,
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
      const [r] = await db
        .insert(costItems)
        .values({ profile_id: profileId, bucket: "fixed" })
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

  for (const row of args.rows) {
    const kindWire = typeof row.kind === "string" ? row.kind : null;
    const entityId = await createSpineRow(args.profileId, args.schemaKey, kindWire);
    entityIds.push(entityId);

    let rowHasCost = false;
    const labelParts: string[] = [];
    for (const [key, wire] of Object.entries(row)) {
      if (wire === null || wire === undefined || wire === "") continue;
      const field = byKey.get(key);
      if (!field) continue;
      if (args.schemaKey === "offer" && key === "kind") continue; // spine column
      const coerced = coerceParsedValue(
        field.input,
        wire,
        field.options.map((o) => o.code),
        args.currency,
      );
      if (!coerced.ok) {
        throw Object.assign(new Error(`${field.prompt}: ${coerced.reason}`), { status: 422 });
      }
      await writeField(
        args.profileId,
        createField<unknown>({
          id: fieldId(`${prefix}.${entityId}.${key}`),
          value: coerced.value,
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
        labelParts.push(String(wire));
      }
      if (key === "price" || key === "amount") {
        const m = coerced.value as Money;
        labelParts.push(
          `${new Intl.NumberFormat("en-GB").format(m.amount_minor / 100)} ${m.currency}`,
        );
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
