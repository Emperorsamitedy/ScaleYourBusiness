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
// Vocabularies — §3.4 / step 16. The 55 controlled lists from the question
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

export const findingKind = pgEnum("finding_kind", [
  "gap",
  "contradiction",
  "implausible",
  "stale",
]);

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
    taken_at: timestamp("taken_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
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
  },
  (t) => [index("diagnosis_reports_profile_idx").on(t.profile_id, t.generated_at)],
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
    /** Stripe Checkout Session id — the join key for the webhook. */
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
    uniqueIndex("payments_checkout_idx").on(t.checkout_session_id),
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
