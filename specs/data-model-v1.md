# V1 Data Model Specification

**Scope:** intake → validated business profile → mode decision → diagnosis report.
**Status:** draft for review. Open decisions are listed in section 12.
**Notation:** TypeScript-style interfaces, used as a precise description of shape — not a commitment to any language or database.

---

## 1. What this document is for

Everything in v1 is a read or a write against the structures defined here. The intake UI writes fields; the validator reads them and writes findings; the mode decision reads a specific subset; the diagnosis report reads the whole profile and writes findings and recommendations. Later phases (marketing, finance, support) add modules that read this same profile and write proposals against it.

If a later module needs data this schema can't hold, the schema is extended — never bypassed. There is one source of truth about a business and this is it.

## 2. Design principles

These five decisions shape every structure below. They are the reason the schema looks more complicated than "a form with 300 fields."

**2.1 No bare values.** Every captured fact is wrapped with its provenance, confidence, and timestamp. "Monthly revenue is 4,200,000 HUF" is not usable on its own — the system needs to know whether the owner typed that, whether it came from a Stripe connector, when it was true, and how much to trust it. A diagnosis built on unmarked guesses is worse than no diagnosis.

**2.2 Facts are dated, not overwritten.** When a value changes, the old one is superseded, not deleted. This gives price history, revenue trends, and an audit trail for free, and it means the system can say "you told me 40% margin in March and 22% in June" — which is exactly the contradiction detection you asked for.

**2.3 The question bank is data, not code.** MAIN.txt becomes a versioned collection of question records with machine-readable display conditions. Branching logic lives in the data, so fixing a wrong `if` is a content edit rather than a deploy, and the adaptive interviewer can reason over the whole bank at once.

**2.4 Repeated things are entities, not nested blobs.** Offers, suppliers, competitors, channels, staff roles, cost items and customer segments each get their own record with a stable ID. They are referenced by ID everywhere else. This is what makes "which channel sells the most profitable offer" answerable instead of requiring text parsing.

**2.5 Missing data never blocks progress.** Completeness is measured, not enforced. The system proceeds with what it has, marks what it lacks, and lowers the confidence of any conclusion that depended on a gap. The intake is a conversation that continues for the life of the account, not a gate at the door.

---

## 3. Core primitives

### 3.1 Field wrapper

The atomic unit of the profile.

```ts
interface Field<T> {
  id: FieldId;                 // stable path, e.g. "revenue.monthly_current"
  value: T | null;
  status: FieldStatus;
  confidence: Confidence;      // 0.0–1.0, see §8
  source: SourceRef;
  observed_at: ISODateTime;    // when this was true, not when it was recorded
  recorded_at: ISODateTime;
  superseded_by: FieldRecordId | null;
  note: string | null;         // owner's free-text qualifier, e.g. "roughly, before VAT"
}

type FieldStatus =
  | "answered"        // owner or connector supplied a value
  | "unknown"         // owner explicitly said they don't know
  | "not_applicable"  // condition made it irrelevant
  | "skipped"         // owner declined or deferred
  | "inferred"        // system derived it, see SourceRef.kind = "inferred"
  | "unasked";        // never presented
```

The distinction between `unknown`, `skipped` and `unasked` matters more than it looks. "I don't know my churn rate" is a finding in itself — it tells you the business has no retention visibility. "I skipped it" means ask again later. "Never asked" means the interviewer decided it wasn't relevant yet.

### 3.2 Source reference

```ts
interface SourceRef {
  kind: "owner_input" | "connector" | "document" | "inferred" | "web_research" | "system_default";
  connector_id?: ConnectorId;      // e.g. "shopify", "meta_ads", "stripe"
  document_id?: DocumentId;        // uploaded P&L, invoice, screenshot
  derived_from?: FieldId[];        // for inferred values — which fields produced it
  method?: string;                 // "gross_margin = (price - cogs) / price"
  researched_url?: string;         // for web_research, the page it came from
}
```

Every inferred value must name what it was derived from. This is non-negotiable: it's what lets the report say "your margin looks like 18%, calculated from the price and cost you gave for each offer" instead of producing an unexplainable number.

### 3.3 Money, quantities, dates

```ts
interface Money {
  amount_minor: number;   // integer, minor units (fillér, cent) — never a float
  currency: string;       // ISO 4217, e.g. "HUF", "EUR"
}

interface Quantity {
  amount: number;
  unit: string;           // "pcs", "kg", "hours", "m2"
}

interface DateRange {
  from: ISODate;
  to: ISODate | null;     // null = ongoing
}
```

