// Deterministic persona answering — P0-52.
//
// No LLM anywhere here (cost rule: never call a model for what
// deterministic code can do — synthetic owners doubly so). Given a
// question's InputSpec, produce a correctly TYPED value: Money as minor
// units, selects as EnumValues from the real vocabulary, entity lists as
// spine rows plus a marker record. Session M owns free-text parsing;
// this file bypasses it by construction.

import { db } from "../../../db";
import {
  channels,
  competitors,
  costItems,
  customerSegments,
  goals,
  offers,
  staffRoles,
  suppliers,
} from "../../../db/schema";
import { enumValue } from "../../core/enum-value";
import { createField } from "../../core/field";
import type { FieldStatus } from "../../core/field-status";
import { fieldId } from "../../core/ids";
import { isoDateTime } from "../../core/iso";
import { money } from "../../core/money";
import { dynamicVocabularyOptions, isDynamicVocabulary } from "../../profile/dynamic-vocab";
import { writeField } from "../../profile/field-store";
import type { ApplicableQuestion } from "../../resolver/applicability";
import { vocabularyCodes } from "../../vocab/validate";
import type { Persona } from "./personas";

export interface InputSpec {
  type:
    | "text"
    | "long_text"
    | "number"
    | "money"
    | "boolean"
    | "date"
    | "single_select"
    | "multi_select"
    | "entity_list"
    | "file";
  vocabulary_id?: string;
  entity_schema?: string;
  allow_unknown?: boolean;
}

export class HarnessAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessAnswerError";
  }
}

export interface AnswerOutcome {
  status: FieldStatus;
  repr: string;
  entities_created: number;
}

const OFFER_KIND_BY_SELLS: Readonly<
  Record<string, "physical" | "service" | "digital" | "subscription" | "marketplace_access">
> = {
  physical_products: "physical",
  services: "service",
  software: "digital",
  digital_products: "digital",
  subscriptions: "subscription",
  marketplace_access: "marketplace_access",
};

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new HarnessAnswerError("pick from empty list");
  return item;
}

async function selectCodes(profileId: string, vocabularyId: string | undefined): Promise<string[]> {
  if (vocabularyId === undefined) throw new HarnessAnswerError("select without vocabulary_id");
  // "__offers__", "__channels__", … — the owner's own entities by spine id.
  if (isDynamicVocabulary(vocabularyId)) {
    const options = await dynamicVocabularyOptions(profileId, vocabularyId);
    if (options.length === 0) throw new HarnessAnswerError(`dynamic ${vocabularyId} has no rows`);
    return options.map((o) => o.code);
  }
  const codes = await vocabularyCodes(vocabularyId);
  const usable = codes.filter((c) => c !== "other");
  if (usable.length === 0) throw new HarnessAnswerError(`vocabulary ${vocabularyId} empty`);
  return usable;
}

async function createEntities(
  profileId: string,
  schema: string,
  persona: Persona,
  rng: () => number,
): Promise<string[]> {
  const twoOrOne = 1 + (rng() < 0.5 ? 1 : 0);
  switch (schema) {
    case "offer": {
      const kinds = persona.sells.slice(0, 3).map((s) => {
        const kind = OFFER_KIND_BY_SELLS[s];
        if (!kind) throw new HarnessAnswerError(`no offer kind for sells code ${s}`);
        return kind;
      });
      const rows = await db
        .insert(offers)
        .values(kinds.map((kind) => ({ profile_id: profileId, kind })))
        .returning({ id: offers.id });
      return rows.map((r) => r.id);
    }
    case "supplier": {
      const rows = await db
        .insert(suppliers)
        .values(Array.from({ length: twoOrOne }, () => ({ profile_id: profileId })))
        .returning({ id: suppliers.id });
      return rows.map((r) => r.id);
    }
    case "channel": {
      const rows = await db
        .insert(channels)
        .values(Array.from({ length: twoOrOne }, () => ({ profile_id: profileId })))
        .returning({ id: channels.id });
      return rows.map((r) => r.id);
    }
    case "competitor": {
      const rows = await db
        .insert(competitors)
        .values(
          Array.from({ length: twoOrOne }, () => ({
            profile_id: profileId,
            source: { kind: "owner_input" },
          })),
        )
        .returning({ id: competitors.id });
      return rows.map((r) => r.id);
    }
    case "staff_role": {
      const rows = await db
        .insert(staffRoles)
        .values([
          { profile_id: profileId, is_owner: true },
          ...Array.from({ length: Math.max(0, Math.min(2, persona.teamSize - 1)) }, () => ({
            profile_id: profileId,
            is_owner: false,
          })),
        ])
        .returning({ id: staffRoles.id });
      return rows.map((r) => r.id);
    }
    case "cost_item": {
      const rows = await db
        .insert(costItems)
        .values([
          { profile_id: profileId, bucket: "fixed" as const, scales_with_sales: false },
          { profile_id: profileId, bucket: "variable" as const, scales_with_sales: true },
        ])
        .returning({ id: costItems.id });
      return rows.map((r) => r.id);
    }
    case "customer_segment": {
      const rows = await db
        .insert(customerSegments)
        .values(Array.from({ length: twoOrOne }, () => ({ profile_id: profileId })))
        .returning({ id: customerSegments.id });
      return rows.map((r) => r.id);
    }
    case "goal": {
      const rows = await db
        .insert(goals)
        .values(Array.from({ length: twoOrOne }, () => ({ profile_id: profileId })))
        .returning({ id: goals.id });
      return rows.map((r) => r.id);
    }
    default:
      throw new HarnessAnswerError(`unknown entity schema "${schema}"`);
  }
}

