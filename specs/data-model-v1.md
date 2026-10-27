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
  internal: boolean;           // P3-40b: SYB's own business — excluded from every cross-customer figure
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
  size_band: Field<EnumValue>;             // 1.6a, business_size: solo | small | medium | large
}
```

`size_band` (bank 1.6.0) is the owner's own sense of the business's size, asked as 1.6a with the bank's words for each code ("Just me", "A small team", "A medium-sized business", "A larger business", carried in the question's `option_labels`). It decides what the app shows them, through the size-feature table in `lib/core/size-features.ts`, and nothing else. Until the owner answers it, a band is inferred from `team_size` on read: an `inferred` Field with `derived_from: ["identity.team_size"]` and the formula at the EU SME headcount boundaries, 1 → solo, 2–9 → small, 10–49 → medium, 50+ → large (`lib/profile/size-band.ts`). The inference is never stored, so it cannot overwrite the owner's answer and does not count as a response: the intake still asks 1.6a. An explicit "I don't know" on the band stays a gap, with no inference over it (rule 5). With neither a band nor a headcount, every feature shows.

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

**Measured stock (feature 34, 2026-10-22).** Measured stock lives beside this record, not in it. A store's stock (Shopify through `read_products`, WooCommerce through its product list) and an imported stock file (a till or a spreadsheet, for a business without a store connector) land as snapshot observations in `metric_observations`, one per item per day read: `stock.on_hand`, `stock.value_at_cost` and `stock.value_at_price` (money, minor units plus currency). A file can also carry `stock.units_sold_window` (with `window_days`) and `stock.days_since_sale`. They are keyed by the store's product id or the file's SKU or name, not by offer, because a shop's products and a till's lines outnumber the owner's offers. Where the owner matched a product to an offer (P2-15), the offer's `cost_to_deliver` stands in for a missing unit cost, labelled as stated. An imported file's observations hang off a `connections` row with purpose `import`: no secret, no scopes, never synced. The slow-stock screen computes velocity, days of cover and cash tied up from these observations with pinned thresholds (`lib/stock/assess.ts`). `current_level` and `is_slow_moving` above stay owner-answer fields and are not yet written from measurement. The owner's `dead_stock_value` is shown against the measured cash tied up in slow stock (rule 11), never replaced by it.

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

Bookings (specs/bookings.md, 2026-10-22), measured from Square's Bookings
read or an owner's bookings export over the 28 days ending on the latest
measured day, never asked in the intake: `service.appointments_completed_28d`
(number), `service.no_show_rate_28d` and `service.late_cancellation_rate_28d`
(percentages of due appointments), `service.booking_revenue_28d`
(`Field<Money>`, list price of completed appointments, not takings), and
`service.utilisation_28d` (percentage of the owner-stated
`service.capacity_per_week`, written only when that was stated). Two bank
fields are superseded by measurement, the owner's figure kept in history
and shown beside it (rule 11): `service.no_show_rate` (1.4.2.3c, long text)
takes the measured rates in words, and `revenue.repeat_customer_rate` (4.1d)
takes the rebooking rate as a percentage. The appointments themselves live
in `booking_appointments`, outside the profile, with a keyed client hash
and no client PII.

Trading hours (Phase 2 Session F, bank 1.3.0):

- `presence.opening_hours` stays the owner's own words (question 2.1.1.7,
  now `important` for visit-based businesses).
- `presence.opening_schedule` is derived from it once by Haiku (inferred,
  `derived_from: presence.opening_hours`, method
  `haiku-opening-hours-v1`). Its shape is `{ days: Record<mon…sun,
  {open,close}[]>, unstated, unparsed }`; a close at or before the open
  runs past midnight.
- `presence.timezone` is an IANA zone, either owner-stated or derived from
  a single-zone `legal.country` (`single-zone-country-map-v1`). It's never
  derived for a multi-zone country.
- `presence.open_hour_cost` is `Field<Money>`, from question 2.1.1.7a.

Email marketing (Phase 4 Session F, bank 1.4.0): `legal.postal_address` is the owner's own words for the address at the foot of marketing emails (question 11.1e, asked unless the owner's consent posture is `no_consent`). The US and Canada require one in every marketing message (`lib/crm/jurisdiction.ts`); a send under those regimes without it is refused by name.

Ad spend ceiling (Phase 3 Session D, bank 1.5.0): `marketing.monthly_ad_ceiling` is `Field<Money>`, the most the owner wants to spend on ads in a month (question 8.1i, asked when they advertise). An ad budget raise (P3-22a/c) that would take the account's total monthly ad spend past it is refused at generation, naming both figures. A ceiling in a different currency from the campaign is never converted: the raise is refused instead (rule 1). A NEW ad (P3-54, "Run this as an ad") needs a stated ceiling: with none, no new spend is proposed; with one, the account's average day plus the new ad set's daily budget, × 30, must stay under it, and its budget never goes under Meta's floor (`newSpendGuard`, lib/ads/guard.ts). The build's journal is `ad_builds` (migration 0062): per step a `sent_at` written before the create and Meta's id after, so a resumed build never creates twice.

The connector metrics `revenue.hourly` and `orders.hourly` carry
`dimensions.hour_utc` ("00"–"23"), with `period_date` the UTC date. They
are stored in UTC and read in the business's clock with a 05:00
trading-day cutoff.

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

Competitor pages (feature 35, bank 1.7.0). The competitor entity schema gains two owner fields: `listing_url`, their booking or listing page (Fresha, Treatwell, Booksy, Google, a shop page), and `price_pages`, other pages of theirs that show prices, one link per line. Those, with `url`, are the ONLY pages ever read for a competitor (`lib/competitors`): at most five per competitor, robots.txt honoured, never a page behind a login, every fetch through the hardened site fetcher. This reading discovers no page and no competitor on its own. Five more keys sit beside the bank's fields under `competitors.<id>.`:

- `observed_offers` — `web_research`, confidence 0.5: `{ label_raw, offers: ObservedOffer[] }`, where `ObservedOffer` is `{ key, name, price: Money, from, url, method, fetched_at }` and `method` is `jsonld | og | pattern | model`. `label_raw` is the one readable line the fact sheet and the diagnosis print. A new record supersedes the old one only when what was seen changed, so the history of their prices is the history of this field (rule 3).
- `observed_rating` — `web_research`: `{ label_raw, rating, best, count, url, method, fetched_at }`, from a business-level schema.org `AggregateRating` only.
- `read_status` — `web_research`: `{ read_at, pages: [{ url, outcome: read | refused | failed, reason }], offers_seen, model }`, written on every read so "not read yet" and "couldn't read: <reason>" are stated, not guessed.
- `tracked` (`Field<boolean>`, owner) — false when the owner removed the competitor; the record and its history stay. `offer_matches` (owner) — `{ [observed offer key]: owner offer id | "none" }`, the owner's correction of the deterministic match table.

Extraction is deterministic first — JSON-LD `Product`/`Service`/`Offer`/`AggregateRating`, then OpenGraph price tags, then visible price patterns — and Haiku only reads a page that shows prices the parsers could not pair with names, batched once per business per run under the caps pinned in `lib/competitors/model.ts`. A price change, an offer added or removed, and a rating that moved are written to the watch log as worded changes. A price comparison with the owner's own offer is arithmetic in one currency (never converted, rule 1), and it is evidence only: nothing changes a price.

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
  option_labels?: Record<string, LocalizedText>; // the owner's words per code; unlabelled codes are humanised
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

The same holds when a connector supersedes an owner's figure (Phase 2 rule 11): the report shows what they said against what was measured. Presentation weighs each pair by materiality (`lib/connectors/materiality.ts`), the same at every business size: a pair is shown in full when the gap is at least 15% of the stated figure AND clears an absolute floor for its unit (money: about €50 of value per currency, held in major units and converted to minor units by the currency's ISO exponent, rule 1; orders and units: 5; sessions: 100). A stated "I don't know" or a pair in two currencies is always shown in full. Every other pair collapses into one line ("4 of the 6 figures you gave me matched your accounts within 15%") with its detail one click away; none is dropped, and supersession underneath is unchanged.

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
  trading_hours: TradingHoursBlock | null; // P2-30; null when no hours or hourly sales are measured
  confidence: number;
}

// P2-30: deterministic, from measured hourly sales — never a model. One
// finding per signal, naming its weekdays; the arithmetic that fired it,
// the coverage ("card sales only") and the honest limit travel with it.
interface TradingHoursBlock {
  from: ISODate;
  to: ISODate;
  zone: string;                          // the business's IANA timezone
  currency: CurrencyCode;
  coverage: string;
  limit: string;                         // "a closed hour records no sales…"
  findings: {
    signal: "opening" | "closing" | "attention" | "too_early";
    weekdays: Weekday[];
    title: LocalizedText;
    detail: LocalizedText;
    arithmetic: string[];                // one line per weekday that fired it
  }[];
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
  simulation?: SimulationRecord;        // feature 36: the campaign simulation it was proposed from
}

// Feature 36 (the campaign simulator, lib/simulate). Present only on a
// proposal made with "Propose this": the option, the day its inputs were
// read, each worked-out measure as a range in integer minor units (a
// missing measure is absent, never zero), every input with its basis and
// source, the inputs that were missing with what would fill them, and the
// key rate (bought-again rate, return on ad spend, reach per post) the
// trust layer later checks against what actually happened.
interface SimulationRecord {
  version: 1;
  as_of: ISODate;
  horizon_days: number;                 // 28
  option: SimOption;
  measures: Partial<Record<"cost" | "reached" | "orders" | "revenue" | "profit" | "worst", { low: number; high: number }>>;
  key_rate: { name: "bought_again_rate" | "roas" | "reach_per_post"; range: { low: number; high: number } } | null;
  inputs: { label: string; value: string | null; basis: Basis | null; source: string }[];
  missing: string[];
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
  kind: "proposal" | "approval" | "rejection" | "execution" | "measurement" | "profile_change" | "erasure" | "import" | "takeover" | "consent" | "change_request" | "reply_approval" | "reply_decline" | "reply_send" | "law_review" | "campaign_approval" | "unsubscribe" | "complaint" | "assistant_change" | "campaign_review";
  ref_id: string;
  payload_hash: string;
}

// P3-42 (alert mode): a goal made measurable. Stored as two fields beside
// the goal's other attributes, both superseded, never overwritten:
//   goals.<id>.measure   — owner_input: what to move, how far, by when
//   goals.<id>.baseline  — inferred from the measured series (rule 6)
// Units are "per 30 days": the mean of measured days in a 28-day window × 30.
interface GoalMeasure {
  metric: "revenue" | "orders" | "sessions";   // revenue.daily | orders.daily | sessions.daily
  direction: "increase" | "decrease";
  target_per_30d: number;                      // minor units for money (rule 1)
  currency: string | null;                     // ISO 4217 for money; null for counts
  deadline: ISODate;                           // explicit, or the goal's horizon from set_on
  set_on: ISODate;                             // the start of the expected path
}

interface GoalBaseline {
  per_30d: number;
  currency: string | null;
  from: ISODate;                               // the 28 days before set_on
  to: ISODate;
  days_measured: number;                       // ≥ 21, or there is no baseline
}
```