Money is always integer minor units with an explicit currency. A business with a Hungarian bank account and Meta ads billed in EUR has two currencies in one profile; a single `number` field guarantees a wrong total eventually. The profile carries a `reporting_currency` and every aggregate states which currency it is expressed in plus the FX rate and date used.

### 3.4 Enums with escape hatch

```ts
interface EnumValue {
  code: string;           // from a controlled vocabulary
  label_raw?: string;     // what the owner actually typed, if "other"
}
```

Every selectable list in MAIN.txt gets a controlled vocabulary plus `other`. When `other` is used, `label_raw` preserves the owner's wording, and a periodic job reports frequently recurring `other` values as candidates for promotion into the vocabulary. This is how the business-type dropdown gets better over time instead of ossifying.

---

## 4. Identity and account structures

```ts
interface Account {
  id: AccountId;
  created_at: ISODateTime;
  owner_user_id: UserId;
  plan: "trial" | "starter" | "pro";
  locale: string;              // "hu-HU", "en-GB" — drives intake language
  reporting_currency: string;
  business_profile_id: BusinessProfileId;
}

interface User {
  id: UserId;
  account_id: AccountId;
  email: string;
  display_name: string;
  role: "owner" | "manager" | "viewer";
  notification_prefs: NotificationPrefs;
}
```

One account holds exactly one business profile in v1. Multi-business accounts (an owner with three restaurants) are a v2 concern, but the one-to-one is expressed through a foreign key rather than by embedding, so the change is additive rather than structural.

---

## 5. The business profile

### 5.1 Root

```ts
interface BusinessProfile {
  id: BusinessProfileId;
  account_id: AccountId;

  // Section 1 — identity
  identity: IdentitySection;

  // Section 2 — presence
  presence: PresenceSection;

  // Sections 3, 4, 5 — commercial
  offers: OfferId[];
  revenue: RevenueSection;
  costs: CostSection;

  // Sections 6, 7, 8 — market-facing
  customers: CustomerSection;
  channels: ChannelId[];
  marketing: MarketingSection;

  // Sections 9, 10 — internal
  operations: OperationsSection;
  tooling: ToolingSection;

  // Sections 11, 12, 13 — context and direction
  legal: LegalSection;
  competitors: CompetitorId[];
  goals: GoalSection;

  // Section 14
  assets: AssetId[];

  // Derived
  completeness: CompletenessScore;
  last_material_change: ISODateTime;
  schema_version: string;
}
```

The section split follows MAIN.txt deliberately. Keeping the document's structure means you can point at any question in the original and find where it lands, which matters for maintenance and for anyone new reading both.

### 5.2 Identity section

```ts
interface IdentitySection {
  legal_name: Field<string>;
  trading_name: Field<string>;
  business_type: Field<EnumValue>;         // 1.2, searchable vocabulary
  description: Field<string>;              // 1.3, 2–5 sentences
  sells: Field<EnumValue[]>;               // 1.4, multi-select — drives branching
  primary_revenue_driver: Field<EnumValue>;// 1.4.4, only if sells.length > 1
  stage: Field<EnumValue>;                 // 1.5
  current_focus: Field<EnumValue[]>;       // 1.5.1
  founded: Field<ISODate>;
  team_size: Field<number>;
}
```

`sells` is the single most consequential field in the schema. It determines which of the 1.4.x branches exist at all, and it feeds the mode decision. It is asked early and its answer is confirmed rather than assumed when later answers contradict it — for example, an owner who selects "services" but then describes holding inventory triggers a reconciliation prompt.

### 5.3 Offers

The 1.4.x branches and section 3 collapse into one entity with type-specific extensions. A single "offer" table with variants is dramatically easier to query than three parallel structures.

