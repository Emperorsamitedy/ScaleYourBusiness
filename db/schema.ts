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
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
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
  /**
   * P3-40b: SYB's own business, run through its own product. Excluded from
   * every cross-customer number (Gate 2's approval rate, the ops funnel and
   * cost views) so our own numbers never pass as customer evidence. Its
   * per-profile scorecard is unaffected.
   */
  internal: boolean("internal").notNull().default(false),
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
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    /**
     * Idea 52: taken off the team. The row stays — proposals, stops and
     * the decision log name it — but it signs in to nothing, and every
     * session it had is revoked in the same act. Re-inviting the address
     * brings this same row back.
     */
    removed_at: timestamp("removed_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    // Idea 52: one email may belong to several businesses, once in each.
    // A person is still one row in ONE account; "at least one owner per
    // account" is a deferred constraint trigger in migration 0070.
    uniqueIndex("users_account_email_idx").on(t.account_id, t.email),
    index("users_email_idx").on(t.email),
  ],
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
  /** Owner opted in to anonymised cross-business benchmarking. Off until said otherwise. */
  benchmark_consent: boolean("benchmark_consent").notNull().default(false),
  /** System judgment that the profile has enough data to benchmark against. */
  benchmark_eligible: boolean("benchmark_eligible").notNull().default(false),
  // The interviewer's last pick, so that reading the intake state does not
  // re-run the interviewer. It is a cache, not a fact: it is honoured only
  // while it is still an open candidate, which makes it self-invalidating —
  // answering the question drops it out of the candidate set and forces
  // exactly one fresh pick. See getIntakeState.
  next_question_id: text("next_question_id"),
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

// ---------------------------------------------------------------------------
// Entity spines — §5.4. Standalone entities referenced by ID; their
// owner-answerable attributes live in field_records under
// "<section>.<entity_id>.<attr>". Structural columns appear only where the
// spec types them outside Field<T>.
// ---------------------------------------------------------------------------

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("suppliers_profile_idx").on(t.profile_id)],
);

/** PhysicalOfferDetail.supplier_ids (§5.3) — which suppliers feed an offer. */
export const offerSuppliers = pgTable(
  "offer_suppliers",
  {
    offer_id: uuid("offer_id")
      .notNull()
      .references(() => offers.id),
    supplier_id: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
  },
  (t) => [uniqueIndex("offer_suppliers_pk").on(t.offer_id, t.supplier_id)],
);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("channels_profile_idx").on(t.profile_id)],
);

export const competitors = pgTable(
  "competitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id),
    // Structural per §5.4 (bare SourceRef, not Field): what the owner
    // BELIEVES about a competitor vs what research FOUND must stay
    // distinguishable — the positioning recommendation depends on it.
    source: jsonb("source").notNull(),
    researched_at: timestamp("researched_at", { withTimezone: true, mode: "string" }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("competitors_profile_idx").on(t.profile_id)],
);

export const staffRoles = pgTable(
  "staff_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id),
    /** Structural per §5.4 — the owner's own role row, not an answer. */
    is_owner: boolean("is_owner").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("staff_roles_profile_idx").on(t.profile_id)],
);

// CostSection (§5.5) splits fixed_monthly from variable as two lists —
// structural membership, so a bucket column rather than a fact.
export const costBucket = pgEnum("cost_bucket", ["fixed", "variable"]);

export const costItems = pgTable(
  "cost_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id),
    bucket: costBucket("bucket").notNull(),
    /** Structural per §5.5 CostItem — typed boolean, not a Field. */
    scales_with_sales: boolean("scales_with_sales").notNull().default(false),
    linked_offer_id: uuid("linked_offer_id").references(() => offers.id),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("cost_items_profile_idx").on(t.profile_id)],
);

export const customerSegments = pgTable(
  "customer_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("customer_segments_profile_idx").on(t.profile_id)],
);

// GoalSection's entries as entities so goals can be referenced, achieved
// and abandoned individually; attributes live under "goals.<id>.…".
export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("goals_profile_idx").on(t.profile_id)],
);

// ---------------------------------------------------------------------------
// Vocabularies — §3.4 / step 16. The 56 controlled lists from the question
// bank, stored verbatim (including their "other" entries) so the database
// mirrors the bank exactly; whether a vocabulary accepts "other" is a fact
// about its entries, not a flag that can drift from them.
// ---------------------------------------------------------------------------

export const vocabularies = pgTable("vocabularies", {
  key: text("key").primaryKey(),
  /** Bank version the entries were loaded from. */
  bank_version: text("bank_version").notNull(),
});

export const vocabularyEntries = pgTable(
  "vocabulary_entries",
  {
    vocab_key: text("vocab_key")
      .notNull()
      .references(() => vocabularies.key),
    code: text("code").notNull(),
    /** Bank order — the intake renders options in this order. */
    position: integer("position").notNull(),
  },
  (t) => [uniqueIndex("vocabulary_entries_pk").on(t.vocab_key, t.code)],
);

// ---------------------------------------------------------------------------
// Decision log — §11, rule 7. Append-only at the database level: migration
// 0010 installs a BEFORE UPDATE OR DELETE (and TRUNCATE) trigger that
// RAISEs. A trigger, not REVOKE — REVOKE doesn't bind the table owner,
// and migrations run as owner, so permission-based protection would be
// absent exactly where it counts.
//
// profile_id is deliberately NOT a foreign key: the audit trail outlives
// its subject. A profile can be removed without touching the log; how log
// entries are handled under a GDPR erasure request is an open decision in
// §12 and must be decided, not defaulted.
// ---------------------------------------------------------------------------

export const decisionActor = pgEnum("decision_actor", ["system", "owner"]);

export const decisionKind = pgEnum("decision_kind", [
  "proposal",
  "approval",
  "rejection",
  "execution",
  "measurement",
  "profile_change",
  "erasure", // Phase 4 rule 22: the fact of an erasure, never its PII
  "import", // Phase 4 P4-03: a contact import batch — hash and counts, no PII
  "takeover", // P3-43: day zero — the business enters care; ref is the frozen snapshot
  "consent", // P3-20h: write access granted (rule 13); ref is the execute connection
  "change_request", // the queue's third answer: not approved, the owner's words on what to change
  "reply_approval", // P4-10: the owner approved a support reply; hash covers the exact text's sha256
  "reply_decline", // P4-10: the owner declined a drafted support reply
  "reply_send", // P4-10: a support reply's send outcome (sent / refused / unknown); ids and hashes only
  "law_review", // P4-15: a person reviewed the jurisdiction table; ref is the jurisdiction_reviews row
  "campaign_approval", // P4-15: the owner approved the exact campaign email; ref is the proposal
  "unsubscribe", // P4-15: a recipient unsubscribed; ref is the campaign_sends row, no PII
  "complaint", // P4-17: a recipient marked a campaign email as spam; ref is the campaign_sends row, no PII
  "assistant_change", // feature 33: the owner confirmed a change the assistant prepared in chat; ref is the assistant_changes row
  "campaign_review", // review 2026-10-23 (#5c): an operator reviewed an account's first campaign; ref is the campaign_reviews row, no PII
  "report_share", // idea 51: the owner made a read-only link to a report; ref is the report_shares row, never the token
  "report_share_revoke", // idea 51: the owner revoked that link; ref is the report_shares row
  "team_invite", // idea 52: an owner invited an address with a role; ref is the team_invites row, never the email or token
  "team_invite_revoke", // idea 52: an owner withdrew a pending invite; ref is the team_invites row
  "team_join", // idea 52: an invite was accepted by its own verified address; ref is the users row
  "team_role", // idea 52: an owner changed a member's role; ref is the users row
  "team_remove", // idea 52: an owner took a member off the team (their sessions revoked); ref is the users row
  "account_switch", // idea 52: a person moved this browser to another business they belong to; ref is the users row
]);

export const decisionLog = pgTable(
  "decision_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    actor: decisionActor("actor").notNull(),
    kind: decisionKind("kind").notNull(),
    /** What the entry is about — e.g. the field_records id of a profile change. */
    ref_id: text("ref_id").notNull(),
    /** sha256 of the canonical payload, so any later tampering is detectable. */
    payload_hash: text("payload_hash").notNull(),
    /**
     * Idea 52: WHICH person acted, now that a business can have several —
     * the users row that approved, declined, invited or switched. Null for
     * the system's own entries and for every entry written before 0070.
     * Not a foreign key, like profile_id: the audit trail outlives its subject.
     */
    user_id: uuid("user_id"),
  },
  (t) => [index("decision_log_profile_at_idx").on(t.profile_id, t.at)],
);

// ---------------------------------------------------------------------------
// Question bank — §6.1 / step 18. Questions and entity schemas are stored
// PER BANK VERSION: loading a new version adds rows, never rewrites old
// ones, so an answer recorded against bank 1.0.0's question 4.2 keeps its
// provenance forever (P0-37). Vocabularies mirror only the current bank
// (Session F) — answers store codes, not entry references, so they
// survive vocabulary evolution.
// ---------------------------------------------------------------------------

export const questionPriority = pgEnum("question_priority", [
  "core",
  "important",
  "deep",
  "optional",
]);

export const bankVersions = pgTable(
  "bank_versions",
  {
    version: text("version").primaryKey(),
    loaded_at: timestamp("loaded_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    /** sha256 of the bank file, for byte-level provenance. */
    source_hash: text("source_hash").notNull(),
    question_count: integer("question_count").notNull(),
    vocabulary_count: integer("vocabulary_count").notNull(),
    entity_schema_count: integer("entity_schema_count").notNull(),
    is_current: boolean("is_current").notNull().default(false),
  },
  (t) => [
    // At most one current bank — same partial-index trick as supersession.
    uniqueIndex("bank_versions_current_idx")
      .on(t.is_current)
      .where(sql`is_current`),
  ],
);

export const bankQuestions = pgTable(
  "bank_questions",
  {
    bank_version: text("bank_version")
      .notNull()
      .references(() => bankVersions.version),
    id: text("id").notNull(),
    /** The question's own version field from the bank. */
    question_version: integer("question_version").notNull(),
    /** Interview-flow section (bank "competition" stored as competitors). */
    section: profileSection("section").notNull(),
    writes_to: text("writes_to").notNull(),
    prompt: jsonb("prompt").notNull(),
    help_text: jsonb("help_text"),
    input: jsonb("input").notNull(),
    condition: jsonb("condition"),
    priority: questionPriority("priority").notNull(),
    cost: integer("cost").notNull(),
    unlocks: jsonb("unlocks"),
  },
  (t) => [uniqueIndex("bank_questions_pk").on(t.bank_version, t.id)],
);

export const bankEntitySchemas = pgTable(
  "bank_entity_schemas",
  {
    bank_version: text("bank_version")
      .notNull()
      .references(() => bankVersions.version),
    key: text("key").notNull(),
    label: jsonb("label").notNull(),
    min_items: integer("min_items"),
    fields: jsonb("fields").notNull(),
  },
  (t) => [uniqueIndex("bank_entity_schemas_pk").on(t.bank_version, t.key)],
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

/* ---------- Session Q — validation (data-model §7, steps 32-34) ---------- */

export const findingKind = pgEnum("finding_kind", ["gap", "contradiction", "implausible", "stale"]);

export const findingSeverity = pgEnum("finding_severity", ["blocking", "high", "medium", "low"]);

/**
 * ValidationFinding — data-model §7. Findings persist with their
 * resolution; both original values stay in field_records history, so a
 * contradiction never destroys evidence. `field_keys` holds the stable
 * field identities involved (record ids churn under supersession).
 */
export const validationFindings = pgTable(
  "validation_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Cascade: findings are derived data — they die with their profile.
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    kind: findingKind("kind").notNull(),
    severity: findingSeverity("severity").notNull(),
    field_keys: jsonb("field_keys").notNull(),
    rule_id: text("rule_id").notNull(),
    /** Version of the rule set that produced this finding (P0-78). */
    rule_version: text("rule_version").notNull(),
    /** LocalizedText — { en: "..." }. */
    message: jsonb("message").notNull(),
    /** FindingResolution | null — { resolved_at, method, note }. */
    resolution: jsonb("resolution"),
    detected_at: timestamp("detected_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One OPEN finding per rule per profile; resolved history accumulates.
    uniqueIndex("validation_findings_open_idx")
      .on(t.profile_id, t.rule_id)
      .where(sql`resolution IS NULL`),
    index("validation_findings_profile_idx").on(t.profile_id),
  ],
);

/* ---------- Session R — intake telemetry (P0-87, steps 35-36) ---------- */

export const intakeEventKind = pgEnum("intake_event_kind", [
  "question_shown",
  "first_input",
  "answer_recorded",
  "marked_unknown",
  "skipped",
  "reopened",
  "reconcile_shown",
  "reconcile_resolved",
  "session_resumed",
  "page_hidden",
  // P1-52 funnel stages — written by the SERVER only; the client event
  // sink refuses them, so a browser cannot forge its own conversion.
  "funnel_intake_started",
  "funnel_core_completed",
  "funnel_report_delivered",
  "funnel_recommendation_response",
]);

/**
 * P0-87: every hesitation, every confusion, the actual abandonment point.
 * Append-only by convention; the analysis (scripts/intake-report.ts) reads
 * it to decide which questions get rewritten in P0-88. `ms_since_shown`
 * is hesitation on first_input, dwell on answer_recorded.
 */
export const intakeEvents = pgTable(
  "intake_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    question_id: text("question_id"),
    kind: intakeEventKind("kind").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    ms_since_shown: integer("ms_since_shown"),
    meta: jsonb("meta"),
  },
  (t) => [index("intake_events_profile_at_idx").on(t.profile_id, t.at)],
);

/* ---------- Phase 1 Session A — profile snapshots (step 37) ---------- */

/**
 * A frozen view of a profile at one instant. A report references a
 * snapshot, never "the profile", so opening a six-month-old report shows
 * the numbers it was actually written from.
 *
 * Storage exploits rule 3: field records are immutable and never deleted,
 * so a snapshot only has to record WHICH records were current — the
 * values themselves need no copying and cannot drift.
 *
 * `content_hash` is over the facts' CONTENT, not their ids: re-snapshotting
 * an unchanged profile yields the same hash, and one changed value changes it.
 */
export const profileSnapshots = pgTable(
  "profile_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    taken_at: timestamp("taken_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    content_hash: text("content_hash").notNull(),
    fact_count: integer("fact_count").notNull(),
    entity_count: integer("entity_count").notNull(),
    /** Why it was taken: "report", "watching_weekly", "manual". */
    reason: text("reason").notNull().default("manual"),
    /** [{spine, id, kind}] — the entity rows alive at that instant. */
    entities: jsonb("entities").notNull(),
  },
  (t) => [index("profile_snapshots_profile_idx").on(t.profile_id, t.taken_at)],
);

