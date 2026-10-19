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
  "erasure", // Phase 4 rule 22: the fact of an erasure, never its PII
  "import", // Phase 4 P4-03: a contact import batch — hash and counts, no PII
  "takeover", // P3-43: day zero — the business enters care; ref is the frozen snapshot
  "consent", // P3-20h: write access granted (rule 13); ref is the execute connection
  "change_request", // the queue's third answer: not approved, the owner's words on what to change
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
export const connectionPurpose = pgEnum("connection_purpose", ["measure", "execute"]);

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
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    disconnected_at: timestamp("disconnected_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("connections_active_idx")
      .on(t.account_id, t.provider, t.purpose)
      .where(sql`status <> 'disconnected'`),
    index("connections_account_idx").on(t.account_id),
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
  },
  (t) => [
    uniqueIndex("executions_proposal_idx").on(t.proposal_id),
    index("executions_profile_idx").on(t.profile_id, t.started_at),
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
  },
  (t) => [uniqueIndex("support_settings_site_key_idx").on(t.site_key)],
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
// why a human was needed; contact_id arrives with Session C's email
// tickets and is set null on erasure (rule 22).
export const supportTicketReason = pgEnum("support_ticket_reason", [
  "customer_asked",
  "no_answer",
  "cost_cap",
  "conversation_cap",
]);

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
  },
  (t) => [index("support_tickets_profile_idx").on(t.profile_id, t.status, t.created_at)],
);