```ts
interface Offer {
  id: OfferId;
  profile_id: BusinessProfileId;

  kind: "physical" | "service" | "digital" | "subscription" | "marketplace_access";
  name: Field<string>;
  description: Field<string>;

  price: Field<Money>;
  price_model: Field<EnumValue>;      // one_time | subscription | usage | freemium | ...
  cost_to_deliver: Field<Money>;
  margin_stated: Field<number>;       // owner's figure, if given
  margin_computed: Field<number>;     // inferred; see §8.3 on conflict handling

  volume_period: Field<Quantity>;     // units sold per month
  purchase_type: Field<EnumValue>;    // one_time | recurring | repeat
  lifecycle: Field<EnumValue>;        // active | planned | discontinued
  main_customer_segment: Field<SegmentId>;

  is_best_seller: Field<boolean>;     // 3.2
  is_most_profitable: Field<boolean>; // 3.3
  is_strategic: Field<boolean>;       // 3.4
  problems: Field<EnumValue[]>;       // 3.5

  physical?: PhysicalOfferDetail;
  service?: ServiceOfferDetail;
  digital?: DigitalOfferDetail;
}
```

```ts
interface PhysicalOfferDetail {
  holds_inventory: Field<EnumValue>;        // yes | no | partly
  inventory: InventoryRecord | null;        // if yes
  no_inventory_model: Field<EnumValue>;     // dropship | made_to_order | preorder | supplier_shipped | hybrid
  supplier_ids: SupplierId[];
  manufactures_in_house: Field<boolean>;
  production: ProductionDetail | null;
  shipping: ShippingDetail | null;
  local_delivery: LocalDeliveryDetail | null;
}

interface InventoryRecord {
  current_level: Field<Quantity>;
  storage_location: Field<string>;
  storage_cost_monthly: Field<Money>;
  tracking_method: Field<EnumValue>;        // spreadsheet | pos | erp | none | ...
  restock_frequency: Field<EnumValue>;
  stockout_frequency: Field<EnumValue>;
  is_slow_moving: Field<boolean>;
  dead_stock_value: Field<Money>;
}
```

`InventoryRecord` is written as a per-offer record rather than a business-level list on purpose. Your window A / window B example only works if stock level, sales velocity and capital tied up are all attached to the same offer — that comparison is a single query against this shape, and it's one of the strongest early diagnosis findings the system can produce.

```ts
interface ServiceOfferDetail {
  duration: Field<Quantity>;                // hours per delivery
  delivered_by: Field<string>;
  is_standardized: Field<EnumValue>;        // standard | custom | mixed
  is_scalable: Field<boolean>;
  delivery_steps: Field<string>;            // 1.4.2.2, free text initially
  booking: BookingDetail | null;            // 1.4.2.3
  key_person_dependency: KeyPersonDetail;   // 1.4.2.4 — feeds risk analysis
  quality_process: Field<EnumValue[]>;      // 1.4.2.5
}

interface DigitalOfferDetail {
  product_type: Field<EnumValue>;           // saas | mobile_app | course | template | ...
  stage: Field<EnumValue>;                  // idea | prototype | mvp | beta | launched | ...
  registered_users: Field<number>;
  paying_users: Field<number>;
  monthly_active_users: Field<number>;
  churn_rate_monthly: Field<number>;
  trial_conversion_rate: Field<number>;
  arpu: Field<Money>;
  top_cancel_reason: Field<string>;
  hosting: Field<string>;
  tech_stack: Field<string[]>;
  blocking_issues: Field<string>;
}
```

### 5.4 Suppliers, staff, segments, channels, competitors

These follow the same pattern — standalone entities referenced by ID. Abbreviated here to their distinguishing fields.

```ts
interface Supplier {
  id: SupplierId;
  name: Field<string>;
  country: Field<string>;
  purchase_price: Field<Money>;
  moq: Field<Quantity>;
  lead_time_days: Field<number>;
  payment_terms: Field<string>;
  reliability_issues: Field<string>;
  has_alternative: Field<boolean>;
  import_duties_apply: Field<boolean>;
  concentration_risk: Field<boolean>;       // inferred: sole supplier for a top offer
}

interface StaffRole {
  id: StaffRoleId;
  role_title: Field<string>;
  engagement: Field<EnumValue>;             // employee | contractor | agency | freelancer | partner
  main_tasks: Field<string[]>;
  hours_per_week: Field<number>;
  cost_monthly: Field<Money>;
  replaceability: Field<EnumValue>;         // easy | hard | single_point_of_failure
  is_owner: boolean;
}

interface CustomerSegment {
  id: SegmentId;
  name: Field<string>;
  b2b_or_b2c: Field<EnumValue>;
  demographics: Field<string>;
  location: Field<string>;
  main_problem_solved: Field<string>;
  purchase_frequency: Field<EnumValue>;
  average_spend: Field<Money>;
  acquisition_source: Field<ChannelId[]>;
  objections: Field<string[]>;
  value_tier: Field<EnumValue>;             // inferred: high | medium | low
}

interface Channel {
  id: ChannelId;
  type: Field<EnumValue>;                   // website | store | marketplace | social | ads | referral | ...
  platform: Field<EnumValue>;               // shopify | instagram | google_ads | ...
  monthly_leads: Field<number>;
  monthly_sales: Field<number>;
  conversion_rate: Field<number>;
  revenue_monthly: Field<Money>;
  cost_monthly: Field<Money>;
  effort_level: Field<EnumValue>;
  customer_quality: Field<EnumValue>;
  trend: Field<EnumValue>;                  // growing | stable | declining
  roi_computed: Field<number>;              // inferred
  is_primary: Field<boolean>;
  monthly_sessions: Field<number>;          // Phase 2: measured only, from an analytics
                                            // connector's channel matched to this one
}
```

