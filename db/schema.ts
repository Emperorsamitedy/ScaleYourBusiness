// Database schema, defined table by table as the sessions land:
// profile tables in Session D, supersession in E, vocabularies in F,
// the decision log in G.
//
// Session E note: supersession requires the partial unique index
//   UNIQUE (profile_id, field_key) WHERE superseded_at IS NULL
// expressed as uniqueIndex(...).where(...) — round-trip verified against
// live Postgres before Session B (generate → apply → generate is a no-op).

import {
  boolean,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const utteranceRole = pgEnum("utterance_role", ["owner", "system"]);

export const utteranceIntent = pgEnum("utterance_intent", [
  "ask",
  "tell",
  "correct",
  "request",
  "limit",
  "social",
]);

// Utterances — conversation-channel.md §2.2 (step 13a). The chat messages
// every conversation-sourced fact points back at. Nothing writes here yet;
// the schema exists now because adding it after facts are flowing means
// migrating every fact already written.
export const utterances = pgTable(
  "utterances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // FK to the business profile root lands in Session D with the table it
    // points at; the column is here from day one so no backfill is needed.
    profile_id: uuid("profile_id").notNull(),
    thread_id: uuid("thread_id").notNull(),
    role: utteranceRole("role").notNull(),
    text: text("text").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull(),
    // Owner turns only — classified by Haiku in Phase 2, null until then.
    intent: utteranceIntent("intent"),
    // FieldIds this message wrote, if any.
    extracted_fields: jsonb("extracted_fields").$type<string[]>().notNull().default([]),
    confirmed: boolean("confirmed").notNull().default(false),
    // Per-message cost for the §6 monthly cap. Operational metering, not Money.
    cost_eur: numeric("cost_eur", { precision: 12, scale: 6 }).notNull().default("0"),
  },
  (t) => [
    index("utterances_profile_idx").on(t.profile_id),
    index("utterances_thread_at_idx").on(t.thread_id, t.at),
  ],
);
