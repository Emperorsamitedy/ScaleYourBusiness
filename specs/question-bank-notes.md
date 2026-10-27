# Question Bank v1 — Notes

Companion to `question-bank-v1.json`. Explains how the bank is structured, what the 25 core questions are, and every branching error found and corrected in MAIN.txt.

---

## 1. What was produced

| | Count |
|---|---|
| Questions | 158 |
| Controlled vocabularies | 57 |
| Entity schemas | 8 |
| Core questions, always asked | 25 |
| Core questions including conditional branches | 44 |
| Important | 105 |
| Deep | 9 |

Counts as of bank 1.8.0, as `lint_bank.py` prints them (1.7.0 added two fields to the competitor entity schema, `listing_url` and `price_pages`, and no question; 1.8.0, Phase 5 Session D, added the `deal_stage` vocabulary and question 6.1f, the owner's stated win rate). The first cut was 153 questions and 55 vocabularies; later additions are recorded in `data-model-v1.md` §5 next to the fields they write.

MAIN.txt contains roughly 300 bullet points. The first cut of the bank was 153 questions because repeated per-item fields collapse into entity schemas: instead of nine questions per product, there is one `entity_list` question with an offer schema attached. An owner with five products answers one question that expands into five rows, rather than 45 separate prompts.

A lint script (`lint_bank.py`) checks for dangling condition references, `unlocks` pointing at questions that don't exist, selects without a vocabulary, and entity lists without a schema. It currently reports clean.

---

## 2. How the bank is structured

**Questions** carry an `id` traceable to MAIN.txt (`1.4.1.2` is still `1.4.1.2`), the `writes_to` field path, a `condition`, a `priority` tier and a `cost` of 1–3.

**Vocabularies** are flat code lists. Everything selectable ends in `other`, and `label_raw` preserves what the owner actually typed so recurring values can be promoted into the list later.

**Entity schemas** cover offer, supplier, channel, competitor, staff_role, cost_item, customer_segment and goal. Each field carries its own priority so an entity row can be added with three fields and enriched later.

**Two dynamic vocabularies** — `__offers__` and `__channels__` — resolve at runtime from what the owner has already entered. This is how "which one sells the most?" offers their actual product names instead of free text, which is what makes the answer usable as a foreign key rather than a string to match.

**Priority tiers** drive sequencing. `core` gates the first diagnosis and the mode decision. `important` deepens it. `deep` is asked only when a module needs it or the owner volunteers time. Combined with `cost`, the interviewer front-loads cheap core questions so an owner reaches a usable profile before hitting anything that requires digging through records.

---

## 3. The 25 core questions

These are asked of every business regardless of type, and together they produce enough for a first diagnosis plus every input the mode decision needs.

| # | ID | Question |
|---|---|---|
| 1 | 1.1 | Business name |
| 2 | 1.1b | Country of operation |
| 3 | 1.2 | Business type |
| 4 | 1.3 | What the business does |
| 5 | 1.4 | What it sells |
| 6 | 1.5 | Current stage |
| 7 | 1.5.1 | Main focus right now |
| 8 | 1.6 | How many people work there |
| 9 | 2.1 | Online, physical or both |
| 10 | 2.2.1 | Local, national or international |
| 11 | 3.1 | List of products and services |
| 12 | 4.1 | Does it generate revenue |
| 13 | 5.1 | Fixed monthly costs |
| 14 | 6.1a | Sells to consumers or businesses |
| 15 | 6.3a | How customers find them |
| 16 | 7.4 | What happens from first contact to purchase |
| 17 | 8.1 | Runs paid advertising |
| 18 | 8.1e | Posts content |
| 19 | 8.1h | Social accounts |
| 20 | 9.1 | Currently operating |
| 21 | 9.3b | Has a support process |
| 22 | 10.1c | Has automations already |
| 23 | 11.3 | Advertising or industry restrictions |
| 24 | 13.2 | Biggest growth blocker |
| 25 | 13.5 | Hard limits — what the business must never do |

A further 19 are core but conditional: revenue figures if revenue exists, pre-launch questions if it doesn't, inventory if physical products are sold, key-person dependency if services are sold, and so on.

Three of these deserve comment because they are not in MAIN.txt:

**1.1b, country of operation.** Promoted to the second question asked. It determines VAT treatment, GDPR applicability, advertising restrictions and which platforms are even available. Discovering it in section 11 after building a marketing plan is too late.

**10.1c, existing automations.** A direct input to the mode decision — a business with automations already running has systems that can be disrupted.

**13.5, hard limits.** Not in MAIN.txt at all and arguably the most important question in the bank. An owner who says "never discount" or "never use my face in videos" has set a constraint that must bind every later proposal. Capturing it at intake is far better than discovering it through a rejected proposal, and it is the cheapest possible protection against the system suggesting something that damages a brand.

---

## 4. Branching errors found and corrected

You said the `if`s in MAIN.txt weren't fully correct. Fifteen issues found. These are listed with the fix applied in the bank.

**4.1 — Software and digital products had one branch between them.** MAIN.txt 1.4 offers `Software` and `Digital products` as separate selections, but only 1.4.3 exists to handle them, and its title says digital while its options list SaaS and mobile apps. *Fix:* question `1.4.3.1` now triggers on software OR digital_products OR subscriptions.

**4.2 — Subscriptions and marketplace access had no branch at all.** Both are selectable in 1.4 and nothing follows. *Fix:* subscriptions route into the digital branch; marketplace access is captured through the channel entity, since it is a distribution model rather than a product type.

**4.3 — Local delivery was asked twice.** 1.4.1.6 asks it under physical products, 2.1.1.4 asks it again under physical presence. *Fix:* asked once as `1.4.1.6`, conditioned on selling physical products rather than on having a location, since an online-only seller can also deliver locally.

**4.4 — The online branch excluded businesses that are both.** MAIN.txt 2.1.2 reads "if online", which by strict reading skips a business that selected "both" — yet those businesses have websites too. *Fix:* condition is `presence.type != physical_only`.

**4.5 — Offers were listed three times.** 1.4.1.1 lists physical products, 1.4.2.1 lists services, 1.4.3.1 lists digital products, then 3.1 says "list everything the business sells". A mixed business would enter its catalogue twice. *Fix:* one `entity_list` at `3.1` where each row carries its own `kind`; the 1.4.x questions became type-specific detail that attaches to those rows.

**4.6 — Suppliers were nested under products but are shared between them.** 1.4.1.3 asks supplier details per product, but one supplier typically supplies many products. *Fix:* supplier is a business-level entity with a `supplies_offers` link back to offers.

**4.7 — The revenue branch keyed off the wrong field.** 4.1's sub-branches depend on whether revenue exists, but stage (1.5) also encodes this. An owner can select stage "growing" and then answer "no revenue". *Fix:* branches key strictly off `revenue.generates_revenue`; the stage-versus-revenue conflict became validation rule `stage_vs_revenue` rather than a branching assumption.

**4.8 — "Previously generated revenue" had no branch.** It is an option in 4.1 and nothing follows it, despite being the most diagnostically loaded answer available. *Fix:* new question `4.1p` asks why it stopped.

**4.9 — Variable costs double-counted the per-offer delivery cost.** 5.2 asks what costs rise with sales, but offer-level `cost_to_deliver` already captures most of that. Summing both overstates costs. *Fix:* 5.2 is explicitly scoped to costs not attributable to a single offer, and its wording says so.

**4.10 — CRM was asked in two places.** 6.4 asks about CRM tooling and 10.1 lists CRM as a tool category. *Fix:* 6.4 now asks only whether a contact list exists and how large; the tool itself is captured once in section 10.

**4.11 — Ad metrics were split across sections.** 7.2 asks per-channel cost and conversion, 8.1 asks cost per lead and ROAS. For a paid channel these are the same numbers. *Fix:* ad channels are channel entities carrying their own cost and conversion fields; section 8 asks only about spend and platform at the business level.

**4.12 — Content questions were trapped inside the "no ads" branch.** MAIN.txt puts content, posting frequency and brand assets under "if no ads", but a business running ads also posts content. *Fix:* content questions `8.1e`–`8.1g` are unconditional.

**4.13 — Operating status was asked twice.** 1.5 stage includes "paused" and 9.1 asks operating status including "paused". *Fix:* both retained because they genuinely differ — stage is strategic, 9.1 is current — but 9.1 is pre-filled from stage and presented as a confirmation, and a mismatch raises a contradiction finding.

**4.14 — Booking questions triggered on the wrong condition.** 1.4.2.3 sits under services, but physical businesses take reservations too, and 2.1.1.5 asks about appointments separately. *Fix:* `1.4.2.3` triggers on selling services; `2.1.1.x` no longer duplicates it.

**4.15 — Inventory sub-questions assumed a yes/no answer to a three-way question.** 1.4.1.2 offers yes/no/partly, but 1.4.1.2.1 fires "if yes" and 1.4.1.2.2 fires "if no", leaving "partly" with no follow-up at all. *Fix:* the stock-detail questions fire on `!= no`, and the no-inventory question fires on `== no`. "Partly" now gets both paths where relevant.

---

## 5. Deliberate additions beyond MAIN.txt

Six questions were added in the first cut, and 1.6a in bank 1.6.0. Each exists because a later module cannot function without it.

| ID | Question | Why |
|---|---|---|
| 1.1b | Country of operation | Legal, tax and advertising constraints; needed before any plan |
| 1.5b | When the business started | Direct mode-decision input (months operating) |
| 1.6 | Headcount | Direct mode-decision input |
| 1.6a | Size, in the owner's own words | Decides what the app shows them (`lib/core/size-features.ts`). `important`, not core: nothing in the diagnosis waits on it, and until it is answered a band is inferred from 1.6 |
| 6.4b | Marketing consent status | Nothing can be emailed without this; GDPR exposure |
| 10.1c | Existing automations | Direct mode-decision input |
| 13.5 | Hard limits | Binds every future proposal |

---

## 6. Wording principles applied

Prompts are written the way a person would ask, not the way a form would label. MAIN.txt says "Key person dependencies"; the bank asks "Could someone else deliver the service if you were unavailable?" The information is identical and the second one gets answered.

Three rules held throughout:

**Ask for what the owner knows, not what the analysis needs.** Nobody knows their break-even point offhand, so it is computed from costs and margin rather than asked. Nobody reliably knows average order value, so it is derived from revenue and order count. Asking for derived figures produces confident wrong numbers.

**Make "I don't know" a first-class answer.** `allow_unknown` is true on every question where the answer might legitimately not exist. An owner with no idea of their churn rate should say so in one tap — that gap is itself a finding about the business, and forcing a guess corrupts everything downstream.

**Never imply judgement.** "Is there damaged, expired or dead stock?" is asked alongside a note that this is common, not as an accusation. Owners who feel judged during intake stop being honest, and an intake built on defensive answers is worse than a shorter one.

---

## 7. Open items

1. **Language — CLOSED.** English at launch. Localisation is in scope as an
   architectural requirement, not an English-only product. Additional locales are
   added after Gate 1 and chosen by where paying customers actually come from —
   not guessed in advance. `LocalizedText` stays multi-key throughout so adding a
   locale is content work, never a migration.

1a. **Vocabularies internationalised.** `channel_platform`, `payment_provider`,
   `legal_entity_type` and `vat_status` no longer carry country-specific values.
   `local_marketplace` and `local_provider` plus `other` + `label_raw` capture
   regional services without enumerating every country's ecosystem.

2. **`business_type` vocabulary.** 33 entries as a starting point. It needs review against your actual target market — the current list leans towards small local businesses and light e-commerce.
3. **Section 14 asset handling.** Currently one upload question plus a checklist of what exists. Whether v1 parses uploads or merely stores them is open decision 5 from the data model spec.
4. **Entity list minimums.** Only `offer` has `min_items: 1`. Whether costs and channels should also require at least one entry is a UX call — requiring them improves data quality and increases abandonment.

---

## 8. Next step

The bank is now a concrete contract the intake UI can be built against: it renders `InputSpec`, evaluates `condition`, writes `Field`. The natural next artifact is the interviewer agent specification — how the next question gets selected from this bank given the profile so far, when it deepens versus moves on, how it handles an owner who answers three questions in one sentence, and what it writes into `selection_reason`.