Phase 2 measured-only fields, written by connectors and never asked in the
intake: `presence.monthly_sessions` (website sessions a month, business-wide)
and `marketing.cost_per_purchase` measured as ad spend over the purchases the
ad platform attributes (the intake asks the owner's estimate of the same
thing; measurement supersedes it, rule 11).

```ts

interface Competitor {
  id: CompetitorId;
  name: Field<string>;
  url: Field<string>;
  what_they_sell: Field<string>;
  price_points: Field<Money[]>;
  strengths: Field<string[]>;
  weaknesses: Field<string[]>;
  positioning_angle: Field<string>;         // what their marketing is built on
  source: SourceRef;                        // owner-stated vs web-researched
  researched_at: ISODateTime | null;
}
```

`Competitor.positioning_angle` and `source` exist specifically for the Bobby's Windows scenario: the system needs to distinguish what the owner believes about a competitor from what research actually found, and it needs a structured place to record "this competitor's marketing is built on reviews" so the positioning recommendation can deliberately choose a different axis.

### 5.5 Revenue, costs, and the financial spine

```ts
interface RevenueSection {
  generates_revenue: Field<EnumValue>;      // yes | no | not_launched | previously
  monthly_revenue: Field<Money>;
  annual_revenue: Field<Money>;
  monthly_history: RevenuePoint[];          // dated series, not a single number
  order_count_monthly: Field<number>;
  average_order_value: Field<Money>;        // inferred where possible
  repeat_customer_rate: Field<number>;
  revenue_by_offer: Map<OfferId, Money>;
  revenue_by_channel: Map<ChannelId, Money>;
  seasonality: Field<SeasonalityPattern>;
  trend: Field<EnumValue>;                  // growing | stable | declining
  payment: PaymentDetail;
  price_history: PriceChange[];
  pre_launch?: PreLaunchDetail;             // if not yet generating
}

interface RevenuePoint {
  period: ISOMonth;
  amount: Money;
  source: SourceRef;
}

interface CostSection {
  fixed_monthly: CostItem[];
  variable: CostItem[];
  gross_margin: Field<number>;
  net_margin: Field<number>;
  breakeven_monthly: Field<Money>;          // inferred
  largest_cost_category: Field<string>;     // inferred
  cash_flow_problems: Field<boolean>;
  late_payments: Field<boolean>;
  debt: Field<Money>;
}

interface CostItem {
  id: CostItemId;
  category: Field<EnumValue>;               // rent | salaries | software | ads | materials | ...
  label: Field<string>;
  amount: Field<Money>;
  cadence: Field<EnumValue>;                // monthly | annual | per_unit | per_job
  scales_with_sales: boolean;
  linked_offer_id?: OfferId;
}
```

Revenue is a dated series rather than a scalar because trend detection, seasonality, and the anomaly alerts in later phases all need history. Even at intake, asking for "best month and worst month" (MAIN.txt 4.1) populates two points, and a connector backfills the rest.

---

## 6. Intake structures

### 6.1 Question bank