**`consent`** (P3-20h, rule 13) is write access granted: written by the owner when an execute connection is made through the consent screen. Its `ref_id` is the connection, and its hash covers the provider, the scopes granted, the consent lines shown verbatim and the confirmation the owner typed, so what was agreed to stays checkable after the registry changes. Disconnecting revokes nothing on the platform's side and writes no consent row; the connection keeps its own `disconnected_at`.

**`reply_approval`, `reply_decline`, `reply_send`** (P4-10, rules 12 and 22) are the approval covenant extended to support replies. Each `ref_id` is a `support_replies` row. An approval is written by the owner, and its hash covers the reply and ticket ids, the approving user, the time, whether the assistant drafted it, and the sha256 of the exact text that will be sent: the owner's words plus, for an AI-drafted reply, the disclosure appended in code. A decline covers the ids, the user, the time and the body's hash. A send is written by the system with the outcome (`sent`, `refused` or `unknown`), Resend's id when there is one, and the same text hash. No entry holds the reply's words, the customer's address or their name, so erasing the ticket (and with it the reply) leaves every entry verifiable and nothing personal.

**`law_review`, `campaign_approval`, `unsubscribe`** (P4-15, rules 12, 22 and 23) are the outbound send's record.

- **`law_review`**: a person reviewed the jurisdiction table (`lib/crm/jurisdiction.ts` REGIMES) against current law. Its `ref_id` is a `jurisdiction_reviews` row: the reviewer's name, the day, an optional note, and `table_sha256`, the sha256 of the table's canonical serialisation (keys sorted at every depth, arrays in order). A campaign sends only while the LATEST review's hash equals the table as it is now, so editing the table voids the review. The review covers the product, not one business, so the entry is filed under the nil uuid as `profile_id` (no business profile can hold it) with actor `system`. Its hash covers the review id, the sha256 of the reviewer's name (never the name itself), the day, the table hash and the time.
- **`campaign_approval`**: the owner approved the exact campaign email. Its `ref_id` is the campaign proposal. Its hash covers the proposal and draft ids, the approving user, the time, the sha256 of the body as approved and the sha256 of the subject line. The draft's own row keeps the same four facts (`content_items.approved_by/at/sha256/subject`). What goes out to each recipient is that body with the `{{unsubscribe_url}}` slot filled and nothing else changed, which the executor proves before each send.
- **`unsubscribe`**: a recipient used their link. Its `ref_id` is the `campaign_sends` row. It is written by the system, and its hash covers the send id, the account and the time. It never holds the address, its hash or the token.
- **`complaint`** (P4-17, rule 23): the email service reported that a recipient marked a campaign email as spam (Resend's `email.complained`, Svix-signed, matched by Resend's email id). The address is suppressed permanently in the same transaction (`contact_suppressions`, reason `complained`, from the send row's keyed hash), exactly as an unsubscribe is. Its `ref_id` is the `campaign_sends` row; written by the system; its hash covers the send id, the account and the time. Like `unsubscribe`, it never holds the address, its hash or Resend's id. An event for an erased recipient matches nothing (erasure nulls the provider id) and is dropped; the erasure's own suppression already holds.
- **`campaign_review`** (review 2026-10-23, #5c, rule 23): a person at SYB read an account's FIRST campaign before it sent, because campaigns go out from SYB's own sending domain. Its `ref_id` is a `campaign_reviews` row: the account, the campaign proposal read, the reviewer's name and the day. Until the account has one, its campaign is refused at pre-flight (beside the law review); later campaigns don't need another. Recorded from `/ops` behind `OPS_KEY`, filed under the campaign's own profile with actor `system`. Its hash covers the review id, the account and proposal ids, the sha256 of the reviewer's name (never the name), the day and the time. It holds no customer data.

**`assistant_change`** (feature 33, conversation-channel §9): the owner pressed a chat change card's button, confirming one change the assistant had drafted. Its `ref_id` is the `assistant_changes` row (the draft: kind, summary, now and new, the payload, what it was drafted against). Written by the owner; its hash covers the profile, the change id, the kind, the summary, the payload and what the click wrote (`result_ref`: a field record, a proposal, a settings row, the stop). A fact the click writes also logs its own `profile_change`, as every field write does.

```ts
// P4-15: one row per recipient per campaign (table campaign_sends), materialised from the
// approved proposal's contact ids on the first run. Consent is re-checked per row AT its send.
interface CampaignSend {
  id: SendId;                     // also names the Idempotency-Key: "syb-campaign-<id>"
  proposal_id: ProposalId;
  execution_id: ExecutionId;
  contact_id: ContactId | null;   // nulled by erasure (rule 22), with provider_message_id
  email_hash: string | null;      // emailHash() of the address, written at the claim; never the address
  status: "pending" | "refused" | "sending" | "sent" | "failed" | "unknown";
  refused_reasons: string[];      // codes: consent_implied | consent_unsure | consent_none | suppressed |
                                  // consent_unproven | no_regime | message_incomplete | no_email |
                                  // contact_gone | duplicate_address
  provider_message_id: string | null;
  unsubscribe_token_hash: string | null; // sha256 of the recipient's own token; links never expire
  sender_name: string | null;     // the business name it was sent as, for the unsubscribe page
  body_sha256: string | null;     // the exact text this recipient was sent
  provider_status: number | null; // a definitive refusal's HTTP status, never the provider's message
  unsubscribed_at: ISODateTime | null;
  // P4-17: what the email service reported — the first event of each kind only, so a
  // redelivered event changes nothing. Opens and clicks are never stored.
  delivered_at: ISODateTime | null;
  bounced_at: ISODateTime | null;
  bounce_type: "permanent" | "temporary" | "suppressed" | "other" | null; // with bounced_at; a code, never the server's message
  complained_at: ISODateTime | null;   // marked as spam: suppresses the address for good
}
// UNIQUE (proposal_id, contact_id) and UNIQUE (proposal_id, email_hash): once per recipient,
// structurally. `unknown` is never sent again, by any run.

// P4-17: the comparison group for a campaign's readback (table campaign_comparisons) — the
// segment's members NOT on the approved list, as they stood when the send began. Ids only.
interface CampaignComparison {
  id: string;
  proposal_id: ProposalId;
  contact_id: ContactId | null;   // nulled by erasure (rule 22)
  snapshot_at: ISODateTime;       // "bought again since" is measured from here for this group
}
// Contacts gain purchase_refreshed_at: when a shop export with a last-order column last covered
// them. A later import refreshes an existing contact's purchase history (never its consent; the
// last order date never moves backwards). The readback (lib/trust/email-readback.ts) counts a
// recipient as "bought again" when an export at least the scenario's wait after their send
// (14 days for a win-back, 28 for a thank-you) shows a last order on a later day, and compares
// that rate with the comparison group's. Observational, not randomised; without a comparison of
// at least 5 measured, a lift is never "helped".
```

**`takeover`** (P3-43) is day zero: written once, at a profile's first mode decision. Its `ref_id` is a snapshot taken with reason `day_zero`, and its hash covers that snapshot's content hash and the goal ids, so "this is where you started" stays checkable. Goal progress (P3-44) is judged weekly against the straight path from baseline to target, in the watch log as `goal_progress`, with `goal_alert` after three consecutive off-track weeks.

```ts
// P3-45..47: one row per alert review of one goal (table alert_reviews).
interface AlertReview {
  id: ReviewId;
  profile_id: BusinessProfileId;
  goal_id: GoalId;
  created_at: ISODateTime;
  outcome: "reviewed" | "unusable" | "skipped_cost_cap";
  case_file: { lines: { id: string; section: string; text: string }[]; snapshot_id: SnapshotId; built_at: ISODateTime };
  case_hash: string;                 // sha256 of the rendered case file
  review: { summary: string; causes: Cause[]; considered: SetAside[]; suggestions: Suggestion[] } | null;
  rejected: { raw: unknown; reason: string }[];   // what code refused — kept, never repaired
  proposal_ids: ProposalId[];        // suggestions that entered the queue
  cost_eur: string;
  escalated_at: ISODateTime | null;  // handed to a person (P3-47)
  escalation_reason: string | null;
  resolved_at: ISODateTime | null;   // a person closed the case
}
```

A cause must cite evidence ids the case file holds; every cause category (`our_advice_was_wrong`, `goal_unrealistic`, `owner_declined_key_actions`, `approved_actions_not_executed`, `execution_failed`, `data_incomplete`, `external_change`, `other`) must be named or set aside, or the gap is recorded in `rejected`.

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
