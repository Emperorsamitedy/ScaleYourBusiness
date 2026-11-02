// A recorded fact's label and coded value in a person's language — L-3a of
// TASKS-LANGUAGES.md.
//
// English screens name a fact by its humanised key ("monthly revenue",
// components/report/figures keyWords) and print a vocabulary code as its
// humanised code ("social organic"), exactly as they always have: for
// English every answer here is null and the screen keeps its own words.
// In another language the words come from the bank's overlay (./words):
// the label is the prompt of the question that writes the key, or for an
// entity's field ("offers.<id>.price") the entity's name and the field's
// own prompt; a coded value is the option's label. Nothing is stored or
// changed (rule 4 of the plan): this only names what is already on file.
//
// The structure (which question writes which key, which vocabulary a
// field uses) is the bank bundled with the build, as lib/ops does; the
// words are the overlay of the current bank version.

import bank from "../../specs/question-bank-v1.json";
import type { BankWords } from "./words";

interface RawInput {
  type: string;
  vocabulary_id?: string;
  entity_schema?: string;
  option_labels?: Record<string, { en?: string }>;
}
interface RawQuestion {
  id: string;
  writes_to: string;
  prompt: { en?: string };
  input: RawInput;
}
interface RawSchema {
  label: { en?: string };
  fields: { key: string; prompt: { en?: string }; input: RawInput }[];
}

const QUESTIONS = (bank as unknown as { questions: RawQuestion[] }).questions;
const SCHEMAS = (bank as unknown as { entity_schemas: Record<string, RawSchema> }).entity_schemas;

const byKey = new Map(QUESTIONS.map((q) => [q.writes_to, q]));
/** An entity collection ("offers", "costs") → its schema, from the entity_list questions. */
const schemaOfCollection = new Map<string, string>();
for (const q of QUESTIONS) {
  if (q.input.type !== "entity_list" || !q.input.entity_schema) continue;
  const collection = q.writes_to.split(".")[0] ?? q.writes_to;
  if (!schemaOfCollection.has(collection))
    schemaOfCollection.set(collection, q.input.entity_schema);
}