```ts
interface Question {
  id: QuestionId;                  // "1.4.1.2", stable, maps to MAIN.txt
  version: number;
  section: SectionId;
  writes_to: FieldId;              // where the answer lands
  prompt: LocalizedText;
  help_text: LocalizedText | null;
  input: InputSpec;
  condition: ConditionExpr | null; // when to show
  priority: QuestionPriority;
  cost: 1 | 2 | 3;                 // effort to answer — cheap facts before hard ones
  unlocks: QuestionId[];           // hint for the interviewer, not a hard sequence
}

type QuestionPriority = "core" | "important" | "deep" | "optional";

interface InputSpec {
  type: "text" | "long_text" | "number" | "money" | "single_select"
      | "multi_select" | "boolean" | "date" | "entity_list" | "file";
  vocabulary_id?: VocabularyId;     // for selects
  entity_schema?: "offer" | "supplier" | "competitor" | "channel" | "staff_role";
  min?: number;
  max?: number;
  allow_unknown: boolean;           // renders an explicit "I don't know" affordance
}
```

`allow_unknown` defaults to true. An intake that forces a number out of an owner who doesn't have one produces a confident wrong profile, which is worse than an honest gap.

`cost` and `priority` together let the interviewer sequence intelligently: all `core` questions of cost 1 before any `deep` question of cost 3, so the owner reaches a usable profile before hitting the hard ones.

### 6.2 Conditions

Branching is expressed in a small, serializable expression language rather than embedded code.

```ts
type ConditionExpr =
  | { op: "eq" | "neq"; field: FieldId; value: unknown }
  | { op: "includes"; field: FieldId; value: string }
  | { op: "gt" | "gte" | "lt" | "lte"; field: FieldId; value: number }
  | { op: "answered" | "unanswered"; field: FieldId }
  | { op: "and" | "or"; terms: ConditionExpr[] }
  | { op: "not"; term: ConditionExpr };
```

Example, for the inventory branch:

```json
{
  "id": "1.4.1.2",
  "writes_to": "offer.physical.holds_inventory",
  "condition": {
    "op": "includes",
    "field": "identity.sells",
    "value": "physical_products"
  }
}
```

This is the direct fix for the branching errors you flagged. Conditions become testable data: a lint pass can find questions whose condition references a field no question writes to, questions unreachable under any answer combination, and questions asked in more than one branch.

### 6.3 Session and turns

```ts
interface IntakeSession {
  id: SessionId;
  profile_id: BusinessProfileId;
  started_at: ISODateTime;
  completed_core_at: ISODateTime | null;
  turns: IntakeTurn[];
  state: "in_progress" | "core_complete" | "paused" | "deepening";
}

interface IntakeTurn {
  index: number;
  question_id: QuestionId;
  asked_at: ISODateTime;
  answered_at: ISODateTime | null;
  raw_answer: unknown;
  parsed_value: unknown;
  status: FieldStatus;
  time_to_answer_ms: number;
  was_edited_later: boolean;
  selection_reason: string;         // why the interviewer chose this question now
}
```

`selection_reason` is worth the storage. When the intake feels wrong — asks something irrelevant, or misses something obvious — this is the only way to debug the interviewer's judgement after the fact.

`time_to_answer_ms` and `was_edited_later` are signals, not analytics vanity: a question answered in two seconds and edited twice later is a badly worded question, and this data is what tells you which ones to rewrite.

---

## 7. Validation

```ts
interface ValidationFinding {
  id: FindingId;
  profile_id: BusinessProfileId;
  kind: "gap" | "contradiction" | "implausible" | "stale";
  severity: "blocking" | "high" | "medium" | "low";
  fields: FieldId[];               // what's involved
  rule_id: string;
  message: LocalizedText;
  resolution: FindingResolution | null;
  detected_at: ISODateTime;
}

interface FindingResolution {
  resolved_at: ISODateTime;
  method: "owner_corrected" | "owner_confirmed" | "auto_resolved" | "dismissed";
  note: string | null;
}
```

Rules are declarative and versioned. A representative starting set:

| Rule | Kind | Trigger |
|---|---|---|
| `margin_mismatch` | contradiction | stated margin differs from computed margin by more than 10 percentage points |
| `revenue_vs_offers` | contradiction | sum of per-offer revenue differs from stated total by more than 20% |
| `costs_exceed_revenue` | implausible | fixed + variable costs exceed stated revenue while trend is "growing" |
| `inventory_without_supplier` | gap | physical offer holds inventory but no supplier recorded |
| `channel_without_revenue` | gap | channel marked primary has no revenue figure |
| `key_person_undocumented` | gap | service depends on one person and no SOPs exist |
| `stage_vs_revenue` | contradiction | stage is "idea" but revenue is non-zero |
| `stale_financials` | stale | newest revenue point older than 90 days |
| `single_supplier_top_offer` | gap | best-selling offer has exactly one supplier with no alternative |

