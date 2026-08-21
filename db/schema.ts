// Database schema, defined table by table as the sessions land:
// profile tables in Session D, supersession in E, vocabularies in F,
// the decision log in G.
//
// Session E note: supersession requires the partial unique index
//   UNIQUE (profile_id, field_key) WHERE superseded_at IS NULL
// expressed as uniqueIndex(...).where(...) — round-trip verified against
// live Postgres before Session B (generate → apply → generate is a no-op).

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Identity and account structures — data-model-v1.md §4.
//
// One account holds exactly one business profile in v1; the one-to-one is a
// single foreign key (business_profiles.account_id, UNIQUE) rather than a
// redundant pair of pointers that could drift — the spec's
// account.business_profile_id is served by the reverse lookup.
// ---------------------------------------------------------------------------

export const accountPlan = pgEnum("account_plan", ["trial", "starter", "pro"]);

export const userRole = pgEnum("user_role", ["owner", "manager", "viewer"]);

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  // Circular with users.account_id — drizzle emits this one as ALTER TABLE.
  owner_user_id: uuid("owner_user_id").references((): AnyPgColumn => users.id),
  plan: accountPlan("plan").notNull().default("trial"),
  /** "hu-HU", "en-GB" — drives intake language. */
  locale: text("locale").notNull().default("en-GB"),
  /** ISO 4217 — aggregates state their currency; see lib/core/money.ts. */
  reporting_currency: text("reporting_currency").notNull(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    email: text("email").notNull(),
    display_name: text("display_name").notNull(),
    role: userRole("role").notNull(),
    // Shape unspecified in the v1 spec (§4 names the type only) — typed
    // when notifications exist; JSONB so adding keys is not a migration.
    notification_prefs: jsonb("notification_prefs").notNull().default({}),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const businessProfiles = pgTable("business_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  // UNIQUE: the v1 one-account-one-profile invariant, held by the database.
  account_id: uuid("account_id")
    .notNull()
    .unique()
    .references(() => accounts.id),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  last_material_change: timestamp("last_material_change", { withTimezone: true, mode: "string" }),
  /** Data-model version this profile was written against. */
  schema_version: text("schema_version").notNull(),
});

// ---------------------------------------------------------------------------
// field_records — the storage form of Field<T> (§3.1) for every one of the
// fourteen §5.1 sections.
//
// The spec's section interfaces (IdentitySection, RevenueSection, …)
// describe the ASSEMBLED profile; storage is one generic table keyed by
// field_key path ("identity.legal_name", "offers.<offer_id>.price").
// One table means one supersession mechanism (rule 3): the partial unique
// index below — round-trip-verified before Session B — lets the database
// itself guarantee at most one current record per field while keeping
// every superseded record as history. Typed-columns-per-section would need
// that machinery re-invented per table.
//
// Session E adds the write path that supersedes; nothing may UPDATE a
// record's value — ever.
// ---------------------------------------------------------------------------

export const fieldStatus = pgEnum("field_status", [
  "answered",
  "unknown",
  "not_applicable",
  "skipped",
  "inferred",
  "unasked",
]);

export const profileSection = pgEnum("profile_section", [
  "identity",
  "presence",
  "offers",
  "revenue",
  "costs",
  "customers",
  "channels",
  "marketing",
  "operations",
  "tooling",
  "legal",
  "competitors",
  "goals",
  "assets",
]);

export const fieldRecords = pgTable(
  "field_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id),
    /** First segment of field_key, denormalised for section-level queries. */
    section: profileSection("section").notNull(),
    /** Stable path, e.g. "identity.legal_name", "offers.<offer_id>.price". */
    field_key: text("field_key").notNull(),
    /** The typed value as JSON; null for unknown/skipped/unasked/not_applicable. */
    value: jsonb("value"),
    status: fieldStatus("status").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    /** SourceRef (§3.2 + conversation) as JSON — validated in code. */
    source: jsonb("source").notNull(),
    observed_at: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    note: text("note"),
    superseded_at: timestamp("superseded_at", { withTimezone: true, mode: "string" }),
    superseded_by: uuid("superseded_by").references((): AnyPgColumn => fieldRecords.id),
  },
  (t) => [
    // Rule 3's enforcement: at most one CURRENT record per field per
    // profile; history rows keep their key with superseded_at set.
    uniqueIndex("field_records_current_idx")
      .on(t.profile_id, t.field_key)
      .where(sql`superseded_at IS NULL`),
    index("field_records_profile_section_idx").on(t.profile_id, t.section),
  ],
);

// ---------------------------------------------------------------------------
// Offers — §5.3. One entity with type-specific extensions; "a single offer
// table with variants is dramatically easier to query than three parallel
// structures". The spine holds identity + kind; every owner-answerable
// attribute (price, margin, inventory, churn, …) is a field_record under
// "offers.<offer_id>.…", so offer facts supersede exactly like profile
// facts. Which detail namespace (physical/service/digital) is legal for a
// kind is enforced in lib/profile/offer.ts.
// ---------------------------------------------------------------------------

export const offerKind = pgEnum("offer_kind", [
  "physical",
  "service",
  "digital",
  "subscription",
  "marketplace_access",
]);

export const offers = pgTable(
  "offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id),
    kind: offerKind("kind").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("offers_profile_idx").on(t.profile_id)],
);

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