const ENTITY_KEY =
  /^([a-z_]+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(.+)$/;

export interface FactWords {
  /**
   * The fact's label in the language — null in English, or for a key no
   * bank question or entity field writes (the screen's own words then).
   * `entityName` is the entity's own name, when known ("Mug").
   */
  label(key: string, entityName?: string | null): string | null;
  /** A coded value's words (an option label, or several joined) — null when it isn't a code. */
  value(key: string, value: unknown): string | null;
  /**
   * The same for a value the server already humanised (lib/profile/factsheet
   * repr: "social organic", "a, b"): read back to its codes, and worded only
   * when the overlay knows every one of them — owner text never matches.
   */
  textValue(key: string, text: string | null): string | null;
  /** An entity field's own words, by the entity's spine ("offers") or collection, and field key. */
  field(spine: string, field: string): string | null;
  /** An entity's kind in the language ("Product or service"), by spine or collection. */
  entity(spine: string): string | null;
}

const NONE: FactWords = {
  label: () => null,
  value: () => null,
  textValue: () => null,
  field: () => null,
  entity: () => null,
};

/** The fact sheet's entity spines (lib/profile/factsheet) → their schema. */
const SPINE_SCHEMA: Readonly<Record<string, string>> = {
  offers: "offer",
  suppliers: "supplier",
  competitors: "competitor",
  channels: "channel",
  staff_roles: "staff_role",
  cost_items: "cost_item",
  customer_segments: "customer_segment",
  goals: "goal",
};

const schemaOf = (spine: string): string | undefined =>
  SPINE_SCHEMA[spine] ?? schemaOfCollection.get(spine);

/** A humanised code back to its code: "social organic" → "social_organic". */
const CODE_TEXT = /^[a-z0-9]+( [a-z0-9]+)*$/;

/** A stored choice's codes: "b2c", ["a", "b"], { code } or [{ code }, …] (a multi-select). */
function codesOf(value: unknown): string[] | null {
  const one = (v: unknown): string | null => {
    if (typeof v === "string") return v;
    if (typeof v === "object" && v !== null) {
      const code = (v as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    return null;
  };
  const list = Array.isArray(value) ? value.map(one) : [one(value)];
  return list.length > 0 && list.every((c): c is string => c !== null) ? list : null;
}

/** Pure: the fact words of one language's bank words; English names nothing. */
export function factWords(words: BankWords): FactWords {
  if (words.locale === "en") return NONE;

  const fieldOf = (key: string) => {
    const m = ENTITY_KEY.exec(key);
    if (!m) return null;
    const schemaId = schemaOfCollection.get(m[1] ?? "");
    const schema = schemaId ? SCHEMAS[schemaId] : undefined;
    const field = schema?.fields.find((f) => f.key === m[3]);
    return schemaId && schema && field ? { schemaId, schema, field } : null;
  };

  const optionWords = (
    input: RawInput,
    codes: string[],
    questionId: string | undefined,
  ): string | null => {
    const vocabulary = input.vocabulary_id;
    if (!vocabulary) return null;
    const out: string[] = [];
    for (const code of codes) {
      const w = words.option(vocabulary, code, "", questionId);
      if (w === "") return null;
      out.push(w);
    }
    return out.length > 0 ? out.join(", ") : null;
  };

  return {
    label(key, entityName) {
      const q = byKey.get(key);
      if (q) return words.prompt(q.id, q.prompt.en ?? "") || null;
      const f = fieldOf(key);
      if (!f) return null;
      const name =
        entityName && entityName.trim() !== ""
          ? entityName
          : words.entityLabel(f.schemaId, f.schema.label.en ?? "");
      const field = words.entityField(f.schemaId, f.field.key, f.field.prompt.en ?? "");
      return name && field ? `${name} · ${field}` : null;
    },
    value(key, value) {
      const codes = codesOf(value);
      if (!codes) return null;
      const q = byKey.get(key);
      if (q) return optionWords(q.input, codes, q.id);
      const f = fieldOf(key);
      return f ? optionWords(f.field.input, codes, undefined) : null;
    },
    textValue(key, text) {
      if (text === null) return null;
      const parts = text.split(", ");
      if (!parts.every((p) => CODE_TEXT.test(p))) return null;
      return this.value(
        key,
        parts.map((p) => p.replace(/ /g, "_")),
      );
    },
    field(spine, field) {
      const schemaId = schemaOf(spine);
      const f = schemaId ? SCHEMAS[schemaId]?.fields.find((x) => x.key === field) : undefined;
      return schemaId && f ? words.entityField(schemaId, field, f.prompt.en ?? "") || null : null;
    },
    entity(spine) {
      const schemaId = schemaOf(spine);
      const s = schemaId ? SCHEMAS[schemaId] : undefined;
      return schemaId && s ? words.entityLabel(schemaId, s.label.en ?? "") || null : null;
    },
  };
}

/**
 * Pure: a fact map (the report's, lib/report/service) with each fact's
 * `label` and `value_words` in the language. English returns the map as
 * it was, so an English response is byte-for-byte what it always was.
 */
export function labelFactMap<T extends { value: string | null }>(
  map: Record<string, T>,
  fw: FactWords,
): Record<string, T & { label?: string | null; value_words?: string | null }> {
  if (fw === NONE) return map;
  const out: Record<string, T & { label?: string | null; value_words?: string | null }> = {};
  for (const [key, f] of Object.entries(map)) {
    const entity = ENTITY_KEY.exec(key);
    const name = entity ? map[`${entity[1]}.${entity[2]}.name`]?.value : null;
    out[key] = {
      ...f,
      label: fw.label(key, name ?? null),
      value_words: fw.textValue(key, f.value),
    };
  }
  return out;
}

/** Pure: an entity field's coded value, by spine and field key, for the fact sheet's entity rows. */
export function entityTextValue(
  fw: FactWords,
  spine: string,
  field: string,
  text: string | null,
): string | null {
  // A made-up entity key in the collection's shape reaches the same field lookup.
  const collection =
    [...schemaOfCollection.entries()].find(([, s]) => s === schemaOf(spine))?.[0] ?? spine;
  return fw.textValue(`${collection}.00000000-0000-0000-0000-000000000000.${field}`, text);
}