Contradictions are surfaced to the owner as a question, never as an accusation — the phrasing is "help me reconcile these two" and the outcome writes a resolution, not a silent overwrite. Both original values remain in history.

---

## 8. Confidence and completeness

### 8.1 Field confidence

Starting values by source, adjusted by rules:

| Source | Base confidence |
|---|---|
| Connector (Stripe, Shopify, Meta) | 0.95 |
| Uploaded financial document, parsed | 0.85 |
| Owner input, precise (number, selection) | 0.75 |
| Owner input, estimated ("roughly", "about") | 0.55 |
| Inferred from other fields | min(inputs) × 0.9 |
| Web research on a competitor | 0.5 |
| System default | 0.2 |

Adjustments: −0.2 if the field is older than 90 days and the business is in a fast-moving stage; −0.3 if involved in an unresolved contradiction; +0.1 if independently corroborated by a second source.

### 8.2 Completeness

```ts
interface CompletenessScore {
  overall: number;                          // 0–1, weighted
  by_section: Map<SectionId, number>;
  core_complete: boolean;                   // all "core" questions answered or explicitly unknown
  blocking_gaps: FieldId[];                 // gaps that materially limit the diagnosis
  computed_at: ISODateTime;
}
```

Completeness weights `core` questions heavily and `optional` barely at all, so an owner who answers the important 25 sees a high score rather than a demoralizing 8%.

### 8.3 Conflict between stated and computed

When `margin_stated` and `margin_computed` disagree, neither wins automatically. The computed value is used for analysis with a contradiction finding attached, and the report states both. Owners are frequently wrong about their margins, and the moment the system silently overrides an owner's number is the moment it loses their trust — surfacing the discrepancy is more valuable than resolving it quietly.

---

## 9. Mode decision

This reads a defined subset of the profile. Keeping the inputs explicit is what makes the decision auditable and testable rather than a vibe from a prompt.

```ts
interface ModeDecision {
  id: ModeDecisionId;
  profile_id: BusinessProfileId;
  mode: "instant" | "watching";
  watch_weeks: 4 | 6 | 8 | null;
  decided_at: ISODateTime;
  inputs: ModeDecisionInputs;
  reasoning: string;
  confidence: number;
  owner_override: OwnerOverride | null;
  review_at: ISODateTime;
}

interface ModeDecisionInputs {
  stage: EnumValue;
  has_revenue: boolean;
  monthly_order_count: number | null;
  months_operating: number | null;
  employee_count: number;
  has_active_ad_spend: boolean;
  has_customer_support_process: boolean;
  has_existing_automations: boolean;
  data_confidence: number;              // mean confidence of core fields
  completeness: number;
}
```

Decision rule, expressed as a floor rather than a formula:

- `instant` requires **all** of: no revenue or fewer than 10 lifetime orders; zero employees; no active ad spend; no existing support process; operating under 3 months.
- Anything else is `watching`.
- Watch length starts at 6 weeks and moves to 8 when any of: employees present, monthly ad spend above a threshold, more than 100 monthly orders, or `data_confidence` below 0.6. It moves to 4 only when the business is operating but tiny, with high data confidence and no staff.
- If `completeness` is below 0.5, the mode decision is deferred rather than guessed, and the interviewer prioritizes the missing inputs.

The asymmetry is deliberate and matches your instruction: a wrongly-instant decision can damage a live business, a wrongly-long watch period costs a few weeks. When uncertain, wait.

`owner_override` is recorded but constrained — an owner can extend a watch period freely, and can shorten it only with an explicit acknowledgement that is stored with their user ID and timestamp.

---

## 10. Diagnosis output