function syntheticValue(
  key: string,
  spec: InputSpec,
  persona: Persona,
  rng: () => number,
  codes: readonly string[],
): unknown {
  switch (spec.type) {
    case "text":
      return `${persona.name}: ${key.split(".").pop() ?? key}`;
    case "long_text":
      return `Synthetic detail for ${key} from ${persona.name}. Two short sentences, enough to be realistic.`;
    case "number": {
      if (key === "identity.team_size") return persona.teamSize;
      if (key.includes("rate") || key.includes("conversion")) return Math.round(rng() * 60) / 100;
      if (key.includes("count") || key.includes("orders") || key.includes("users"))
        return 10 + Math.floor(rng() * 400);
      return 1 + Math.floor(rng() * 40);
    }
    case "money":
      return money((10_000 + Math.floor(rng() * 790_000)) * 100, "HUF");
    case "boolean":
      return rng() < 0.5;
    case "date":
      return "2022-06-01";
    case "single_select":
      return enumValue(pick(rng, codes));
    case "multi_select": {
      const n = 1 + Math.floor(rng() * Math.min(3, codes.length));
      const shuffled = [...codes].sort(() => rng() - 0.5);
      return shuffled.slice(0, n).map((c) => enumValue(c));
    }
    default:
      throw new HarnessAnswerError(`no synthesizer for input type "${spec.type}"`);
  }
}

function overrideValue(
  override: NonNullable<Persona["overrides"][string]>,
): { value: unknown } | { unknown: true } {
  if ("unknown" in override) return { unknown: true };
  if ("code" in override) return { value: enumValue(override.code) };
  if ("codes" in override) return { value: override.codes.map((c) => enumValue(c)) };
  return { value: override.value };
}

function reprOf(value: unknown, status: FieldStatus): string {
  if (status !== "answered") return status;
  const s = JSON.stringify(value);
  return s === undefined ? "null" : s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** Answer one question as the persona; writes to the profile; returns what happened. */
export async function answerQuestion(
  profileId: string,
  persona: Persona,
  question: ApplicableQuestion,
  rng: () => number,
): Promise<AnswerOutcome> {
  const spec = question.input as InputSpec;
  const key = question.writes_to;
  const at = isoDateTime(new Date().toISOString());

  const write = async (value: unknown, status: FieldStatus): Promise<void> => {
    await writeField(
      profileId,
      createField<unknown>({
        id: fieldId(key),
        value: status === "answered" ? value : null,
        status,
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: at,
        recorded_at: at,
        note: null,
      }),
    );
  };

  // Entity lists: create the spine rows, then the marker record.
  if (spec.type === "entity_list") {
    if (!spec.entity_schema)
      throw new HarnessAnswerError(`entity_list ${question.id} without schema`);
    const ids = await createEntities(profileId, spec.entity_schema, persona, rng);
    await write({ entity_ids: ids }, "answered");
    return {
      status: "answered",
      repr: `${ids.length}×${spec.entity_schema}`,
      entities_created: ids.length,
    };
  }

  // Persona-pinned answers first.
  const override = persona.overrides[key];
  if (override) {
    const o = overrideValue(override);
    if ("unknown" in o) {
      await write(null, "unknown");
      return { status: "unknown", repr: "unknown", entities_created: 0 };
    }
    await write(o.value, "answered");
    return { status: "answered", repr: reprOf(o.value, "answered"), entities_created: 0 };
  }

  // Automatic pins for identity's branching trio.
  if (key === "identity.sells") {
    const value = persona.sells.map((c) => enumValue(c));
    await write(value, "answered");
    return { status: "answered", repr: reprOf(value, "answered"), entities_created: 0 };
  }
  if (key === "identity.stage") {
    const value = enumValue(persona.stage);
    await write(value, "answered");
    return { status: "answered", repr: reprOf(value, "answered"), entities_created: 0 };
  }

  const allowUnknown = spec.allow_unknown !== false;

  // Files: synthetic owners never upload; honest unknown/skip instead.
  if (spec.type === "file") {
    const status: FieldStatus = allowUnknown ? "unknown" : "skipped";
    await write(null, status);
    return { status, repr: status, entities_created: 0 };
  }

  // Seeded "I don't know" for the personas that don't track things.
  if (allowUnknown && rng() < persona.unknownRate) {
    await write(null, "unknown");
    return { status: "unknown", repr: "unknown", entities_created: 0 };
  }

  const codes =
    spec.type === "single_select" || spec.type === "multi_select"
      ? await selectCodes(profileId, spec.vocabulary_id)
      : [];
  const value = syntheticValue(key, spec, persona, rng, codes);
  await write(value, "answered");
  return { status: "answered", repr: reprOf(value, "answered"), entities_created: 0 };
}