/** Which field records the snapshot froze. Membership only — see above. */
export const snapshotRecords = pgTable(
  "snapshot_records",
  {
    snapshot_id: uuid("snapshot_id")
      .notNull()
      .references(() => profileSnapshots.id, { onDelete: "cascade" }),
    record_id: uuid("record_id")
      .notNull()
      .references(() => fieldRecords.id),
  },
  (t) => [uniqueIndex("snapshot_records_pk").on(t.snapshot_id, t.record_id)],
);

/* ---------- Phase 1 Session D — first contact (P1-56/57) ---------- */

/**
 * A way back in. Identity in Phase 1 is deliberately thin: an email and
 * a signed link, never a password — an owner halfway through an intake
 * on a market stall will not create an account, and a lost cookie must
 * not cost them twenty minutes of answers.
 *
 * The token itself is never stored; only its sha256. A leaked database
 * row cannot be replayed as a login.
 */
export const resumeTokens = pgTable(
  "resume_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    /** sha256 of the token handed to the owner. */
    token_hash: text("token_hash").notNull(),
    email: text("email").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    /** Set the first time it is used; a link keeps working until it expires. */
    last_used_at: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    /** Revoked links stop resolving without being deleted. */
    revoked_at: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("resume_tokens_hash_idx").on(t.token_hash),
    index("resume_tokens_profile_idx").on(t.profile_id),
  ],
);

// ---------------------------------------------------------------------------
// Diagnosis reports — Session G (P1-34). A report is generated FROM a
// snapshot and stores the snapshot id, never live-profile references:
// re-reading it years later shows exactly what the diagnosis saw. The
// jsonb blocks are the validated outputs of Sessions B/E/F — every number
// in them was computed or evidence-checked in code before landing here.
// Recommendation responses mutate the jsonb status in place, but every
// response ALSO appends to the append-only decision log (P1-39) — the
// report row is the current view, the log is the history.
// ---------------------------------------------------------------------------

export const diagnosisReports = pgTable(
  "diagnosis_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    snapshot_id: uuid("snapshot_id")
      .notNull()
      .references(() => profileSnapshots.id),
    generated_at: timestamp("generated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    /** Three plain sentences (§7), trimmed in code. */
    summary: text("summary").notNull(),
    completeness: numeric("completeness").notNull(),
    cost_eur: numeric("cost_eur").notNull(),
    unit_economics: jsonb("unit_economics").notNull(),
    findings: jsonb("findings").notNull(),
    recommendations: jsonb("recommendations").notNull(),
    data_gaps: jsonb("data_gaps").notNull(),
    /** P2-30: deterministic trading-hours findings; null when no hours or hourly sales are measured. */
    trading_hours: jsonb("trading_hours"),
  },
  (t) => [index("diagnosis_reports_profile_idx").on(t.profile_id, t.generated_at)],
);

// ---------------------------------------------------------------------------
// Report shares — idea 51 (2026-10-26). A read-only link to ONE report, for
// a partner, an accountant or an investor. The link is a snapshot: it is
// pinned to the report it was made for (and the history shown with it stops
// at created_at), so a later report or correction never reaches a reader
// the owner sent it to before. Only sha256(token) is stored, like every
// other link in this app; a row is never deleted, only revoked or expired.
// ---------------------------------------------------------------------------

export const reportShares = pgTable(
  "report_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    /** The frozen report this link shows — never "the latest". */
    report_id: uuid("report_id")
      .notNull()
      .references(() => diagnosisReports.id, { onDelete: "cascade" }),
    /** sha256 of the token in the link. Never the token itself. */
    token_hash: text("token_hash").notNull(),
    created_by: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    /** Revoked links stop resolving without being deleted. */
    revoked_at: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    last_viewed_at: timestamp("last_viewed_at", { withTimezone: true, mode: "string" }),
    view_count: integer("view_count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("report_shares_hash_idx").on(t.token_hash),
    index("report_shares_profile_idx").on(t.account_id, t.profile_id, t.created_at),
    check("report_shares_expiry_after_creation", sql`${t.expires_at} > ${t.created_at}`),
  ],
);

// ---------------------------------------------------------------------------
// Auth — Session I (P1-49). The resume-token philosophy, promoted to the
// account: an email and a signed link, no password, only hashes at rest.
// A login token is short-lived and single-purpose; redeeming it mints an
// auth session (long-lived) AND re-points the intake cookie at the
// account's profile, so every existing route keeps working untouched.