```ts
interface DiagnosisReport {
  id: ReportId;
  profile_id: BusinessProfileId;
  generated_at: ISODateTime;
  profile_snapshot_id: SnapshotId;      // exact profile state used
  completeness_at_generation: number;

  summary: LocalizedText;
  unit_economics: UnitEconomicsBlock;
  findings: DiagnosisFinding[];
  recommendations: Recommendation[];
  data_gaps: FieldId[];                 // what would most improve the next report
  confidence: number;
}

interface DiagnosisFinding {
  id: FindingId;
  area: ModuleId;                       // marketing | finance | operations | ...
  title: LocalizedText;
  detail: LocalizedText;
  evidence: FieldId[];                  // every claim traces to fields
  severity: "critical" | "high" | "medium" | "low";
  confidence: number;
}

interface Recommendation {
  id: RecommendationId;
  addresses: FindingId[];
  title: LocalizedText;
  rationale: LocalizedText;
  scenario: ScenarioBlock;              // explicit assumptions and break-even math
  effort: "low" | "medium" | "high";
  reversibility: "easy" | "moderate" | "hard";
  requires_modules: ModuleId[];
  status: "proposed" | "accepted" | "rejected" | "deferred";
  rejection_reason: string | null;
}

interface ScenarioBlock {
  assumptions: Assumption[];
  base_case: ScenarioOutcome;
  downside_case: ScenarioOutcome;
  upside_case: ScenarioOutcome;
  breakeven_condition: string;          // "requires ≥18% volume lift to break even"
}

interface Assumption {
  statement: string;
  value: number | Money;
  source: SourceRef;
  sensitivity: "high" | "medium" | "low";   // how much the conclusion depends on it
}
```

Two things here are load-bearing. `evidence: FieldId[]` means no finding can exist without pointing at the data that produced it — this is what stops the report from becoming plausible-sounding filler. And `ScenarioBlock` with explicit `assumptions` is the honest replacement for "run three simulations": it states what must be true for the recommendation to work, and how sensitive the conclusion is to each input, which is defensible in a way a predicted number is not.

`rejection_reason` appears here, in v1, even though the learning loop that consumes it arrives in a later phase. Capturing it from day one means that by the time the loop exists, there is a corpus to learn from.

---

## 11. Extension points for later phases

These are declared now, unimplemented, so that later modules attach rather than restructure.

```ts
interface Proposal {
  id: ProposalId;
  profile_id: BusinessProfileId;
  module: ModuleId;
  originating_finding: FindingId | null;
  action: ProposalAction;               // module-specific payload
  scenario: ScenarioBlock;
  requires_approval: true;              // never optional
  status: "pending" | "approved" | "rejected" | "expired" | "executed";
  decided_by: UserId | null;
  decided_at: ISODateTime | null;
  rejection_reason: string | null;
  execution_result: ExecutionResult | null;
}

interface DecisionLogEntry {
  id: EntryId;
  profile_id: BusinessProfileId;
  at: ISODateTime;
  actor: "system" | "owner";
  kind: "proposal" | "approval" | "rejection" | "execution" | "measurement" | "profile_change" | "erasure";
  ref_id: string;
  payload_hash: string;
}
```

The decision log is append-only. It serves three purposes at once: the learning corpus, the debugging trail, and the compliance record showing that a human approved every consequential action — which matters directly given GDPR Article 22 exposure on anything touching individuals.

---

## 12. Open decisions

These need your input before implementation.

1. **Intake language — CLOSED.** English at launch, international market. Localisation is a supported capability, not a deferred maybe: `LocalizedText` is multi-key everywhere, `locale` sits on the account, and no string is ever hard-coded in a component. Which locales ship, and when, is decided after Gate 1 from real customer geography.
2. **Currency — CLOSED.** Multi-currency is mandatory, not optional. An international customer base means USD, EUR, GBP and more across accounts, and many single accounts mix currencies. `Money` already carries an explicit ISO code, so this is correct by construction; what it adds is FX rate storage and a stated rate-and-date on every aggregate.
3. **Core question count.** I've assumed roughly 25 questions gate the first diagnosis. Do you want to review which 25 before I mark priorities across the bank?
4. **Instant-mode thresholds.** The 10-order and 3-month figures in §9 are my proposal, not yours. They are the most consequential numbers in v1.
5. **Document parsing depth.** Does v1 parse uploaded P&Ls and invoices, or only store them for the owner's reference? Parsing raises confidence significantly but adds real scope.
6. **Profile history retention.** Keeping every superseded field forever is cheapest to reason about; if that's a concern, we need a compaction policy.

---

## 13. What this unlocks next

With this schema fixed, three things can be designed in parallel without stepping on each other: the intake UI (renders `InputSpec`, writes `Field`), the interviewer agent (reads the question bank and profile, selects the next question, writes `selection_reason`), and the diagnosis prompt set (reads the profile, writes `DiagnosisFinding` with `evidence`).

The natural next document is the question bank itself — MAIN.txt converted question by question into the `Question` records defined in §6, with conditions written out and the branching errors corrected. That is mechanical work now that the shape is settled, and it's the artifact the intake UI is built against.