export const loginTokens = pgTable(
  "login_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    /** sha256 of the token in the emailed link. Never the token itself. */
    token_hash: text("token_hash").notNull(),
    /** The profile the browser held when asking to log in, if any —
     * redeeming binds this profile's account to the email. */
    profile_id: uuid("profile_id").references(() => businessProfiles.id, {
      onDelete: "set null",
    }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    /** A login token is one-shot: set on redeem, checked on redeem. */
    used_at: timestamp("used_at", { withTimezone: true, mode: "string" }),
    /**
     * Idea 52: a sign-in link asked for from an invite. Redeeming it joins
     * that invite's business — only when the invite's address is exactly
     * this token's address, and the invite is still open.
     */
    invite_id: uuid("invite_id").references((): AnyPgColumn => teamInvites.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("login_tokens_hash_idx").on(t.token_hash),
    index("login_tokens_email_idx").on(t.email),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token_hash: text("token_hash").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("auth_sessions_hash_idx").on(t.token_hash),
    index("auth_sessions_account_idx").on(t.account_id),
  ],
);

// Idea 52: an invite into ONE business, with a role. The token is the
// link's credential for WHICH invite — never for who you are: joining
// also needs a sign-in proven for exactly this address. Only sha256 of
// the token is stored; one use (accepted_at), seven days, revocable.
export const teamInvites = pgTable(
  "team_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Normalised (lower-case, trimmed), compared exactly. */
    email: text("email").notNull(),
    role: userRole("role").notNull(),
    /** sha256 of the token in the invite link. Never the token itself. */
    token_hash: text("token_hash").notNull(),
    invited_by: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    accepted_at: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    /** The users row the invite became, once accepted. */
    accepted_user_id: uuid("accepted_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revoked_at: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("team_invites_hash_idx").on(t.token_hash),
    // At most one open invite per address per business: a new invite
    // replaces the old one (revoking it) in one transaction.
    uniqueIndex("team_invites_open_idx")
      .on(t.account_id, t.email)
      .where(sql`${t.accepted_at} IS NULL AND ${t.revoked_at} IS NULL`),
    check("team_invites_expiry_after_creation", sql`${t.expires_at} > ${t.created_at}`),
    check(
      "team_invites_accepted_or_revoked",
      sql`${t.accepted_at} IS NULL OR ${t.revoked_at} IS NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Payments — Session I (P1-50). One row per checkout attempt; the paid
// status is only ever set by the verified Stripe webhook, never by a
// redirect URL a browser can fabricate.

export const paymentStatus = pgEnum("payment_status", ["pending", "paid", "failed", "expired"]);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id),
    provider: text("provider").notNull().default("stripe"),
    /**
     * Stripe Checkout Session id — the join key for the webhook. I-52a: one
     * session can pay for several businesses, one row each.
     */
    checkout_session_id: text("checkout_session_id").notNull(),
    amount_minor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    paid_at: timestamp("paid_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("payments_checkout_profile_idx").on(t.checkout_session_id, t.profile_id),
    index("payments_checkout_idx").on(t.checkout_session_id),
    index("payments_profile_idx").on(t.profile_id, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Per-call LLM cost telemetry — Session I (P1-51). The structured
// llm_call log line, persisted. Vercel keeps no function-log history,
// which made every cost figure of the pilot an estimate reconstructed
// by hand; this table makes "what did this onboarding cost" a query.
// Append-only by convention: rows are facts about calls that happened.

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    account_id: uuid("account_id").notNull(),
    /** "interviewer" | "parser" | "diagnosis" | "research" — budget line. */
    workload: text("workload").notNull(),
    model: text("model").notNull(),
    duration_ms: integer("duration_ms").notNull(),
    input_tokens: integer("input_tokens").notNull(),
    output_tokens: integer("output_tokens").notNull(),
    cache_creation_input_tokens: integer("cache_creation_input_tokens").notNull(),
    cache_read_input_tokens: integer("cache_read_input_tokens").notNull(),
    /** Euro cost at the day's prices; 6 decimals holds sub-cent calls. */
    cost_eur: numeric("cost_eur", { precision: 10, scale: 6 }).notNull(),
  },
  (t) => [index("llm_calls_account_at_idx").on(t.account_id, t.at)],
);

// ---------------------------------------------------------------------------
// Mode decision — Session H (P1-42..45), data-model §9. The decision
// row stores the exact inputs that produced it, which is what makes it
// auditable: the screen shows THESE, not generated prose. New decisions
// append; the latest by decided_at is current. The owner override is
// asymmetric by design — extend freely, shorten only with a stored
// acknowledgement.

export const modeKind = pgEnum("mode_kind", ["instant", "watching"]);

export const modeDecisions = pgTable(
  "mode_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    mode: modeKind("mode").notNull(),
    /** 4 | 6 | 8 for watching; null for instant. */
    watch_weeks: integer("watch_weeks"),
    decided_at: timestamp("decided_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    /** ModeDecisionInputs, verbatim — the audit trail. */
    inputs: jsonb("inputs").notNull(),
    /** Deterministic template text, assembled from the inputs. */
    reasoning: text("reasoning").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    /** OwnerOverride | null — extend freely, shorten with acknowledgement. */
    owner_override: jsonb("owner_override"),
    review_at: timestamp("review_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [index("mode_decisions_profile_idx").on(t.profile_id, t.decided_at)],
);

// ---------------------------------------------------------------------------
// Watch activity — Session H (P1-46/47). The honest log: every row is
// real work performed (a snapshot taken, a diff computed, a question
// queued). Nothing is ever inserted to look busy — the ux-spec is
// explicit that manufactured delay poisons every honest thing the
// product has said.

export const watchActivity = pgTable(
  "watch_activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    /** "snapshot_taken" | "diff_computed" | "watch_started" | ... */
    kind: text("kind").notNull(),
    /** Owner-readable one-liner: "Weekly snapshot: 3 fields changed". */
    detail: text("detail").notNull(),
    meta: jsonb("meta"),
  },
  (t) => [index("watch_activity_profile_at_idx").on(t.profile_id, t.at)],
);

// ---------------------------------------------------------------------------
// Module selection — Session H (P1-48). Which future modules the owner
// wants. Analytics is not a row here on purpose: it is fixed on, and a
// row that cannot be turned off would only invite the attempt.

export const accountModules = pgTable(
  "account_modules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** "marketing" | "sales" | "support" | "operations" | "finance". */
    module: text("module").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("account_modules_unique_idx").on(t.account_id, t.module)],
);

/* ---------- Phase 2 Session A — the connector spine (P2-01/02/06) ---------- */

// Connections — P2-01. One live row per (account, provider). Disconnecting
// revokes locally: the secret is wiped, the status flips, sync stops — but
// the row is kept, because every observation it produced points back here
// for its provenance (rule 2), and a fact whose source row vanished would
// be a bare value with extra steps. The partial unique index lets an owner
// reconnect a provider after disconnecting it without resurrecting the
// old row.

export const connectionStatus = pgEnum("connection_status", [
  "connected",
  "paused",
  "failed",
  "disconnected",
]);

// P3-20b (Session D, rule 13): a connection is FOR measuring or FOR
// executing, never both. "measure" rows hold read-only scopes verified by
// lib/connectors (rule 9) and are the only rows the sync runner walks;
// "execute" rows hold the write scopes of lib/execution/scopes and are
// never returned to the measurement side. One table, two purposes, so
// every metric_observations row keeps a valid connection_id whichever
// credential produced it (D4's readback). A Postgres trigger (migration
// 0030) refuses a write-capable scope on a measure row, mirroring
// isWriteCapable, so the invariant holds even for a hand-written row.
//
// Feature 34 adds "import": a file the owner uploads (a stock count from a
// till or a spreadsheet) has no credential and nothing to sync, but its
// figures are observations like any connector's, so they need a
// connection_id for provenance. An "import" row holds no secret and no
// scopes, the sync runner never walks it (it walks "measure" only), and the
// measurement side never lists it.
export const connectionPurpose = pgEnum("connection_purpose", ["measure", "execute", "import"]);

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    /**
     * A ProviderId from lib/connectors/scopes.ts for measure rows ("stripe",
     * "fixture", …); an ExecutionProviderId from lib/execution/scopes.ts
     * for execute rows. The purpose column says which registry applies.
     */
    provider: text("provider").notNull(),
    purpose: connectionPurpose("purpose").notNull().default("measure"),
    status: connectionStatus("status").notNull().default("connected"),
    /**
     * AES-256-GCM blob (P2-03, rule 10). Null once disconnected. Never
     * selected into an API response — see toPublicConnection.
     */
    encrypted_secret: text("encrypted_secret"),
    /** Verbatim from the provider, verified against the scope registry (P2-04). */
    granted_scopes: jsonb("granted_scopes").$type<string[]>().notNull().default([]),
    /** Provider-opaque resume point. Null means "never synced": the next run backfills. */
    cursor: text("cursor"),
    last_sync_at: timestamp("last_sync_at", { withTimezone: true, mode: "string" }),
    /** Consecutive failed runs; the runner parks the connection at the cap (P2-06). */
    failure_count: integer("failure_count").notNull().default(0),
    last_error: text("last_error"),
    /**
     * P3-22d, execute rows only: the Marketing API access tier Meta last
     * reported on this connection's calls (`ads_api_access_tier`, verbatim —
     * "development_access", "standard_access"), and when. Shown on
     * /connections so the owner sees the rate-limit tier SYB works under.
     */
    access_tier: text("access_tier"),
    access_tier_seen_at: timestamp("access_tier_seen_at", { withTimezone: true, mode: "string" }),
    /**
     * P4-15, the email_campaign execute row only (migration 0048): the name
     * campaigns are sent as ("<name> via SYB") and the address replies
     * go to. That row holds NO secret: campaigns send from SYB's own Resend
     * account, so the connection is the owner's recorded consent and the
     * sender identity, nothing else. A check keeps the pair on that row only.
     */
    sender_name: text("sender_name"),
    reply_to: text("reply_to"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    disconnected_at: timestamp("disconnected_at", { withTimezone: true, mode: "string" }),
    /**
     * Idea 47, review 2026-10-30 (migration 0071): how this store's last
     * abandoned-cart reads went, so the carts screen never headlines a stale
     * figure. Null until a read is attempted. State only, no shopper data.
     */
    cart_read: jsonb("cart_read").$type<CartReadState>(),
  },
  (t) => [
    uniqueIndex("connections_active_idx")
      .on(t.account_id, t.provider, t.purpose)
      .where(sql`status <> 'disconnected'`),
    index("connections_account_idx").on(t.account_id),
    check(
      "connections_sender_on_email_campaign",
      sql`(${t.sender_name} IS NULL AND ${t.reply_to} IS NULL) OR (${t.provider} = 'email_campaign' AND ${t.purpose} = 'execute' AND ${t.sender_name} IS NOT NULL AND ${t.reply_to} IS NOT NULL)`,
    ),
  ],
);

// Metric observations — P2-02. What a provider said happened on one day,
// one row per (connection, metric, dimensions, day). Append-only in
// spirit: rows are never deleted, and re-ingesting the same day upserts by
// the natural key so a re-run backfill cannot double-count. Money lives in
// value_minor + currency (rule 1); counts in value_num. `dimension_key`
// is the canonical serialisation of `dimensions` — the half of the
// natural key that a jsonb column cannot reliably provide.

export const metricObservations = pgTable(
  "metric_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connection_id: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    /** Denormalised from the connection for series queries. */
    provider: text("provider").notNull(),
    /** "revenue.daily" | "orders.daily" | "ad_spend.daily" | "sessions.daily". */
    metric_key: text("metric_key").notNull(),
    /** { offer_id?, channel_id?, currency? } — see lib/connectors/provider.ts. */
    dimensions: jsonb("dimensions").$type<Record<string, string>>().notNull().default({}),
    dimension_key: text("dimension_key").notNull(),
    period_date: date("period_date", { mode: "string" }).notNull(),
    /** Integer minor units for money metrics; null otherwise. */
    value_minor: bigint("value_minor", { mode: "number" }),
    /** ISO 4217 — required exactly when value_minor is set. */
    currency: text("currency"),
    /** Counts and ratios; null for money metrics. */
    value_num: numeric("value_num", { precision: 18, scale: 4 }),
    observed_at: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [
    uniqueIndex("metric_observations_natural_idx").on(
      t.connection_id,
      t.metric_key,
      t.dimension_key,
      t.period_date,
    ),
    index("metric_observations_series_idx").on(t.connection_id, t.metric_key, t.period_date),
  ],
);

// Sync telemetry — P2-06, in the llm_calls mould: one row per run of one
// connection, so "what did syncing this account cost in time and calls"
// is a query rather than archaeology. Append-only by convention.

export const connectorSyncs = pgTable(
  "connector_syncs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connection_id: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    /** Every log line carries an account id (CLAUDE.md conventions). */
    account_id: uuid("account_id").notNull(),
    started_at: timestamp("started_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    /** "backfill" | "incremental". */
    kind: text("kind").notNull(),
    duration_ms: integer("duration_ms").notNull(),
    pages: integer("pages").notNull(),
    observations_upserted: integer("observations_upserted").notNull(),
    ok: boolean("ok").notNull(),
    error: text("error"),
  },
  (t) => [index("connector_syncs_connection_idx").on(t.connection_id, t.started_at)],
);

// Idea 48, bundles: which store products were bought in the same order.
// The daily units (units.daily) say how much of each product sold, never
// which ones went out together, so a commerce sync also keeps, per order,
// the set of store product ids in it — read from the same order lines it
// already reads under read_orders, so no permission was added. Nothing
// about the customer is stored: an order is its platform id, its day and
// its products. Every sync re-reads its window (refunds and cancellations
// change past orders), and the window is authoritative: the rows of the
// days it covers are replaced in the page's transaction, so a cancelled
// order drops out. Raw connector data like metric_observations, so it goes
// with its connection (on delete cascade), never into the decision log.

export const orderBaskets = pgTable(
  "order_baskets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    connection_id: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** The platform's own order id ("gid://shopify/Order/1001", "812"). */
    order_ref: text("order_ref").notNull(),
    /** The day the order counts on: the same UTC day its revenue.daily row uses. */
    day: date("day", { mode: "string" }).notNull(),
    /** The distinct store product ids in the order, sorted. Never empty. */
    product_refs: text("product_refs").array().notNull(),
    observed_at: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [
    uniqueIndex("order_baskets_order_idx").on(t.connection_id, t.order_ref),
    index("order_baskets_day_idx").on(t.connection_id, t.day),
    check("order_baskets_not_empty", sql`cardinality(${t.product_refs}) >= 1`),
  ],
);

// Idea 47, abandoned carts: checkouts a shopper started and didn't finish,
// read from Shopify's abandonedCheckouts under read_orders (no scope was
// added). Raw connector data like order_baskets: it goes with its
// connection (on delete cascade), never into the decision log, and is
// deleted after 90 days (lib/carts/store.ts). No shopper's address is
// stored, ever: `email_hash` is the keyed hash contacts and suppressions
// use (lib/crm/contacts.ts emailHash), so a cart can be matched to a
// contact who already said yes, and a shopper who isn't one leaves nothing
// personal behind. Shopify gives the email only to an app that can read
// customers: with the optional read_customers (I-47b, 2026-10-30) the
// connector reads it and the store hashes it; without, it is null.
// `accepts_marketing` is Shopify's own tick, null when not read. The cart
// row never counts as consent; lib/carts/consent.ts turns a yes into a
// contact with that consent recorded (I-47a).
// Erasing a contact deletes the carts their address hashes to.

/** A store's abandoned-cart reads (connections.cart_read). */
export interface CartReadState {
  /** The last read that landed in full; null when none has. */
  ok_at: string | null;
  /** The last read that failed, when it came after the last good one. */
  failed_at: string | null;
  /** That failure was the store holding more checkouts than one sync reads. */
  too_many: boolean;
  /** I-47b: whether the last good read had each cart's shopper (CartRead.shopper). */
  shopper?: "read" | "not_granted" | "refused" | null;
  /**
   * I-47a: contacts the owner recorded as not a yes whom Shopify lists as
   * subscribed, left as recorded, as of the last read that had shoppers.
   */
  consent_differs?: number | null;
}

/** One line of a cart: the product, how many, at what unit price (the cart's currency). */
export interface CartLine {
  /** The store's product id; null for a custom line or a product deleted since. */
  product_ref: string | null;
  /** The line's own title (the product's, by default) — a label, not part of any key. */
  title: string | null;
  quantity: number;
  /** Before discounts, in the cart's currency's minor units. */
  unit_price_minor: number;
}

export const abandonedCheckouts = pgTable(
  "abandoned_checkouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    connection_id: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** The platform's own id ("gid://shopify/AbandonedCheckout/123"). */
    checkout_ref: text("checkout_ref").notNull(),
    /** When the shopper started the checkout, and when Shopify last saw it change. */
    started_at: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    /** The UTC day it started — the same day grammar as order_baskets and orders.daily. */
    day: date("day", { mode: "string" }).notNull(),
    /** Set when the shopper later finished it: a recovered cart, already counted as an order. */
    completed_at: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    /** The checkout's grand total (rule 1: minor units + currency). */
    total_minor: bigint("total_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    lines: jsonb("lines").$type<CartLine[]>().notNull().default([]),
    /** More lines than one read takes: the cart's total stands, its products are counted short. */
    lines_truncated: boolean("lines_truncated").notNull().default(false),
    /** The keyed hash of the shopper's email, or null (none given, or not read). */
    email_hash: text("email_hash"),
    /** Shopify's "email me" tick at checkout; null: not read. Never consent on the cart itself: lib/carts/consent.ts turns a yes into a contact (I-47a). */
    accepts_marketing: boolean("accepts_marketing"),
    observed_at: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [
    uniqueIndex("abandoned_checkouts_ref_idx").on(t.connection_id, t.checkout_ref),
    index("abandoned_checkouts_day_idx").on(t.connection_id, t.day),
    index("abandoned_checkouts_hash_idx").on(t.account_id, t.email_hash),
    check("abandoned_checkouts_total_nonneg", sql`${t.total_minor} >= 0`),
    check("abandoned_checkouts_currency", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/* ---------- Bookings: appointments from Square or an owner's export (specs/bookings.md) ---------- */

// A gym's or salon's numbers live in its booking system. Two sources write
// here: the Square connector's Bookings read (APPOINTMENTS_READ), and an
// export file the owner imports from any other system. Both land as
// appointments under a connection, and the daily measures are computed
// from these rows into metric_observations, the same table every connector
// feeds, so measured facts supersede estimates the same way.
//
// Idempotency is structural: one row per (connection, source_ref), so an
// overlapping re-import updates an appointment (booked → completed) and
// never counts it twice. No client PII is stored: client_key is a keyed
// hash (HMAC, lib/bookings/client-key.ts), enough to see that a client
// came back, never who they are.

export const bookingStatus = pgEnum("booking_status", [
  "completed",
  "no_show",
  "cancelled_late",
  "cancelled",
  "booked_future",
]);

/** One import of one export file: what it understood, and what it counted and left out. */
export const bookingImports = pgTable(
  "booking_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    connection_id: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    /** A platform key from specs/bookings-import-map-v1.json ("fresha", "generic"). */
    platform: text("platform").notNull(),
    /** ISO 4217, named by the owner for the batch (rule 1). Null when the file has no price column. */
    currency: text("currency"),
    imported_at: timestamp("imported_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    rows_read: integer("rows_read").notNull(),
    added: integer("added").notNull(),
    updated: integer("updated").notNull(),
    unchanged: integer("unchanged").notNull(),
    /** Reason → count. Every row left out is counted under a reason, never guessed. */
    skipped: jsonb("skipped").$type<Record<string, number>>().notNull().default({}),
    /** Role → the header as the file wrote it: what the import understood. */
    columns: jsonb("columns").$type<Record<string, string>>().notNull().default({}),
  },
  (t) => [index("booking_imports_account_idx").on(t.account_id, t.imported_at)],
);

export const bookingAppointments = pgTable(
  "booking_appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    connection_id: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    /** The source's own appointment id, or a content key when the export has none. */
    source_ref: text("source_ref").notNull(),
    /** The import that last wrote the row; null for Square. */
    batch_id: uuid("batch_id").references(() => bookingImports.id),
    /** The day it counts on: the export's own local date, or the UTC date for Square. */
    day: date("day", { mode: "string" }).notNull(),
    /** "HH:MM", when the source gives a time. */
    start_time: text("start_time"),
    status: bookingStatus("status").notNull(),
    service: text("service"),
    staff_ref: text("staff_ref"),
    /** Keyed hash of the client's id, email or phone. Never the value itself (rule 22's spirit). */
    client_key: text("client_key"),
    duration_minutes: integer("duration_minutes"),
    price_minor: bigint("price_minor", { mode: "number" }),
    currency: text("currency"),
    first_seen_at: timestamp("first_seen_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("booking_appointments_source_idx").on(t.connection_id, t.source_ref),
    index("booking_appointments_day_idx").on(t.connection_id, t.day),
    index("booking_appointments_client_idx")
      .on(t.account_id, t.client_key)
      .where(sql`client_key IS NOT NULL`),
    check(
      "booking_appointments_money_whole",
      sql`(${t.price_minor} IS NULL) = (${t.currency} IS NULL)`,
    ),
    check(
      "booking_appointments_duration_sane",
      sql`${t.duration_minutes} IS NULL OR (${t.duration_minutes} >= 0 AND ${t.duration_minutes} <= 1440)`,
    ),
  ],
);

// The client keys an erasure cleared (review 2026-10-23, #3, rule 22): the
// keyed hash only, never the email or phone it came from, so a re-import of
// the usual overlapping export writes no key back onto an erased client's
// rows. It survives erasure on purpose, like contact_suppressions.

export const bookingClientErasures = pgTable(
  "booking_client_erasures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Goes with the account if the account itself is ever deleted.
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** lib/bookings/client-key.ts's keyed hash. No PII here, by design. */
    client_key: text("client_key").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("booking_client_erasures_idx").on(t.account_id, t.client_key)],
);

/* ---------- Phase 2 Session E — anomalies (P2-22..25) ---------- */

// An anomaly is a run of days on one measured series beyond the
// weekday-adjusted baseline (lib/anomaly). One OPEN anomaly per series at
// a time; it is resolved, never deleted, when the series returns to
// normal, so a false alarm can be replayed from `inputs` and the
// thresholds tuned from evidence (P2-25). `detail` is the arithmetic in
// words, as the watch log shows it.

export const anomalyDirection = pgEnum("anomaly_direction", ["drop", "spike"]);
export const anomalySeverity = pgEnum("anomaly_severity", ["notice", "interrupt"]);

export const anomalies = pgTable(
  "anomalies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    connection_id: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    metric_key: text("metric_key").notNull(),
    dimension_key: text("dimension_key").notNull(),
    direction: anomalyDirection("direction").notNull(),
    severity: anomalySeverity("severity").notNull(),
    first_date: date("first_date", { mode: "string" }).notNull(),
    last_date: date("last_date", { mode: "string" }).notNull(),
    run_days: integer("run_days").notNull(),
    /** The latest day's figures, in the series' own units. */
    actual: numeric("actual", { precision: 18, scale: 4 }).notNull(),
    expected: numeric("expected", { precision: 18, scale: 4 }).notNull(),
    /** (actual − expected) ÷ scale: how many "usual variations" off. */
    deviation: numeric("deviation", { precision: 10, scale: 3 }).notNull(),
    /** The owner-readable arithmetic. */
    detail: text("detail").notNull(),
    /** Everything the verdict rested on: window values, factors, residuals. */
    inputs: jsonb("inputs").notNull(),
    detected_at: timestamp("detected_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    resolved_at: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("anomalies_open_idx")
      .on(t.connection_id, t.metric_key, t.dimension_key)
      .where(sql`resolved_at IS NULL`),
    index("anomalies_profile_idx").on(t.profile_id, t.detected_at),
  ],
);

/* ---------- Phase 3 Session A — proposals (P3-01) ---------- */

// The only doorway to action (rule 12). A proposal states what will
// happen, why, the evidence behind it, the expected effect, and whether
// it can be undone — and it is decided by a human whose id is stored, or
// it never runs. The invariants live in the DATABASE, not just the
// service, so no future call site can quietly relax them:
//   · requires_approval is pinned true by a check constraint
//   · a blocked proposal must name the 13.5 limit it hit (rule 14 —
//     restraint is shown, so it must be explainable)
//   · approved / rejected / executed all demand a deciding user and time
//   · a rejection must carry its reason (the learning corpus, P3-28)
//   · an executed proposal must carry its execution result
// `expired` needs no decider: silence is not a decision, and the two are
// never conflated (P3-06).

export const proposalStatus = pgEnum("proposal_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
  "executed",
  "blocked",
  // The queue's third answer (2026-10-17): not approved, and not a no —
  // the owner said what should change. Nothing runs; the words are kept.
  "changes_requested",
]);

export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    /** Which module raised it — "diagnosis" today; marketing et al. later. */
    module: text("module").notNull(),
    /** Id of the finding it addresses; null when raised another way. */
    originating_finding: text("originating_finding"),
    /** ProposalAction — what will happen, in the owner's terms. */
    action: jsonb("action").notNull(),
    /** ScenarioBlock (lib/diagnosis) — assumptions with sources and sensitivity. */
    scenario: jsonb("scenario").notNull(),
    /** Declared BEFORE approval: level + if_you_change_your_mind. */
    reversibility: jsonb("reversibility").notNull(),
    /** Rule 12: literal true — the check below makes false unrepresentable. */
    requires_approval: boolean("requires_approval").notNull().default(true),
    status: proposalStatus("status").notNull().default("pending"),
    /** The 13.5 hard limit a blocked proposal hit — the restraint view's caption. */
    blocked_by_limit: text("blocked_by_limit"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    /** P3-06: proposals expire; expired ≠ rejected everywhere. */
    expires_at: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    decided_by: uuid("decided_by").references(() => users.id),
    decided_at: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    /** P3-05 scheduled actions: approved now, executed no earlier than this. */
    execute_not_before: timestamp("execute_not_before", { withTimezone: true, mode: "string" }),
    rejection_reason: text("rejection_reason"),
    /** The owner's words when they asked for changes instead of deciding. */
    change_request: text("change_request"),
    /** ExecutionResult, written only by the Session B engine. */
    execution_result: jsonb("execution_result"),
  },
  (t) => [
    index("proposals_profile_status_idx").on(t.profile_id, t.status),
    // A stock clearance proposal is once per item, option and month: two
    // runs racing past the read can't both insert (review 2026-10-23, #22).
    uniqueIndex("proposals_stock_finding_idx")
      .on(t.profile_id, t.originating_finding)
      .where(sql`${t.originating_finding} LIKE 'stock:%'`),
    check("proposals_requires_approval_true", sql`${t.requires_approval} = true`),
    check(
      "proposals_blocked_names_limit",
      sql`${t.status} <> 'blocked' OR ${t.blocked_by_limit} IS NOT NULL`,
    ),
    check(
      "proposals_decided_by_human",
      sql`${t.status} NOT IN ('approved', 'rejected', 'executed') OR (${t.decided_by} IS NOT NULL AND ${t.decided_at} IS NOT NULL)`,
    ),
    check(
      "proposals_rejection_has_reason",
      sql`${t.status} <> 'rejected' OR ${t.rejection_reason} IS NOT NULL`,
    ),
    // Compared as text: the enum value is added in the same migration,
    // and Postgres refuses a new enum literal before its commit.
    check(
      "proposals_change_request_recorded",
      sql`${t.status}::text <> 'changes_requested' OR (${t.decided_by} IS NOT NULL AND ${t.decided_at} IS NOT NULL AND ${t.change_request} IS NOT NULL)`,
    ),
    check(
      "proposals_executed_has_result",
      sql`${t.status} <> 'executed' OR ${t.execution_result} IS NOT NULL`,
    ),
  ],
);

/* ---------- Phase 3 Session B — execution (P3-10..13) ---------- */

// One execution per proposal, held by a unique index — THE idempotency
// key (rule 16): a racing second caller loses the insert, not a
// coin-flip. The undo payload is captured BEFORE the first attempt and
// kept indefinitely (permanent undo, not a window). Attempts are
// journaled one row each, the connector_syncs pattern (P3-13).

export const executionStatus = pgEnum("execution_status", [
  "running",
  "succeeded",
  "failed",
  "undone",
]);

export const executions = pgTable(
  "executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposal_id: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    account_id: uuid("account_id").notNull(),
    provider: text("provider").notNull(),
    op: text("op").notNull(),
    status: executionStatus("status").notNull().default("running"),
    attempts: integer("attempts").notNull().default(0),
    /** Captured BEFORE attempt one; null = irreversible, labelled before approval. */
    undo_payload: jsonb("undo_payload"),
    result: jsonb("result"),
    error: text("error"),
    started_at: timestamp("started_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    finished_at: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    undone_at: timestamp("undone_at", { withTimezone: true, mode: "string" }),
    undone_by: uuid("undone_by").references(() => users.id),
    /**
     * P3-24b/c (migration 0044): why a FAILED run is waiting rather than
     * finished. "reconnect" = it failed only because its execute connection
     * failed authentication and paused itself; "stop" = the emergency stop
     * came on mid-run, before anything was sent. Either way the due runner
     * picks it up again once the cause clears (a reconnect, a resume) and
     * the engine re-runs it through every guard; the reclaim clears it.
     * Null for every other failure, which stays for a human (P3-20e).
     * P4-15 (migration 0048) adds "remaining": a campaign run that reached
     * its per-run recipient cap, or that the email service asked to slow
     * down, with recipients still unsent. The next run sends only those.
     */
    held_for: text("held_for"),
    /**
     * Review 2026-10-23 (#16): a held run that must not resume before this
     * time — set when a campaign send's outcome was unknown, so an email
     * service outage costs one recipient per backoff, not one per cron pass.
     * Null = no wait. Only ever set beside a hold.
     */
    held_until: timestamp("held_until", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("executions_proposal_idx").on(t.proposal_id),
    index("executions_profile_idx").on(t.profile_id, t.started_at),
    check(
      "executions_held_for_known",
      sql`${t.held_for} IS NULL OR (${t.held_for} IN ('reconnect', 'stop', 'remaining') AND ${t.status} = 'failed')`,
    ),
    check("executions_held_until_held", sql`${t.held_until} IS NULL OR ${t.held_for} IS NOT NULL`),
  ],
);

export const executionAttempts = pgTable(
  "execution_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    execution_id: uuid("execution_id")
      .notNull()
      .references(() => executions.id, { onDelete: "cascade" }),
    account_id: uuid("account_id").notNull(),
    attempt: integer("attempt").notNull(),
    started_at: timestamp("started_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    duration_ms: integer("duration_ms").notNull(),
    ok: boolean("ok").notNull(),
    error: text("error"),
    /**
     * P3-24d (migration 0044): the rate-limit usage the platform reported on
     * this attempt's own requests — for Meta, every request's X-App-Usage,
     * X-Business-Use-Case-Usage, X-Ad-Account-Usage and
     * X-FB-Ads-Insights-Throttle as parsed JSON, the highest percentage, and
     * the access tier. Null for a provider with no such headers (the
     * fixtures). Never a token.
     */
    usage: jsonb("usage"),
  },
  (t) => [index("execution_attempts_execution_idx").on(t.execution_id, t.attempt)],
);

// The emergency stop (P3-12, rule 15). A row here halts EVERYTHING for
// the account — new executions, retries mid-loop, and undos alike. The
// row records who pulled it and when; resuming deletes it (the halt is
// state, not history — the decision log carries the history).

export const executionHalts = pgTable("execution_halts", {
  account_id: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id),
  halted_at: timestamp("halted_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  halted_by: uuid("halted_by").references(() => users.id),
  reason: text("reason"),
});

/* ---------- Phase 3 Session J — alert mode (P3-45..47) ---------- */

// One row per alert review of one goal. It keeps the case file it read
// (and its hash), what the review concluded, what code refused from it,
// the proposals it put in the queue, and what it cost. Escalation to a
// person (P3-47) is a state on the same row: once escalated, no further
// automatic review runs for that goal until a person resolves it.

export const alertReviewOutcome = pgEnum("alert_review_outcome", [
  "reviewed", // the model answered and the review was stored
  "unusable", // the model answered, but nothing survived validation
  "skipped_cost_cap", // the account's monthly review budget was spent — straight to a person
]);

export const alertReviews = pgTable(
  "alert_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    goal_id: uuid("goal_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    outcome: alertReviewOutcome("outcome").notNull(),
    /** The case file as the review read it: lines with evidence ids. */
    case_file: jsonb("case_file").notNull(),
    case_hash: text("case_hash").notNull(),
    /** The validated review — summary, causes, considered, suggestions. */
    review: jsonb("review"),
    /** What code refused, and why — visible, never repaired. */
    rejected: jsonb("rejected").notNull().default([]),
    proposal_ids: jsonb("proposal_ids").$type<string[]>().notNull().default([]),
    cost_eur: numeric("cost_eur").notNull().default("0"),
    /** P3-47: when the goal was handed to a person, and why. */
    escalated_at: timestamp("escalated_at", { withTimezone: true, mode: "string" }),
    escalation_reason: text("escalation_reason"),
    /** A person closed the case; automatic review may run again after this. */
    resolved_at: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [index("alert_reviews_profile_goal_idx").on(t.profile_id, t.goal_id, t.created_at)],
);

/* ---------- Phase 3 Session C — content items (P3-15/16/17) ---------- */

// The scheduled queue that has nowhere to publish yet. Every item was
// born from an APPROVED proposal, carries the goal it serves, its
// disclosure label (rule 17 — NOT NULL: an undisclosed item is
// unrepresentable), and provenance naming the voice card, the brief
// and the model. Session D adds the publish path; until then these
// rows are the end of the line, on purpose.

export const contentKind = pgEnum("content_kind", ["post", "email", "shot_list", "video"]);

// P3-20d (Session D, layer D0): an item's publish state, held by the
// database. drafted → queued (its publish proposal approved) → publishing
// (the call is in flight) → published | failed. withdrawn is the UNDO —
// the owner or the system took it down — and is distinct from failed in
// every query and screen. The checks make the lies unrepresentable: a
// published or withdrawn item names its platform and the platform's own
// id (kept forever: readback's key, rule 16's record); a failed one
// carries the sentence that says why.
export const contentStatus = pgEnum("content_status", [
  "drafted",
  "queued",
  "publishing",
  "published",
  "failed",
  "withdrawn",
]);

export const contentItems = pgTable(
  "content_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    proposal_id: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id),
    goal_id: uuid("goal_id").references(() => goals.id),
    kind: contentKind("kind").notNull(),
    channel_label: text("channel_label").notNull(),
    scheduled_for: date("scheduled_for", { mode: "string" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** The render's public URL in object storage (P3-20c, lib/content/media.ts). */
    media_path: text("media_path"),
    disclosure: text("disclosure").notNull(),
    /** Voice card, brief, model, evidence — why it reads the way it reads. */
    provenance: jsonb("provenance").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    /* ── P3-20d publish state ── */
    status: contentStatus("status").notNull().default("drafted"),
    /** "facebook" | "instagram" (D2). Null until the item has gone somewhere. */
    platform: text("platform"),
    /** The platform's own id for the post — kept even when withdrawn. */
    platform_post_id: text("platform_post_id"),
    published_at: timestamp("published_at", { withTimezone: true, mode: "string" }),
    /** The per-item publish proposal (D2): the owner approves the finished item, not just the plan. */
    publish_proposal_id: uuid("publish_proposal_id").references(() => proposals.id),
    /** The engine run that published it — the undo's handle (D2). */
    publish_execution_id: uuid("publish_execution_id").references(() => executions.id),
    /** Why it failed, in the owner's language (D5). */
    last_error: text("last_error"),
    /** The post's own address on the platform, once Meta has said where it is (P3-21e). */
    platform_url: text("platform_url"),
    /**
     * P3-21d — what the publish run sent and when: started_at, sent_at (set
     * just BEFORE the publishing call), the caption's hash, and the
     * platform's interim ids (Instagram container, Facebook Reel video id).
     * The next sweep reconciles a `publishing` item from this by reading
     * back, never by posting again.
     */
    publish_attempt: jsonb("publish_attempt"),
    /**
     * P3-24b (migration 0044): the execute connection whose failed sign-in
     * paused it. Set only on a `failed` item that never went out — queued
     * when the connection paused itself, or refused definitively by Meta's
     * auth error — so a reconnect puts it back in the queue. Never set on
     * anything `publishing`: a post that may be live is read back, not re-run.
     */
    paused_connection_id: uuid("paused_connection_id").references(() => connections.id),
    /**
     * P4-15 (migration 0048), campaign emails only: the owner approved THIS
     * text — who, when, the sha256 of the body as approved, and the subject
     * line they gave it. The send refuses a body whose hash no longer
     * matches, and what goes out equals it apart from the unsubscribe slot.
     */
    approved_by: uuid("approved_by").references(() => users.id),
    approved_at: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    approved_sha256: text("approved_sha256"),
    approved_subject: text("approved_subject"),
    /**
     * Review 2026-10-23 (Session D #10), migration 0056: for a per-item
     * publish proposal, the sha256 of the caption and the media URL the
     * owner approved (approvedPublishHash), written in the approval's own
     * transaction. The publish pre-flight and execute refuse an item whose
     * caption or media no longer hash to it — what goes out is what was seen.
     */
    publish_approved_sha256: text("publish_approved_sha256"),
  },
  (t) => [
    index("content_items_profile_idx").on(t.profile_id, t.scheduled_for),
    index("content_items_status_idx").on(t.profile_id, t.status),
    check(
      "content_items_published_names_platform",
      sql`${t.status} NOT IN ('published', 'withdrawn') OR (${t.platform} IS NOT NULL AND ${t.platform_post_id} IS NOT NULL)`,
    ),
    check(
      "content_items_published_has_time",
      sql`${t.status} <> 'published' OR ${t.published_at} IS NOT NULL`,
    ),
    check(
      "content_items_failed_has_error",
      sql`${t.status} <> 'failed' OR ${t.last_error} IS NOT NULL`,
    ),
    check(
      "content_items_paused_is_failed",
      sql`${t.paused_connection_id} IS NULL OR ${t.status} = 'failed'`,
    ),
    check(
      "content_items_approval_whole",
      sql`(${t.approved_at} IS NULL) = (${t.approved_by} IS NULL) AND (${t.approved_at} IS NULL) = (${t.approved_sha256} IS NULL) AND (${t.approved_at} IS NULL) = (${t.approved_subject} IS NULL)`,
    ),
    check("content_items_approval_is_email", sql`${t.approved_at} IS NULL OR ${t.kind} = 'email'`),
  ],
);

/* ---------- Phase 3 Session K — footage in (P3-52) and generated media (P3-53) ---------- */

// The owner's clips, uploaded against a shot list (or a post that needs
// media). A row is born `issued` when an upload is granted — the pathname
// is chosen HERE, never by the browser — becomes `uploaded` once the store
// confirms the object, `used` once a render consumed it, and `released`
// when the bytes are deleted from storage (after the render, or when the
// owner removes it). The row is the record; the bytes do not linger.
export const footageClipStatus = pgEnum("footage_clip_status", [
  "issued",
  "uploaded",
  "used",
  "released",
]);

export const footageClips = pgTable(
  "footage_clips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    /** The shot list (or post) the clip was filmed for. */
    item_id: uuid("item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    status: footageClipStatus("status").notNull().default("issued"),
    /** "vercel_blob" | "local_disk" | "memory" — where the bytes went. */
    store: text("store").notNull(),
    /** Server-chosen, unguessable: renders/<profile>/<item>/clip-<32 hex>.<ext>. */
    pathname: text("pathname").notNull(),
    /** The stored object's URL, once the store has confirmed it. */
    url: text("url"),
    content_type: text("content_type").notNull(),
    /** What the browser said it would send — checked against the cap before any grant. */
    declared_bytes: integer("declared_bytes").notNull(),
    /** What the store holds — checked against the cap again on confirm. */
    bytes: integer("bytes"),
    /** The file's own name, trimmed and cleaned, for the owner's list only. */
    label: text("label").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    uploaded_at: timestamp("uploaded_at", { withTimezone: true, mode: "string" }),
    released_at: timestamp("released_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("footage_clips_item_idx").on(t.item_id, t.created_at),
    uniqueIndex("footage_clips_pathname_uq").on(t.pathname),
    check(
      "footage_clips_uploaded_has_object",
      sql`${t.status} = 'issued' OR (${t.url} IS NOT NULL AND ${t.bytes} IS NOT NULL)`,
    ),
  ],
);

// A cutting-room run (P3-18) over a shot list's clips. queued → rendering
// → rendered | failed. The render may run inside the request (after the
// response) or on the cron sweep; either way the row says where it stands,
// and `attempts` is capped in the database as well as in code.
export const footageRenderStatus = pgEnum("footage_render_status", [
  "queued",
  "rendering",
  "rendered",
  "failed",
]);

export const footageRenders = pgTable(
  "footage_renders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    item_id: uuid("item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    status: footageRenderStatus("status").notNull().default("queued"),
    /** The clips this run cuts, in order. */
    clip_ids: jsonb("clip_ids").notNull(),
    /** Burned onto the frame (optional, short). */
    on_screen: text("on_screen"),
    /** The post's caption, for a video item made from a shot list. */
    caption: text("caption"),
    scheduled_for: date("scheduled_for", { mode: "string" }),
    attempts: integer("attempts").notNull().default(0),
    /** The owner's sentence: why it is waiting, or why it failed. */
    note: text("note"),
    /** The item the render landed on. */
    result_item_id: uuid("result_item_id").references(() => contentItems.id, {
      onDelete: "set null",
    }),
    /** Wall-clock, bytes, output seconds, segments — compute is a cost too (P3-18). */
    metrics: jsonb("metrics"),
    requested_by: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    started_at: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finished_at: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("footage_renders_item_idx").on(t.item_id, t.created_at),
    // One live run per item: a second "cut it" while one is queued or running is refused.
    uniqueIndex("footage_renders_one_live_uq")
      .on(t.item_id)
      .where(sql`${t.status} IN ('queued', 'rendering')`),
    check("footage_renders_attempt_cap", sql`${t.attempts} >= 0 AND ${t.attempts} <= 3`),
    check("footage_renders_failed_says_why", sql`${t.status} <> 'failed' OR ${t.note} IS NOT NULL`),
  ],
);

// P3-53: one row per approved generation proposal — the claim that makes
// generating twice impossible (UNIQUE proposal_id) and the ledger that
// makes the caps arithmetic: every attempt's cost in integer minor units
// with its currency (rule 1).
export const mediaGenerationStatus = pgEnum("media_generation_status", [
  "generating",
  "generated",
  "failed",
]);

export const mediaGenerations = pgTable(
  "media_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    proposal_id: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    /** The item that had no footage — a shot list, or a post that needs media. */
    target_item_id: uuid("target_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    result_item_id: uuid("result_item_id").references(() => contentItems.id, {
      onDelete: "set null",
    }),
    /** "image" | "video". */
    media: text("media").notNull(),
    provider: text("provider").notNull(),
    status: mediaGenerationStatus("status").notNull().default("generating"),
    attempts: integer("attempts").notNull().default(0),
    estimate_minor: integer("estimate_minor").notNull(),
    /** What the provider charged across every attempt — null only while generating. */
    cost_minor: integer("cost_minor"),
    currency: text("currency").notNull(),
    /** sha256 of the exact prompt sent, instruction included. */
    prompt_sha256: text("prompt_sha256").notNull(),
    error: text("error"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    finished_at: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("media_generations_proposal_uq").on(t.proposal_id),
    index("media_generations_account_idx").on(t.account_id, t.created_at),
    index("media_generations_target_idx").on(t.target_item_id),
    check("media_generations_media", sql`${t.media} IN ('image', 'video')`),
    check("media_generations_attempt_cap", sql`${t.attempts} >= 0 AND ${t.attempts} <= 2`),
    check(
      "media_generations_money",
      sql`${t.estimate_minor} >= 0 AND (${t.cost_minor} IS NULL OR ${t.cost_minor} >= 0) AND ${t.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "media_generations_settled_cost",
      sql`${t.status} = 'generating' OR ${t.cost_minor} IS NOT NULL`,
    ),
  ],
);

/* ---------- Phase 4 Session A — contacts (P4-01) ---------- */

// The business's customers, held to rule 22 from the first migration:
// contact rows are ERASABLE (GDPR), and everything that must survive
// them — the suppression list, the log — stores hashes and ids, never
// PII. Consent is a recorded fact with provenance (rule 19), using the
// question bank's own vocabulary, and the (account, email) uniqueness
// is partial: a partial contact without an email is a real contact.

export const consentStatus = pgEnum("consent_status", [
  "explicit_consent",
  "implied_consent",
  "no_consent",
  "unsure",
]);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    email: text("email"),
    name: text("name"),
    phone: text("phone"),
    consent_status: consentStatus("consent_status").notNull().default("unsure"),
    /** How consent was obtained, in words: "checkout checkbox", "import batch <id> — owner attests". */
    consent_source: text("consent_source").notNull(),
    consent_captured_at: timestamp("consent_captured_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    first_seen_at: timestamp("first_seen_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    last_activity_at: timestamp("last_activity_at", { withTimezone: true, mode: "string" }),
    /* ── P4-13: measured purchase history, from the owner's shop export ── */
    /** The last order's date, as the shop exported it. Lifecycle counts from here when present. */
    last_purchase_at: timestamp("last_purchase_at", { withTimezone: true, mode: "string" }),
    orders_count: integer("orders_count"),
    /** Integer minor units + currency, together or not at all (rule 1). */
    total_spent_minor: bigint("total_spent_minor", { mode: "number" }),
    spent_currency: text("spent_currency"),
    /**
     * P4-16 follow-up: the recipient's country, ISO alpha-2, from the shop
     * export. Their own email rules apply beside the business's (rule 23);
     * null = unknown, and only the business's regime applies.
     */
    country: text("country"),
    /**
     * P4-17: when a shop export last carried this contact's last-order
     * date — at insert, or when a later export refreshed an existing
     * contact's purchase history. Null = no export with a date column has
     * ever covered them. The campaign readback measures "bought again since
     * the email" only from an export at least this long after the send.
     */
    purchase_refreshed_at: timestamp("purchase_refreshed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (t) => [
    uniqueIndex("contacts_account_email_idx")
      .on(t.account_id, t.email)
      .where(sql`email IS NOT NULL`),
    index("contacts_account_idx").on(t.account_id),
    check(
      "contacts_spent_has_currency",
      sql`(${t.total_spent_minor} IS NULL) = (${t.spent_currency} IS NULL)`,
    ),
  ],
);

// The list that survives erasure (rules 22/23): sha256 of the
// lowercased email, never the email. An unsubscribe or an erasure is
// permanent — re-import bounces off this table forever.

export const contactSuppressions = pgTable(
  "contact_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    /** sha256(lowercase(trim(email))) — no PII here, by design. */
    email_hash: text("email_hash").notNull(),
    reason: text("reason").notNull(), // "unsubscribed" | "erasure"
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contact_suppressions_idx").on(t.account_id, t.email_hash)],
);

/* ---------- Phase 4 Session B — customer chat (P4-05..08) ---------- */

// The first stranger-facing surface. The privilege model is different in
// kind, not degree (TASKS-PHASE4.md): a customer gets no profile access,
// no execution reach, and answers grounded ONLY in knowledge the owner
// approved. These tables hold exactly that — what may be said, who said
// what to the widget, and the one thing a support conversation can
// create: an escalation to a human. Conversations and messages carry
// customer text and are plain, erasable rows (rule 22); the decision log
// never holds message text.

// support_settings — one per profile: the PUBLIC site key the widget
// identifies itself with (unguessable, rotatable, never a session), and
// the business name copied in by the owner-side module so the support
// tier can greet without reading the profile.
export const supportSettings = pgTable(
  "support_settings",
  {
    profile_id: uuid("profile_id")
      .primaryKey()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    /** 32 hex chars from 16 random bytes. Public by design; it scopes, it does not authenticate. */
    site_key: text("site_key").notNull(),
    business_name: text("business_name").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    rotated_at: timestamp("rotated_at", { withTimezone: true, mode: "string" }),
    /**
     * P4-09: the routing token in the inbound address s-<token>@<inbound
     * domain>. 32 hex chars from Postgres's random uuid (122 random bits),
     * unguessable, rotatable like the site key. Knowing it lets someone
     * file a ticket, nothing more.
     */
    inbound_token: text("inbound_token")
      .notNull()
      .default(sql`replace(gen_random_uuid()::text, '-', '')`),
    inbound_rotated_at: timestamp("inbound_rotated_at", { withTimezone: true, mode: "string" }),
    /**
     * P4-11: "I reply within N hours" — OWNER-STATED on /support, never a
     * default. Null = no reply time set, and nothing claims one. Clock
     * hours, not business hours.
     */
    reply_hours: integer("reply_hours"),
    reply_hours_set_at: timestamp("reply_hours_set_at", { withTimezone: true, mode: "string" }),
    /** P4-11: email the owner's own account address when an email ticket opens. */
    notify_owner: boolean("notify_owner").notNull().default(true),
    /** P4-11: the last such notice — at most one an hour, so a flood of mail is one email. */
    owner_notified_at: timestamp("owner_notified_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("support_settings_site_key_idx").on(t.site_key),
    uniqueIndex("support_settings_inbound_token_idx").on(t.inbound_token),
    check(
      "support_settings_reply_hours_range",
      sql`${t.reply_hours} IS NULL OR (${t.reply_hours} BETWEEN 1 AND 720 AND ${t.reply_hours_set_at} IS NOT NULL)`,
    ),
  ],
);

// knowledge_entries — P4-05. Every row was born from an APPROVED proposal
// (proposal_id NOT NULL): the system suggested it from profile facts, the
// owner approved what becomes public. Nothing unapproved is sayable,
// because nothing unapproved is a row. Retiring keeps the row (history)
// and takes it out of the sayable set.
export const knowledgeStatus = pgEnum("knowledge_status", ["public", "retired"]);

export const knowledgeEntries = pgTable(
  "knowledge_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    proposal_id: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    /** The profile field keys this answer was rendered from — its provenance (rule 2). */
    source_keys: jsonb("source_keys").$type<string[]>().notNull().default([]),
    status: knowledgeStatus("status").notNull().default("public"),
    published_at: timestamp("published_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    retired_at: timestamp("retired_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("knowledge_entries_profile_idx").on(t.profile_id, t.status),
    check(
      "knowledge_entries_retired_has_time",
      sql`${t.status} <> 'retired' OR ${t.retired_at} IS NOT NULL`,
    ),
  ],
);

// support_conversations — P4-06/07. One per widget session, identified by
// an opaque token the widget holds (not a cookie, not the owner's app
// session). Cost and turn counters are the per-conversation caps' ledger.
export const supportConversationStatus = pgEnum("support_conversation_status", [
  "open",
  "escalated",
  "closed",
]);

export const supportConversations = pgTable(
  "support_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    /** 48 hex chars from 24 random bytes — the widget's only credential, scoped to this one conversation. */
    token: text("token").notNull(),
    status: supportConversationStatus("status").notNull().default("open"),
    turns: integer("turns").notNull().default(0),
    cost_eur: numeric("cost_eur", { precision: 10, scale: 6 }).notNull().default("0"),
    /**
     * Spend reserved for a message whose model calls are in flight. Every cap
     * check counts it, so a burst of concurrent messages can't each pass the
     * cap before any of them has spent (security review 2026-10-17).
     */
    reserved_eur: numeric("reserved_eur", { precision: 10, scale: 6 }).notNull().default("0"),
    /** A keyed hash of the visitor's address and the day — never the address itself. */
    client_hash: text("client_hash"),
    started_at: timestamp("started_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    last_at: timestamp("last_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("support_conversations_token_idx").on(t.token),
    index("support_conversations_profile_idx").on(t.profile_id, t.started_at),
    index("support_conversations_client_idx").on(t.profile_id, t.client_hash, t.started_at),
  ],
);

export const supportRole = pgEnum("support_role", ["customer", "assistant"]);

export const supportMessages = pgTable(
  "support_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => supportConversations.id, { onDelete: "cascade" }),
    role: supportRole("role").notNull(),
    text: text("text").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    /** knowledge_entries ids an assistant answer was grounded on — empty for the disclosure and escalations. */
    grounded_on: jsonb("grounded_on").$type<string[]>().notNull().default([]),
    cost_eur: numeric("cost_eur", { precision: 10, scale: 6 }).notNull().default("0"),
  },
  (t) => [index("support_messages_conversation_idx").on(t.conversation_id, t.at)],
);

// support_tickets — the ONE thing a support conversation can create
// (rule 21). The reason is a closed set so the owner's screen can say
// why a human was needed; contact_id (Session C) is set null on erasure
// (rule 22). Session C adds the channel: a ticket starts in the widget
// (chat, with a conversation) or in the inbox (email, with none).
export const supportTicketReason = pgEnum("support_ticket_reason", [
  "customer_asked",
  "no_answer",
  "cost_cap",
  "conversation_cap",
  "emailed", // P4-09: the customer emailed the support inbox
]);

export const supportChannel = pgEnum("support_channel", ["chat", "email"]);

export const supportTicketStatus = pgEnum("support_ticket_status", ["open", "answered", "closed"]);

export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    conversation_id: uuid("conversation_id").references(() => supportConversations.id, {
      onDelete: "set null",
    }),
    contact_id: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    reason: supportTicketReason("reason").notNull(),
    /** The customer's last question, verbatim — what the human is being asked to answer. */
    summary: text("summary").notNull(),
    status: supportTicketStatus("status").notNull().default("open"),
    /**
     * P4-12: what the owner actually answered, in their words, recorded when
     * the ticket is marked answered. The FAQ proposes from THIS — the system
     * never drafts an answer the owner did not give.
     */
    answer: text("answer"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    resolved_at: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    /** P4-09: where the ticket started. */
    channel: supportChannel("channel").notNull().default("chat"),
    /**
     * P4-09: 32 hex chars carried in the reply-to address of every email
     * sent on this ticket (s-<inbound token>+<thread token>@…), so the
     * customer's answer threads back even when their mail client drops
     * In-Reply-To. Null until the ticket has an email side.
     */
    thread_token: text("thread_token"),
    /**
     * P4-09/P4-11: the address that reached this ticket (the sender, or the
     * one given in the chat) is on the suppression list, so no contact was
     * recreated for it and the gate refuses every reply (rules 22/23).
     */
    suppressed_address: boolean("suppressed_address").notNull().default(false),
    /** P4-10: model calls spent drafting replies on this ticket — the per-ticket cap's ledger. */
    draft_calls: integer("draft_calls").notNull().default(0),
  },
  (t) => [
    index("support_tickets_profile_idx").on(t.profile_id, t.status, t.created_at),
    uniqueIndex("support_tickets_thread_token_idx").on(t.thread_token),
    // One origin, coherent: an email ticket never has a widget conversation.
    // A chat ticket may lose its conversation to an erasure (ON DELETE SET NULL).
    check(
      "support_tickets_email_has_no_conversation",
      sql`${t.channel} <> 'email' OR ${t.conversation_id} IS NULL`,
    ),
  ],
);

// support_replies — P4-10. A reply to a customer, from draft to sent.
// Rule 12's covenant extended to support: nothing goes out without a
// recorded human approval — who, when, and sha256 of the EXACT text that
// will be sent (the owner's words plus, for an AI-drafted reply, the
// disclosure appended in code). drafted → approved → sending → sent |
// failed, or drafted → declined. "sending" is claimed atomically before
// the provider is called and never retried automatically: a send whose
// outcome is unknown stays "sending" and says so. Erasable with its
// ticket (rule 22); the log keeps ids and hashes only.
export const supportReplyStatus = pgEnum("support_reply_status", [
  "drafted",
  "declined",
  "approved",
  "sending",
  "sent",
  "failed",
]);

export const supportReplies = pgTable(
  "support_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticket_id: uuid("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    status: supportReplyStatus("status").notNull().default("drafted"),
    /** True when the assistant drafted it — kept true however much the owner edits it. */
    ai_drafted: boolean("ai_drafted").notNull(),
    /** The assistant's draft as it came back; null for a reply the owner wrote. */
    drafted_text: text("drafted_text"),
    /** knowledge_entries ids the draft was grounded on. */
    grounded_on: jsonb("grounded_on").$type<string[]>().notNull().default([]),
    draft_cost_eur: numeric("draft_cost_eur", { precision: 10, scale: 6 }).notNull().default("0"),
    /** The owner's text — editable until approval. */
    body: text("body").notNull(),
    /** Set at approval: exactly what will be sent (body + disclosure when ai_drafted). */
    sent_text: text("sent_text"),
    sent_text_sha256: text("sent_text_sha256"),
    approved_by: uuid("approved_by").references(() => users.id),
    approved_at: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    declined_at: timestamp("declined_at", { withTimezone: true, mode: "string" }),
    claimed_at: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
    sent_at: timestamp("sent_at", { withTimezone: true, mode: "string" }),
    /** Resend's id for the sent email. */
    provider_id: text("provider_id"),
    /** In words, on the ticket: why it hasn't gone, or what is unknown. */
    outcome_note: text("outcome_note"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("support_replies_ticket_idx").on(t.ticket_id, t.created_at),
    // One reply in flight per ticket.
    uniqueIndex("support_replies_live_idx")
      .on(t.ticket_id)
      .where(sql`status IN ('drafted', 'approved', 'sending')`),
    check(
      "support_replies_approval_recorded",
      sql`${t.status} IN ('drafted', 'declined') OR (${t.approved_by} IS NOT NULL AND ${t.approved_at} IS NOT NULL AND ${t.sent_text} IS NOT NULL AND ${t.sent_text_sha256} IS NOT NULL)`,
    ),
    check(
      "support_replies_ai_has_draft",
      sql`NOT ${t.ai_drafted} OR ${t.drafted_text} IS NOT NULL`,
    ),
  ],
);

// support_email_messages — P4-09. Every email on a ticket, in and out,
// as plain erasable rows (rule 22): they carry addresses and customer
// text, so they go with their ticket. provider_id is the provider's own
// id — UNIQUE, so a redelivered webhook can never file the same email
// twice. The headers kept are the ones threading needs.
export const supportEmailDirection = pgEnum("support_email_direction", ["inbound", "outbound"]);

// Review 2026-10-23 (#18): whether an inbound sender passed authentication,
// from Resend's own `authentication` result (computed by its receiving
// server, which the sender cannot forge — never from a header in the mail):
//   verified    DMARC passed, or DKIM passed aligned with the From domain;
//   failed      DMARC (or DKIM) failed outright;
//   unverified  no result, or one that proves nothing (no DMARC policy,
//               unsigned, processing failed).
// Null on outbound rows and on rows filed before the column existed.
export const supportSenderAuth = pgEnum("support_sender_auth", [
  "verified",
  "unverified",
  "failed",
]);

export const supportEmailMessages = pgTable(
  "support_email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticket_id: uuid("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    direction: supportEmailDirection("direction").notNull(),
    /** Resend's email id (inbound: the received email; outbound: the sent one). */
    provider_id: text("provider_id"),
    /** The Message-ID header, angle brackets included, as the mail carried it. */
    message_id_header: text("message_id_header"),
    in_reply_to: text("in_reply_to"),
    /** The References header, verbatim (space-separated ids). */
    references_header: text("references_header"),
    from_address: text("from_address").notNull(),
    from_name: text("from_name"),
    to_addresses: jsonb("to_addresses").$type<string[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    /** Plain text, capped (SUPPORT_EMAIL_BODY_MAX_CHARS); `truncated` says when it was cut. */
    body: text("body").notNull(),
    truncated: boolean("truncated").notNull().default(false),
    /** Review #18: inbound only — did the sender pass authentication? An unverified one is never tied to an existing contact. */
    sender_auth: supportSenderAuth("sender_auth"),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("support_email_messages_provider_idx").on(t.provider_id),
    index("support_email_messages_ticket_idx").on(t.ticket_id, t.at),
    index("support_email_messages_thread_idx").on(t.profile_id, t.message_id_header),
  ],
);

/* ---------- Phase 4 Session F — the campaign send (P4-15) ---------- */

// campaign_sends — one row per recipient per campaign, the executor's
// journal below the engine's one executions row. Materialised on the
// first run from the approved proposal's contact ids; every run after
// that only ever sends rows still `pending`. A recipient's consent is
// re-checked at the moment of THEIR send (rule 23), never at creation.
//
//   pending → refused            the gate said no at send time; never sent
//   pending → sending → sent     claimed before the call, Resend's id after
//                     → failed   Resend refused it definitively; nothing went out
//                     → unknown  no usable answer; it may have gone out.
//                                NEVER retried, by any run, ever.
//
// "Exactly once" is structural: one row per (proposal, contact) and one
// per (proposal, address hash), each a UNIQUE index, and a row only ever
// leaves `pending` through a conditional claim.
//
// Rule 22: erasure NULLS contact_id and provider_message_id (lib/crm/
// contacts.ts); the row keeps its status and the address's keyed hash —
// the suppression list's own form — so the count stays true and the
// unsubscribe link keeps working after erasure. No address, name or body
// is ever stored here; refusal reasons are codes.
export const campaignSendStatus = pgEnum("campaign_send_status", [
  "pending",
  "refused",
  "sending",
  "sent",
  "failed",
  "unknown",
]);

export const campaignSends = pgTable(
  "campaign_sends",
  {
    /** Generated in code, so the idempotency key can name it before the insert. */
    id: uuid("id").primaryKey(),
    proposal_id: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id),
    execution_id: uuid("execution_id")
      .notNull()
      .references(() => executions.id),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    /** Null once the contact is erased (rule 22): nulled by erasure, and by the FK. */
    contact_id: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    /** emailHash() of the address it went to — written at the claim, never the address. */
    email_hash: text("email_hash"),
    status: campaignSendStatus("status").notNull().default("pending"),
    /** Codes, never sentences that could quote PII (lib/crm/campaign-send.ts). */
    refused_reasons: jsonb("refused_reasons").$type<string[]>().notNull().default([]),
    /** Resend's id for the email. Null once the contact is erased. */
    provider_message_id: text("provider_message_id"),
    /** Resend's Idempotency-Key: one per recipient, "syb-campaign-<id>". */
    idempotency_key: text("idempotency_key").notNull(),
    /** sha256 of the recipient's own unsubscribe token; the token itself is only ever in their email. */
    unsubscribe_token_hash: text("unsubscribe_token_hash"),
    /** The business name it was sent as — what the unsubscribe page names. */
    sender_name: text("sender_name"),
    /** sha256 of the exact text sent to this recipient (the approved body, slot filled). */
    body_sha256: text("body_sha256"),
    /** The HTTP status of a definitive refusal — a number, never Resend's message. */
    provider_status: integer("provider_status"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    claimed_at: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
    sent_at: timestamp("sent_at", { withTimezone: true, mode: "string" }),
    unsubscribed_at: timestamp("unsubscribed_at", { withTimezone: true, mode: "string" }),
    /* ── P4-17: what the email service reported, from its Svix-signed events ── */
    /** First `email.delivered` for this email. */
    delivered_at: timestamp("delivered_at", { withTimezone: true, mode: "string" }),
    /** First `email.bounced` (or `email.suppressed`: the service held it back). */
    bounced_at: timestamp("bounced_at", { withTimezone: true, mode: "string" }),
    /** permanent | temporary | suppressed | other — a code, never the server's message. */
    bounce_type: text("bounce_type"),
    /** First `email.complained`: marked as spam. Suppresses the address permanently (rule 23). */
    complained_at: timestamp("complained_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("campaign_sends_contact_idx")
      .on(t.proposal_id, t.contact_id)
      .where(sql`contact_id IS NOT NULL`),
    uniqueIndex("campaign_sends_address_idx")
      .on(t.proposal_id, t.email_hash)
      .where(sql`email_hash IS NOT NULL`),
    uniqueIndex("campaign_sends_idempotency_idx").on(t.idempotency_key),
    uniqueIndex("campaign_sends_token_idx")
      .on(t.unsubscribe_token_hash)
      .where(sql`unsubscribe_token_hash IS NOT NULL`),
    index("campaign_sends_proposal_idx").on(t.proposal_id, t.status),
    check(
      "campaign_sends_claimed_has_address",
      sql`${t.status} IN ('pending', 'refused') OR (${t.email_hash} IS NOT NULL AND ${t.claimed_at} IS NOT NULL AND ${t.unsubscribe_token_hash} IS NOT NULL)`,
    ),
    check(
      "campaign_sends_refused_has_reason",
      sql`${t.status} <> 'refused' OR jsonb_array_length(${t.refused_reasons}) > 0`,
    ),
    check("campaign_sends_sent_has_time", sql`${t.status} <> 'sent' OR ${t.sent_at} IS NOT NULL`),
    check(
      "campaign_sends_bounce_whole",
      sql`(${t.bounced_at} IS NULL) = (${t.bounce_type} IS NULL) AND (${t.bounce_type} IS NULL OR ${t.bounce_type} IN ('permanent', 'temporary', 'suppressed', 'other'))`,
    ),
    index("campaign_sends_provider_idx")
      .on(t.provider_message_id)
      .where(sql`provider_message_id IS NOT NULL`),
  ],
);

// campaign_comparisons — P4-17. The campaign's segment members who were NOT
// emailed (no explicit consent, or otherwise not on the approved list), as
// they stood when the send began. The readback compares who bought again
// among them with who bought again among the recipients. Not randomised —
// SYB never withholds an approved send to make a control group — so the
// screen says the comparison is observational. Ids only (rule 22): an
// erased contact's row keeps nothing but the proposal and the time.
export const campaignComparisons = pgTable(
  "campaign_comparisons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposal_id: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    /** Null once the contact is erased (rule 22). */
    contact_id: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    /** When the send began: "since" is measured from here for this group. */
    snapshot_at: timestamp("snapshot_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("campaign_comparisons_contact_idx")
      .on(t.proposal_id, t.contact_id)
      .where(sql`contact_id IS NOT NULL`),
    index("campaign_comparisons_proposal_idx").on(t.proposal_id),
  ],
);

// jurisdiction_reviews — P4-15's second gate. A person reviewed the
// regime table (lib/crm/jurisdiction.ts) against current law: who, on
// what day, and the sha256 of the table's canonical serialisation they
// reviewed. A send is refused unless the LATEST review's hash equals the
// table as it is now, so editing the table voids the review by itself.
// Recorded by an operator from /ops, with a decision-log entry (kind
// law_review) that holds the hash and ids only.
export const jurisdictionReviews = pgTable(
  "jurisdiction_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The reviewer's own name, as they gave it — a person, never "the team". */
    reviewer: text("reviewer").notNull(),
    reviewed_on: date("reviewed_on", { mode: "string" }).notNull(),
    table_sha256: text("table_sha256").notNull(),
    /** Optional: what the reviewer said, e.g. which sources they checked. */
    note: text("note"),
    recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("jurisdiction_reviews_recorded_idx").on(t.recorded_at),
    check("jurisdiction_reviews_reviewer_named", sql`length(trim(${t.reviewer})) > 0`),
    check("jurisdiction_reviews_hash_shape", sql`${t.table_sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

// campaign_reviews — review 2026-10-23 (#5c). Campaigns go out from
// SYB's own sending domain, so one self-signed-up account sending to
// scraped addresses could get that domain throttled for everyone. A person
// at SYB reviews each account's FIRST campaign before it sends: who,
// on what day, and which campaign. Until a row exists for the account, its
// campaign is refused at pre-flight (guard 6b, beside the law review), in
// words; once one exists, later campaigns don't need another. Recorded from
// /ops behind OPS_KEY, with a decision-log entry (kind campaign_review) whose
// hash covers the sha256 of the reviewer's name, never the name.
export const campaignReviews = pgTable(
  "campaign_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    /** The campaign proposal the operator read. */
    proposal_id: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id),
    /** The operator's own name, as they gave it — a person, never "the team". */
    reviewer: text("reviewer").notNull(),
    reviewed_on: date("reviewed_on", { mode: "string" }).notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("campaign_reviews_proposal_idx").on(t.proposal_id),
    index("campaign_reviews_account_idx").on(t.account_id, t.recorded_at),
    check("campaign_reviews_reviewer_named", sql`length(trim(${t.reviewer})) > 0`),
  ],
);

// assistant_changes — feature 33, "the assistant acts". When the owner
// asks the chat to change something, the assistant maps it to ONE entry
// of the closed change catalogue (lib/assistant/catalogue.ts) and
// PREPARES it here: nothing is written to the profile, a setting or the
// queue until the owner presses the card's button. The row is the
// pending item, the clarifying question when the request was ambiguous
// ("Which day?"), and afterwards the record of what the click did.
//
// `basis` pins what the change was prepared against (the current field
// record id, or the setting's value); a confirm that finds the world
// moved since refuses instead of overwriting something unseen.
export const assistantChangeStatus = pgEnum("assistant_change_status", [
  "asked", // the request was ambiguous; the reply asked a question
  "prepared", // drafted, waiting for the owner's click
  "applied", // the click wrote it
  "queued", // the click put it in the approval queue as a proposal
  "stale", // the value moved between prepare and click; nothing written
  "superseded", // a later message answered or replaced it
  "link_only", // only a link was offered — nothing to confirm
]);

export const assistantChanges = pgTable(
  "assistant_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    /** The owner's message that asked for it. */
    owner_utterance_id: uuid("owner_utterance_id").notNull(),
    /** The assistant's reply that carries the card. */
    reply_utterance_id: uuid("reply_utterance_id"),
    /** A change-catalogue kind (lib/assistant/catalogue.ts). */
    kind: text("kind").notNull(),
    status: assistantChangeStatus("status").notNull(),
    /** The change in plain words: "Set your Saturday opening hours to 10:00–16:00". */
    summary: text("summary").notNull(),
    current_text: text("current_text"),
    proposed_text: text("proposed_text"),
    /** The deep link: route plus ?focus= for the exact section. */
    link: text("link").notNull(),
    /** What the confirm needs, validated at prepare time. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** What it was prepared against; a confirm finding anything else refuses. */
    basis: text("basis"),
    /** The worded outcome of the click. */
    result_text: text("result_text"),
    /** What the click wrote: a field record id, a proposal id, a settings row. */
    result_ref: text("result_ref"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    decided_at: timestamp("decided_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("assistant_changes_profile_idx").on(t.profile_id, t.created_at),
    index("assistant_changes_reply_idx").on(t.reply_utterance_id),
  ],
);

/* ---------- Phase 3 Session K — the creative studio (P3-50, P3-51) ---------- */

// P3-50: one read of Meta's Ad Library for a business's niche — a CACHE,
// not facts about the business. Read-only research (rule 9), so nothing
// here is a Field<T>: these are other businesses' public ads, kept only as
// far as the analysis needs them (lib/research/niche.ts). No targeting,
// reach, spend or payer data is requested or stored, nor the snapshot URL
// (it carries the reader's access token); page names are businesses.
export const nicheAdReads = pgTable(
  "niche_ad_reads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    /** Where the ads came from. Only the Meta Ad Library today. */
    source: text("source").notNull().default("meta_ad_library"),
    /** "read" — ads stored; "failed" — the Library refused or broke, `reason` says how. */
    status: text("status").notNull(),
    read_at: timestamp("read_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    /** ISO 3166 alpha-2 the ads were asked for (ad_reached_countries). */
    country: text("country"),
    /** The search terms asked, in order. */
    terms: jsonb("terms").$type<string[]>().notNull().default([]),
    /** What each query was for: a term, or a listed competitor (by page id or by name). */
    targets: jsonb("targets").$type<Record<string, unknown>[]>().notNull().default([]),
    /** HTTP requests the read made, against its cap. */
    requests: integer("requests").notNull().default(0),
    /** The ads, minimised (LibraryAd in lib/research/ad-library.ts), capped per read. */
    ads: jsonb("ads").$type<Record<string, unknown>[]>().notNull().default([]),
    reason: text("reason"),
  },
  (t) => [
    index("niche_ad_reads_profile_idx").on(t.profile_id, t.read_at),
    check("niche_ad_reads_status", sql`${t.status} IN ('read', 'failed')`),
    check(
      "niche_ad_reads_failed_says_why",
      sql`${t.status} <> 'failed' OR ${t.reason} IS NOT NULL`,
    ),
  ],
);

// P3-51: the creative brief, one per campaign, with its provenance. The
// brief is what Sonnet wrote AFTER the deterministic checks passed (every
// claim cites a source it was given; nothing shares five words in a row
// with another business's ad); `sources` is exactly what it was given,
// id by id, so every citation resolves to a fact, finding, post or ad.
export const creativeBriefs = pgTable(
  "creative_briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    /** The campaign, in the owner's words or the goal's statement. */
    campaign: text("campaign").notNull(),
    goal_id: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    niche_read_id: uuid("niche_read_id").references(() => nicheAdReads.id, {
      onDelete: "set null",
    }),
    /** The validated brief: audience, offer, hooks with scripts and shots (lib/content/brief.ts). */
    brief: jsonb("brief").$type<Record<string, unknown>>().notNull(),
    /** Every source the model saw, by its prompt id, with its reference and text. */
    sources: jsonb("sources").$type<Record<string, unknown>[]>().notNull(),
    model: text("model").notNull(),
    /** Model calls this brief took (rejected attempts included), against the cap. */
    attempts: integer("attempts").notNull(),
    /** Why each rejected attempt was rejected, in order. */
    rejections: jsonb("rejections").$type<string[][]>().notNull().default([]),
    cost_eur: numeric("cost_eur").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("creative_briefs_profile_idx").on(t.profile_id, t.created_at),
    check("creative_briefs_attempts", sql`${t.attempts} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// The weekly summary — idea 42 (Ideas round, 2026-10-26). One email a week
// to the business OWNER (never a customer) saying what SYB did and found.
// A row here is the claim on an (account, ISO week): it is written BEFORE
// the provider is called, so a re-run of the weekly cron — or two racing
// — loses the insert and sends nothing. "sending" that never settles means
// the outcome is unknown; it is not retried. The on/off switch is the
// owner's own users.notification_prefs.weekly_summary (data-model §4's
// NotificationPrefs), not a column here.

export const weeklySummaryStatus = pgEnum("weekly_summary_status", [
  "sending",
  "sent",
  "refused",
  "unknown",
]);

export const weeklySummaries = pgTable(
  "weekly_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** The ISO week it covers, "2026-W44" (UTC). */
    iso_week: text("iso_week").notNull(),
    status: weeklySummaryStatus("status").notNull().default("sending"),
    /** True when the week had nothing to report and the email said so. */
    quiet: boolean("quiet").notNull(),
    /** How many real lines the email carried — counts, never their text. */
    line_count: integer("line_count").notNull(),
    /** Resend's email id once accepted; null otherwise. */
    provider_id: text("provider_id"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    settled_at: timestamp("settled_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [uniqueIndex("weekly_summaries_account_week_idx").on(t.account_id, t.iso_week)],
);

/* ---------- Phase 3 Session K — ad creation on Meta (P3-54) ---------- */

/**
 * The journal of one "Run this ad" build: an approved proposal that
 * creates, all PAUSED and one after another, a campaign, an ad set, (for a
 * video) an uploaded ad video, a creative and the ad. Every step's
 * `sent_at` is written just BEFORE the call that creates it and its Meta
 * id as soon as Meta answers, so a run that stops, is halted or loses an
 * answer resumes from here and never creates anything twice — an answer
 * that never came is read back by the build's tag, the P3-21d honesty.
 * Nothing Meta created can be deleted (DELETED and ARCHIVED are
 * permanent), so the ids are kept for ever. One row per execution.
 */
export const adBuilds = pgTable(
  "ad_builds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    account_id: uuid("account_id").notNull(),
    proposal_id: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    execution_id: uuid("execution_id")
      .notNull()
      .references(() => executions.id, { onDelete: "cascade" }),
    item_id: uuid("item_id").references(() => contentItems.id, { onDelete: "set null" }),
    /** building → built; or uncertain (a create Meta never confirmed), or failed. */
    status: text("status").notNull().default("building"),
    /** In every object's name ("… · SYB-1a2b3c4d"): what a read-back finds a lost create by. */
    build_tag: text("build_tag").notNull(),
    campaign_id: text("campaign_id"),
    adset_id: text("adset_id"),
    video_id: text("video_id"),
    creative_id: text("creative_id"),
    ad_id: text("ad_id"),
    /** Per step: {sent_at, id} — written before and after each create. */
    steps: jsonb("steps").notNull().default({}),
    /** The owner's sentence when it stopped short. */
    last_error: text("last_error"),
    /** The separate "go live" proposal made once the build is complete. */
    go_live_proposal_id: uuid("go_live_proposal_id").references(() => proposals.id, {
      onDelete: "set null",
    }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_builds_execution_idx").on(t.execution_id),
    index("ad_builds_profile_idx").on(t.profile_id, t.created_at),
    index("ad_builds_item_idx").on(t.item_id),
    check(
      "ad_builds_status_known",
      sql`${t.status} IN ('building', 'built', 'uncertain', 'failed')`,
    ),
    check(
      "ad_builds_built_is_whole",
      sql`${t.status} <> 'built' OR (${t.campaign_id} IS NOT NULL AND ${t.adset_id} IS NOT NULL AND ${t.creative_id} IS NOT NULL AND ${t.ad_id} IS NOT NULL)`,
    ),
  ],
);

/* ---------- Phase 5 Session D — the sales pipeline (P5-14..17) ---------- */

// Rule 29: pipeline contacts are contacts. A deal belongs to a Phase 4
// contact (the person, or a company's one point of contact), and goes WITH
// that contact: erasing them cascades through deals, their history and any
// drafted follow-up, so nothing personal outlives an erasure (rule 22). The
// decision log never holds a deal's words — only ids and hashes, as
// everywhere — so the cascade leaves it untouched and verifiable.
//
// Stages are the bank's own vocabulary (deal_stage, bank 1.9.0); the enum
// mirrors it and a test holds the two equal. Values are integer minor units
// plus an explicit currency, together or not at all (rule 1), and say
// whether they were quoted or estimated (rule 2). A change to a deal is
// recorded beside it in deal_events, the old value with the new, so the
// row moving on never loses what it was (rule 3's spirit).

export const dealStage = pgEnum("deal_stage", [
  "lead",
  "qualified",
  "proposal_sent",
  "won",
  "lost",
]);

export const deals = pgTable(
  "deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    /** The contact the deal is with. Erasing them erases the deal (rule 29). */
    contact_id: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** The organisation, as the owner wrote it. Null for a deal with a person. */
    company: text("company"),
    /** What the deal is, in the owner's words. */
    title: text("title").notNull(),
    stage: dealStage("stage").notNull().default("lead"),
    /** When the deal entered its current stage — stage ageing counts from here. */
    stage_entered_at: timestamp("stage_entered_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    /** Integer minor units + currency + basis, all or none (rules 1 and 2). */
    value_minor: bigint("value_minor", { mode: "number" }),
    value_currency: text("value_currency"),
    /** "quoted": a price put to them; "estimated": the owner's guess. */
    value_basis: text("value_basis"),
    expected_close: date("expected_close", { mode: "string" }),
    next_step: text("next_step"),
    next_step_due: date("next_step_due", { mode: "string" }),
    /** When the owner last spoke to them about it, as the owner said. Null = not stated. */
    last_contact_at: timestamp("last_contact_at", { withTimezone: true, mode: "string" }),
    /** Where the deal came from: the owner on /pipeline, or an attested import. */
    source: text("source").notNull(),
    /** "added on /pipeline", or "import batch <id>: <the owner's attestation>". */
    source_note: text("source_note").notNull(),
    /** Set when the deal is won or lost, cleared if it is reopened. */
    closed_at: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("deals_profile_stage_idx").on(t.profile_id, t.stage),
    index("deals_contact_idx").on(t.contact_id),
    check(
      "deals_value_whole",
      sql`(${t.value_minor} IS NULL) = (${t.value_currency} IS NULL) AND (${t.value_minor} IS NULL) = (${t.value_basis} IS NULL)`,
    ),
    check("deals_value_not_negative", sql`${t.value_minor} IS NULL OR ${t.value_minor} >= 0`),
    check(
      "deals_value_basis_known",
      sql`${t.value_basis} IS NULL OR ${t.value_basis} IN ('quoted', 'estimated')`,
    ),
    check("deals_source_known", sql`${t.source} IN ('owner_input', 'import')`),
    check("deals_title_present", sql`length(trim(${t.title})) > 0`),
    check(
      "deals_closed_iff_won_or_lost",
      sql`(${t.closed_at} IS NOT NULL) = (${t.stage} IN ('won', 'lost'))`,
    ),
    check(
      "deals_due_has_step",
      sql`${t.next_step_due} IS NULL OR (${t.next_step} IS NOT NULL AND length(trim(${t.next_step})) > 0)`,
    ),
  ],
);

/** One row per change to a deal: what it was and what it became. Goes with the deal. */
export const dealEvents = pgTable(
  "deal_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    account_id: uuid("account_id").notNull(),
    /** created | stage | value | next_step | expected_close | contacted */
    kind: text("kind").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    /** owner_input | import */
    source: text("source").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    index("deal_events_deal_idx").on(t.deal_id, t.at),
    check(
      "deal_events_kind_known",
      sql`${t.kind} IN ('created', 'stage', 'value', 'next_step', 'expected_close', 'contacted')`,
    ),
  ],
);

/**
 * P5-16: a follow-up email drafted for an approved follow-up proposal —
 * one per proposal. It is never sent by SYB: the owner copies it into
 * their own mail. The body holds a {{name}} slot, never the name, and goes
 * with the deal on erasure.
 */
export const dealFollowups = pgTable(
  "deal_followups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id").notNull(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    proposal_id: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    disclosure: text("disclosure").notNull(),
    /** The model, the voice card and the brief exactly as sent — the brief names no one. */
    provenance: jsonb("provenance").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("deal_followups_proposal_idx").on(t.proposal_id),
    index("deal_followups_account_idx").on(t.account_id, t.created_at),
  ],
);

// P5-11..13: one run of the site audit — the website as a customer meets it
// (TASKS-PHASE5.md Session C, rule 30). What Google's PageSpeed Insights
// measured on the home page and up to four key pages, at mobile and
// desktop, each number with its provenance (field or lab, when, which
// Lighthouse); what reading the site's own pages found on the path to
// buying; and the measured SiteFindings with their thresholds. Raw
// measurement like niche_ad_reads, not a Field<T>: the audit also writes
// one fact (presence.site_audit) that the diagnosis cites. `pagespeed_calls`
// is what the weekly per-site cap counts (lib/site/audit/service.ts).
export const siteAudits = pgTable(
  "site_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    /** "read" — measured and stored; "failed" — the home page couldn't be read, `reason` says why. */
    status: text("status").notNull(),
    ran_at: timestamp("ran_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    /** The home page as the owner gave it (2.1.2.1). */
    url: text("url").notNull(),
    /** scheme://host — the "site" the weekly cap is per. */
    origin: text("origin").notNull(),
    /** PlatformVerdict (lib/site/platform.ts), from the home page. */
    platform: jsonb("platform"),
    /** The pages walked and measured: role, clicks from home, PageSpeed results per strategy. */
    pages: jsonb("pages").$type<Record<string, unknown>[]>().notNull().default([]),
    /** The path to buying (lib/site/audit/walk.ts PurchasePath) and broken links. */
    path: jsonb("path").$type<Record<string, unknown>>().notNull().default({}),
    /** SiteFinding[] (lib/site/audit/findings.ts), severest first. */
    findings: jsonb("findings").$type<Record<string, unknown>[]>().notNull().default([]),
    /** PageSpeed Insights requests this run made, retries included — the weekly cap counts these. */
    pagespeed_calls: integer("pagespeed_calls").notNull().default(0),
    /** Page GETs the walk made. */
    page_reads: integer("page_reads").notNull().default(0),
    /** True when PAGESPEED_API_KEY was set; false means no key, so speed wasn't measured. */
    pagespeed_keyed: boolean("pagespeed_keyed").notNull().default(false),
    /** Why PageSpeed measured fewer pages than asked, in words; null when it measured all. */
    pagespeed_note: text("pagespeed_note"),
    reason: text("reason"),
  },
  (t) => [
    index("site_audits_profile_idx").on(t.profile_id, t.ran_at),
    index("site_audits_origin_idx").on(t.origin, t.ran_at),
    check("site_audits_status", sql`${t.status} IN ('read', 'failed')`),
    check("site_audits_failed_says_why", sql`${t.status} <> 'failed' OR ${t.reason} IS NOT NULL`),
    check("site_audits_calls_nonneg", sql`${t.pagespeed_calls} >= 0 AND ${t.page_reads} >= 0`),
  ],
);

// Idea 54: SYB's own track record — its forecasts, recorded when they are
// made and graded once their window has passed, against measured rows only
// (TASKS-FEEDBACK.md I-54.1). One row per forecast per window
// (`forecast_key`, unique per profile). The claim is what was shown then:
// the range (money as integer minor units with its currency, rule 1; a
// count; or dates), the sentence and the basis sentence (rule 25). The
// grading columns are empty at insert and filled exactly once, by the
// grader (lib/forecasts/grade.ts). Triggers in migration 0067 refuse a row
// inserted already graded, any change to a claim, any second grading, and a
// delete that doesn't come with the business's own (a cascade). `made_at` is
// when the forecast was shown; `recorded_at` is Postgres's own clock, so a
// backdated row (the demo seed's, and only the seed's) shows as one.
export const forecastChecks = pgTable(
  "forecast_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    /** "stock_out" (lib/stock) | "season_week" (lib/seasons) | "cash_close" (lib/cash, I-54a). */
    kind: text("kind").notNull(),
    /** Once per window: e.g. "season_week|<connection>|revenue.daily|EUR|2026-11-02". */
    forecast_key: text("forecast_key").notNull(),
    made_at: timestamp("made_at", { withTimezone: true, mode: "string" }).notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    /** What it is about, in the owner's words: an item's name, "revenue". */
    subject: text("subject").notNull(),
    /** Where the actual will be read: connection, product or metric, and what the claim started from. */
    subject_ref: jsonb("subject_ref").$type<Record<string, unknown>>().notNull(),
    /** The measured metric that grades it: "stock.on_hand", "revenue.daily". */
    metric: text("metric").notNull(),
    /** Which pair of low/high columns holds the range. */
    unit: text("unit").notNull(),
    window_start: date("window_start", { mode: "string" }).notNull(),
    window_end: date("window_end", { mode: "string" }).notNull(),
    low_minor: bigint("low_minor", { mode: "number" }),
    high_minor: bigint("high_minor", { mode: "number" }),
    currency: text("currency"),
    low_num: numeric("low_num", { precision: 18, scale: 4 }),
    high_num: numeric("high_num", { precision: 18, scale: 4 }),
    low_date: date("low_date", { mode: "string" }),
    high_date: date("high_date", { mode: "string" }),
    /** What I said, as it was shown. */
    claim: text("claim").notNull(),
    /** What it rested on, in words (rule 25). */
    basis: text("basis").notNull(),
    graded_at: timestamp("graded_at", { withTimezone: true, mode: "string" }),
    /** "inside" | "above" | "below" | "cant_tell". */
    verdict: text("verdict"),
    actual_minor: bigint("actual_minor", { mode: "number" }),
    actual_num: numeric("actual_num", { precision: 18, scale: 4 }),
    actual_date: date("actual_date", { mode: "string" }),
    /** What happened, in words; for "can't tell", why not. */
    actual_note: text("actual_note"),
    /** The measured rows it was read from: { table, ids }. */
    actual_source: jsonb("actual_source").$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("forecast_checks_key_idx").on(t.profile_id, t.forecast_key),
    index("forecast_checks_due_idx")
      .on(t.window_end)
      .where(sql`${t.graded_at} IS NULL`),
    index("forecast_checks_profile_idx").on(t.profile_id, t.made_at),
    check("forecast_checks_kind", sql`${t.kind} IN ('stock_out', 'season_week', 'cash_close')`),
    check("forecast_checks_unit", sql`${t.unit} IN ('money', 'count', 'date')`),
    check("forecast_checks_window", sql`${t.window_start} <= ${t.window_end}`),
    check(
      "forecast_checks_money",
      sql`${t.unit} <> 'money' OR (${t.low_minor} IS NOT NULL AND ${t.high_minor} IS NOT NULL AND ${t.low_minor} <= ${t.high_minor} AND ${t.currency} IS NOT NULL AND ${t.currency} ~ '^[A-Z]{3}$')`,
    ),
    check(
      "forecast_checks_count",
      sql`${t.unit} <> 'count' OR (${t.low_num} IS NOT NULL AND ${t.high_num} IS NOT NULL AND ${t.low_num} <= ${t.high_num})`,
    ),
    check(
      "forecast_checks_date",
      sql`${t.unit} <> 'date' OR (${t.low_date} IS NOT NULL AND ${t.high_date} IS NOT NULL AND ${t.low_date} <= ${t.high_date})`,
    ),
    check(
      "forecast_checks_verdict",
      sql`${t.verdict} IS NULL OR ${t.verdict} IN ('inside', 'above', 'below', 'cant_tell')`,
    ),
    check(
      "forecast_checks_graded_whole",
      sql`(${t.graded_at} IS NULL) = (${t.verdict} IS NULL) AND (${t.graded_at} IS NULL) = (${t.actual_note} IS NULL)`,
    ),
    check(
      "forecast_checks_actual_measured",
      sql`${t.verdict} IS NULL OR ${t.verdict} = 'cant_tell' OR ${t.actual_source} IS NOT NULL`,
    ),
  ],
);

/* ---------- Idea 53 — one-tap approvals on your phone ---------- */

/**
 * One browser's Web Push subscription (idea 53, I-53.2). Whoever holds an
 * endpoint and its keys can push to that phone, so the subscription is a
 * secret: `encrypted_subscription` is the JSON {endpoint, keys: {p256dh,
 * auth}} sealed with the connector secrets' AES-256-GCM key path
 * (lib/connectors/secrets.ts, rule 10), never logged and never returned by
 * any API. `endpoint_hash` is a keyed HMAC of the endpoint, so the same
 * browser switching on twice updates one row without the endpoint being
 * readable. A row goes when its device signs out (the session it was made
 * in), when the push service answers 404 or 410, and with its user or
 * account. `device_label` is the coarse word from the user agent ("iPhone",
 * "Android", "Mac"), never the agent string. `time_zone` is the browser's
 * own IANA zone, read only when the business's timezone isn't known, for
 * quiet hours. `last_sent_at` is the last alert sent to it (a test doesn't
 * count): the daily cap reads it.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The sign-in it was switched on in: signing out of that browser removes it. */
    session_id: uuid("session_id").references(() => authSessions.id, { onDelete: "cascade" }),
    device_label: text("device_label").notNull(),
    endpoint_hash: text("endpoint_hash").notNull(),
    encrypted_subscription: text("encrypted_subscription").notNull(),
    time_zone: text("time_zone"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    last_sent_at: timestamp("last_sent_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_idx").on(t.endpoint_hash),
    index("push_subscriptions_account_idx").on(t.account_id),
    check(
      "push_subscriptions_label",
      sql`${t.device_label} IN ('iPhone', 'iPad', 'Android', 'Mac', 'Windows', 'Linux', 'Browser')`,
    ),
  ],
);

/**
 * Proposals that became pending and haven't been pushed yet (idea 53,
 * I-53.4). Written in createProposal's own transaction, only when the
 * account has a subscribed device, so a proposal that rolls back leaves no
 * push behind. The flush reads an account's rows, lets pushPlan decide
 * (send grouped, hold for quiet hours or the daily cap, or drop), and
 * deletes what it sent or dropped. Holds ids only.
 */
export const pushOutbox = pgTable(
  "push_outbox",
  {
    proposal_id: uuid("proposal_id")
      .primaryKey()
      .references(() => proposals.id, { onDelete: "cascade" }),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("push_outbox_profile_idx").on(t.profile_id)],
);

/* ---------- Idea 45 — bad-review alerts ---------- */

// Reviews arrive the way the owner already gets them: the notification
// emails Google, Trustpilot, Booksy and Fresha send, forwarded to
// r-<token>@<SUPPORT_INBOUND_DOMAIN> (the support inbox's Resend webhook,
// routed by the r- prefix), or pasted on /reviews. SYB never connects a
// review platform (its only Google scope can write, I-45a) and never posts.
//
// Reviewers are people: `reviewer` is only what the platform showed
// publicly, the row is erasable (remove this review) and expires 365 days
// after it was filed. No reviewer becomes a contact, and no review is
// consent (rule 19). The decision log records an erasure by ids and a hash.

/** Gmail's forwarding confirmation, as kept (review_settings.gmail_confirmation). */
export interface GmailConfirmation {
  code: string | null;
  link: string | null;
  at: string;
}

export const reviewSettings = pgTable(
  "review_settings",
  {
    profile_id: uuid("profile_id")
      .primaryKey()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    /** The token in r-<token>@<domain>: 32 hex chars, unguessable, rotatable. It lets someone file a review, nothing more. */
    inbound_token: text("inbound_token")
      .notNull()
      .default(sql`replace(gen_random_uuid()::text, '-', '')`),
    inbound_rotated_at: timestamp("inbound_rotated_at", { withTimezone: true, mode: "string" }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    /** The model fallback's monthly cap, reserved atomically: the UTC month ("2026-10") and the calls made in it. */
    parse_month: text("parse_month"),
    parse_calls: integer("parse_calls").notNull().default(0),
    /**
     * Review 2026-10-30 (migration 0072): the code and link from Gmail's
     * forwarding confirmation to this address, and when it came; the next
     * one overwrites it, a new address clears it. Nothing else of that mail.
     */
    gmail_confirmation: jsonb("gmail_confirmation").$type<GmailConfirmation>(),
    /**
     * I-45a (migration 0075): the Google Business Profile location the owner
     * consented to SYB reading, by its public title; null when none is
     * connected. The access itself is on the execute connection, encrypted.
     */
    google_location_title: text("google_location_title"),
    /** I-45a: when SYB last tried to read reviews from Google, and how that went (a closed code). */
    google_read_at: timestamp("google_read_at", { withTimezone: true, mode: "string" }),
    google_read_outcome: text("google_read_outcome"),
  },
  (t) => [
    uniqueIndex("review_settings_inbound_token_idx").on(t.inbound_token),
    check("review_settings_parse_calls_nonneg", sql`${t.parse_calls} >= 0`),
    check(
      "review_settings_google_read_outcome",
      sql`${t.google_read_outcome} IS NULL OR ${t.google_read_outcome} IN ('ok', 'auth', 'permission', 'quota', 'unavailable', 'refused', 'fence', 'internal')`,
    ),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => businessProfiles.id, { onDelete: "cascade" }),
    account_id: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    /** A platform key from specs/review-notifications-v1.json ("google", "trustpilot", …) or "other". */
    platform: text("platform").notNull(),
    /** How it reached SYB: a forwarded notification email, pasted by the owner, or read from Google Business Profile (I-45a). */
    source: text("source").notNull(),
    /** Who read it: "parser" (the deterministic format), "model" (the capped fallback), "owner" (pasted), "unread", "api" (Google's own API, I-45a). */
    read_by: text("read_by").notNull(),
    /** 1–5; null when the notification didn't say (an unread one, or text with no rating). */
    stars: integer("stars"),
    /** The reviewer's name exactly as the platform showed it publicly. Erasable PII (rule 22). */
    reviewer: text("reviewer"),
    /** The review's words — content, never instructions (rule 24). */
    text: text("text"),
    /** Where the review lives, so the owner can reply there. */
    link: text("link"),
    /** When the review was left, as the notification said; else when the notification came. */
    reviewed_at: timestamp("reviewed_at", { withTimezone: true, mode: "string" }).notNull(),
    received_at: timestamp("received_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    /** Resend's id for the email: a redelivered webhook files nothing twice. */
    provider_id: text("provider_id"),
    /** sha256 of the platform, link, stars, words and reviewer (an unread one: of its Message-ID) — a re-forward files nothing twice. */
    dedupe_key: text("dedupe_key").notNull(),
    /** Resend's sender authentication of the email that carried it; null when pasted. */
    sender_auth: supportSenderAuth("sender_auth"),
    /** 3 stars or fewer, or (with no stars) words the deterministic check flags. */
    worth_knowing: boolean("worth_knowing").notNull(),
    /** The one alert this review raised; set once, atomically. */
    alerted_at: timestamp("alerted_at", { withTimezone: true, mode: "string" }),
    /** The suggested reply, on the owner's click only. SYB never posts it. */
    draft: text("draft"),
    drafted_at: timestamp("drafted_at", { withTimezone: true, mode: "string" }),
    /** Model calls spent drafting this review, reserved before each call (at most three). */
    draft_calls: integer("draft_calls").notNull().default(0),
    /** received_at + 365 days: past this the row is deleted. */
    expires_at: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [
    uniqueIndex("reviews_dedupe_idx").on(t.profile_id, t.platform, t.dedupe_key),
    uniqueIndex("reviews_provider_idx").on(t.provider_id),
    index("reviews_profile_received_idx").on(t.profile_id, t.received_at),
    index("reviews_expires_idx").on(t.expires_at),
    check("reviews_stars_range", sql`${t.stars} IS NULL OR ${t.stars} BETWEEN 1 AND 5`),
    // I-45a (migration 0075): 'google' — read from the owner's Business Profile, by the API ('api').
    check("reviews_source", sql`${t.source} IN ('email', 'paste', 'google')`),
    check("reviews_read_by", sql`${t.read_by} IN ('parser', 'model', 'owner', 'unread', 'api')`),
    check("reviews_draft_calls_range", sql`${t.draft_calls} BETWEEN 0 AND 3`),
    check("reviews_expiry_after_receipt", sql`${t.expires_at} > ${t.received_at}`),
  ],
);
