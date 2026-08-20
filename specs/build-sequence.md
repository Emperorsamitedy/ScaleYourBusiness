# Build Sequence

Every step in order, from nothing to the finished system. Each has a **done when** line — if you can't tick it, don't move on.

**Detail decays with distance, deliberately.** Phases 0 and 1 are specified to the task. Phases 2 and 3 are specified to the deliverable. Phases 4 and 5 are directional only. This isn't laziness: Gate 1 (step 62) will teach you things that make any detailed plan for month 9 fiction today. Rewrite the later phases after each gate.

Steps marked **⚠ STOP** are gates. Do not proceed past one by momentum.

---

## Part 0 — Decisions to close before any code

These block work. All six can be settled in a week and several are phone calls.

**1. Decide the intake language.**
Hungarian-first, English-first, or both. This determines whether the question bank gets translated before or after the intake UI is built.
*Done when:* written down, and if Hungarian, you know who is writing the 153 prompts.

**2. Get real media generation quotes.**
Contact video and image generation providers, ask for per-clip pricing at ~5,000 clips/month. This is 55% of your cost to serve and currently a placeholder.
*Done when:* three real quotes are in the Assumptions sheet.

**3. Set the instant-mode thresholds.**
The 10-order and 3-month figures in the data model spec are my proposal. They decide when the system is allowed to touch a live business.
*Done when:* the numbers are written into §9 of the data model spec with your reasoning.

**4. Book the lawyer.**
SaaS terms, privacy policy, DPA, and the GDPR DPIA. Lead time is typically 3–6 weeks, which is why this is a step-4 item and not a month-3 item.
*Done when:* engagement letter signed and a delivery date agreed.

**5. Choose the name and register the domain.**
Everything else has a placeholder in it right now.
*Done when:* domain and the matching social handles are held.

**6. Decide who is building this.**
Solo, solo plus contractor, or two full-time. This sets every date that follows.
*Done when:* if hiring, the contract start date is fixed.

---

## Part 1 — Setup week

**7. Register the company** (or confirm the existing entity can trade).

**8. Open the accounts:** Anthropic Console, cloud hosting, error monitoring, transactional email, object storage, source control, payments.
*Done when:* billing alerts are set on the Anthropic account. Do this now — an agent loop with a bug can spend real money overnight.

**9. Pick the stack and write it down.**
My recommendation, and the reasoning: **PostgreSQL** because the schema is deeply relational and you'll need JSONB for the profile fields; **TypeScript end-to-end** (Node backend, Next.js frontend) because one language across an agent backend and a rich frontend beats context-switching for a two-person team; **a job queue** (BullMQ or equivalent) because every module runs on a schedule and cron won't survive Phase 2; **object storage** for uploads. If your team is stronger in Python, use Python — team fluency beats any argument I can make here.
*Done when:* written in the repo README, with the reason for each choice.

**10. Create the repository and the deployment pipeline.**
Three environments: local, staging, production. Staging is not optional — you will be testing agent loops that write to real businesses' accounts.
*Done when:* an empty app deploys to staging from a merge.

**11. Set up error monitoring and structured logging** before there's anything to monitor.
*Done when:* a deliberate test exception appears in the dashboard.

**12. Copy the four spec documents into the repo** (`data-model-v1.md`, `question-bank-v1.json`, `question-bank-notes.md`, `ux-spec-v1.md`) and the lint script.
*Done when:* `lint_bank.py` runs green in CI.

---

## Part 2 — Phase 0: Foundation (weeks 1–4)

The goal is a system that can conduct a full intake and hold the result correctly. No analysis yet.

### Data layer

**13. Implement the core primitives:** `Field<T>`, `SourceRef`, `Money`, `Quantity`, `EnumValue`.
Money as integer minor units with an explicit currency. Never a float, not once.
*Done when:* unit tests cover every `FieldStatus` value and a two-currency profile totals correctly.

**14. Implement the profile tables** — the fourteen sections and the eight entity types.
*Done when:* a profile can be created, read back, and round-trips through JSON without loss.

**15. Implement fact supersession.**
Writing a new value marks the old one superseded rather than deleting it. This is the feature everything else depends on and it's nearly impossible to retrofit.
*Done when:* changing a price three times leaves three dated records and returns the newest.

**16. Implement the vocabularies** with the `other` + `label_raw` escape hatch.
*Done when:* an unrecognised value is stored with the owner's original wording preserved.

**17. Implement the decision log**, append-only.
Nothing writes to it yet except profile changes. Build it now so later phases have somewhere to write.
*Done when:* every profile change produces a log entry and the table rejects updates.

### Question engine

**18. Load the question bank** from JSON into the database, versioned.
*Done when:* all 153 questions, 55 vocabularies and 8 entity schemas load, and the loader refuses a bank that fails lint.

**19. Build the condition evaluator** for the seven `ConditionExpr` operators.
*Done when:* unit tests cover every operator, including `and`/`or`/`not` nesting and the `.length` accessor.

**20. Build the applicability resolver** — given a profile, which questions currently apply.
*Done when:* a profile selling only services never surfaces an inventory question, and selecting "physical products" later makes them appear.

**21. Build the completeness scorer** (§8.2 of the data model).
*Done when:* answering the 25 always-asked core questions yields `core_complete: true` regardless of which branches opened.

### Interviewer agent

**22. Write the interviewer prompt.**
Inputs: profile so far, applicable questions with priority and cost, session history. Output: next question ID plus `selection_reason`. Cheap core questions before expensive deep ones.
*Done when:* across 20 simulated profiles it never asks an inapplicable question and never repeats one.

**23. Implement prompt caching on the question bank.**
The bank is ~25,000 tokens and goes out on every turn. Cached it costs a tenth. Uncached, the interviewer alone costs about eight times more than modelled.
*Done when:* the API response shows `cache_read_input_tokens` on the second turn onward.

**24. Build the answer parser** (Haiku) — free text into typed values.
*Done when:* "about 4 and a half million a month, before tax" becomes a `Money` with `note` preserved and `confidence` lowered for the estimate.

**25. Handle multi-answer input.**
Owners answer three questions in one sentence. The parser should fill every field it can and the interviewer should skip what's now answered.
*Done when:* a paragraph answer fills multiple fields and the next question isn't one of them.

### Intake UI

**26. Build the intake shell** from `ux-spec-v1.md` §4 — tokens, type scale, three-column stage.
*Done when:* it matches `intake-mockup.html` and passes keyboard-only navigation.

**27. Implement the input controls** for all nine `InputSpec` types.
*Done when:* each renders, validates, and writes a correctly typed `Field`.

**28. Implement the entity-list sub-form** (§4.3).
*Done when:* five products can be added in under 90 seconds with core fields only.

**29. Implement the settle animation and the provenance chips.**
Each chip shows the mono source line. This is the trust device, not decoration.
*Done when:* motion sequence runs at ~580ms total and is disabled under `prefers-reduced-motion`.

**30. Make chips clickable to reopen**, preserving history and recording a reason.
*Done when:* reopening and changing an answer leaves both values in the record.

**31. Build the mobile layout** — single column, "Recorded (6)" strip.
*Done when:* usable at 360px wide.

### Validation

**32. Implement the validation rule engine** and the nine rules in §7 of the data model.
*Done when:* each rule fires on a constructed profile and stays quiet otherwise.

**33. Build the reconcile panel.**
Wording from the UX spec: curious, never corrective. This is the tonal high point of the product.
*Done when:* a stage-vs-revenue contradiction flags both chips and resolves cleanly on either path.

**34. Wire validation to run on every field write,** not as a batch pass.
*Done when:* a contradiction surfaces within one question of being created.

### ⚠ STOP — Phase 0 gate

**35. Run ten real intakes with real business owners.** Not friends humouring you. Sit and watch, silently.
*Done when:* you have a list of every question that confused someone, every place they hesitated, and the actual abandonment point.

**36. Rewrite the questions that failed.** Expect 15–30 of them.
*Done when:* the bank version increments and lint passes.


---

## Part 3 — Phase 1: Diagnosis (weeks 5–10)

The goal is the first thing you can charge for.

**37. Build the profile snapshot mechanism.**
A report must reference the exact profile state that produced it.
*Done when:* a snapshot ID reproduces the report's inputs byte for byte.

**38. Implement competitor web research.**
Search, fetch, extract into `Competitor` records with `source` and `researched_at` set. Owner-stated and researched facts must stay distinguishable.
*Done when:* naming a competitor produces a populated record with real URLs and nothing invented.

**39. Show honest progress during research.**
Real steps, real timings. **Do not add artificial delay.** Research genuinely takes 30–90 seconds; show what's happening.
*Done when:* the progress log entries correspond to actual completed work.

**40. Implement unit economics computation** — margins, break-even, AOV, cost per acquisition where derivable.
Every computed value records `derived_from` and the formula.
*Done when:* each figure can be traced to its inputs on screen.

**41. Handle the stated-vs-computed conflict** (§8.3): compute wins for analysis, both are shown, a contradiction is raised, neither is silently overwritten.
*Done when:* a profile with a wrong stated margin produces a visible discrepancy rather than a silent correction.

**42. Write the findings prompt** (Opus 5). Output must be `DiagnosisFinding` objects with populated `evidence` arrays.
*Done when:* no finding exists without field references, enforced in code, not just in the prompt.

**43. Write the recommendations prompt** with `ScenarioBlock` output — assumptions, base/downside/upside, break-even condition, sensitivity flags.
*Done when:* a discount recommendation states the volume lift required to break even, with the arithmetic shown.

**44. Implement the data gaps section** — the gaps that would most improve the next report, each linking back into intake.
*Done when:* clicking a gap opens that question in the intake.

**45. Build the report screen** per UX spec §7.
*Done when:* it reads well on a phone and prints cleanly.

**46. Implement recommendation responses** — "Look into this" / "Not for us" with an optional reason, pre-filled chips.
*Done when:* reasons write to the decision log. Nothing consumes them yet; that's fine, you're building the corpus.

**47. Build the mode decision screen** (UX spec §5), driven by `ModeDecisionInputs`.
Reasons shown are the actual inputs that triggered it. Extending is one click; shortening is buried behind an acknowledgement.
*Done when:* both modes render correctly and a low-confidence profile defers the decision instead of guessing.

**48. Build the watching status screen.** Honest activity log only.
*Done when:* every entry corresponds to real work performed.

**49. Build module selection**, with analytics fixed on.
*Done when:* analytics cannot be disabled and the UI explains why.

**50. Build signup, auth and payments** for the one-off report price.
*Done when:* a stranger can pay and receive a report without you touching anything.

**51. Add cost telemetry per account** — tokens and euros, per workload.
*Done when:* you can see the real cost of one onboarding and compare it to the €1.78 estimate.

**52. Instrument the funnel:** intake start, core complete, report delivered, recommendation responses.
*Done when:* the abandonment point is visible in a dashboard.

### ⚠ STOP — Gate 1: does anyone want this?

**53. Sell ten diagnosis reports at full price** to businesses you don't personally know.
*Done when:* ten strangers have paid.

**54. Interview all ten a week later.** Did they act on anything? What did they ignore?
*Done when:* you can name the one finding type that consistently landed and the one that consistently didn't.

**55. Compare real API costs to the model.** Update the spreadsheet.
*Done when:* Assumptions holds measured numbers instead of estimates.

**56. Decide.** Ten sales and real reactions → continue. Interest without payment → pricing or packaging problem, fix before building more. Indifference → the diagnosis isn't good enough, and execution built on a weak diagnosis is worse, not better. Fix the diagnosis or stop.

**56a. Localise, if the data says to.**
Gate 1 tells you where your ten paying customers came from. If a non-English
market is over-represented, translate the bank into that locale — native speaker,
not machine translation, since intake wording is where trust is won. If they are
all English-speaking, skip this and revisit after Gate 2.
*Done when:* either a second locale renders end to end with no clipped text, or
the decision to defer is written down with the geography that justified it.

---

## Part 4 — Phase 2: Analytics spine (weeks 11–17)

Read-only. No writing to anyone's accounts in this phase, under any circumstances.

**57. Build the connector framework** — OAuth, token refresh, rate limiting, per-source health status.
*Done when:* an expired token surfaces as a clear reconnect prompt rather than a silent failure.

**58. Build connectors in this order:** Stripe, Shopify/WooCommerce, GA4, Meta Ads, Google Ads.
Payments first because it's the most reliable data and it upgrades revenue fields from estimate to measured.
*Done when:* each backfills 12 months and stays current daily.

**59. Request read-only scopes only.**
*Done when:* a scope audit confirms no write permission is requested anywhere.

**60. Implement connector-sourced field writes** at 0.95 confidence, superseding owner estimates while preserving them.
*Done when:* connecting Stripe raises the profile's confidence score visibly and the owner's original figure remains in history.

**61. Build the metrics store** — daily aggregates by offer, channel, and segment.
*Done when:* revenue by channel per day is queryable for 12 months.

**62. Implement anomaly detection** with seasonality awareness.
*Done when:* it catches a real 20% week-over-week drop and stays silent through a normal weekend dip.

**63. Build the report cadence** — 3-day pulse, monthly review, quarterly deep-dive.
*Done when:* all three generate on schedule from real data.

**64. Implement the notification tiers** (UX spec §9) with the one-push-per-day cap enforced in code.
*Done when:* twenty events in an hour produce at most one push.

**65. Build the profile page** — everything known, editable, sources visible.
*Done when:* an owner can correct any fact and see the change recorded.

**66. Add subscription billing.**
*Done when:* report buyers can convert to a subscription.

**67. ⚠ Verify watching mode actually blocks writes.**
Write an integration test that asserts no write-capable call can execute while a profile is in watching mode. This test protects a real business from you.
*Done when:* the test exists, passes, and fails loudly if someone removes the guard.

---

## Part 5 — Phase 3: Marketing execution (weeks 18–31)

The first phase where mistakes damage a customer. Budget 14 weeks, plan for 18.

**68. Build the proposal object and the approval queue** — the pattern from UX spec §8. Equal visual weight on approve and decline.

**69. Build the execution engine** — approved proposals only, with idempotency, retries, and a kill switch.
*Done when:* a proposal cannot execute twice, and the kill switch halts everything within seconds.

**70. Implement the hard-limits check.**
Every proposal is checked against question 13.5 before it reaches the queue. An owner who said "never discount" never sees a discount proposal.
*Done when:* a violating proposal is blocked at generation and logged.

**71. Build goal setting and content planning** tied to `Goal` records.

**72. Build content generation** — owner-supplied footage first, generation second.
*Done when:* the upload-and-edit path is the default in the UI, not the fallback.

**73. Implement AI content disclosure** per platform requirements and the EU AI Act.
*Done when:* generated content carries the required labels automatically, with no way to disable it.

**74. Build the scheduler and publishing integrations.** Now write scopes are needed — one platform at a time, each gated by the watching-mode check from step 67.

**75. Build performance readback** — every published item tied to its goal and measured.
*Done when:* a proposal's actual outcome appears against its predicted scenario.

**76. Implement rejection learning.**
Rejection reasons from the decision log feed future proposal generation.
*Done when:* an owner who rejected three video proposals stops receiving them.

**77. Build the mobile approval experience.**
Approvals happen on phones, between other work.
*Done when:* a proposal can be reviewed and decided in under 30 seconds on a phone.

### ⚠ STOP — Gate 2: does it actually work?

**78. Measure the approval rate** across all customers.
Under 30% means the system doesn't understand these businesses well enough to act on them. More modules will not fix that.

**79. Measure outcomes** on approved actions against their scenario predictions.
*Done when:* you can state honestly whether approved actions helped.

**80. Decide.** High approval and measurable results → continue. High approval and flat results → you have the hard problem: the software works and doesn't produce outcomes. That is a positioning and expectations problem, and it needs solving before you sell harder.

---

## Part 6 — Phase 4: Support and CRM (weeks 32–43)

Directional. Rewrite after Gate 2.

**81.** Build the contact database, respecting the consent status from question 6.4b.
**82.** Build website chat with the AI-identifies-as-AI requirement.
**83.** Build email support with the escalate-to-human flow.
**84.** Build the FAQ that updates itself from real incoming questions.
**85.** Build segmentation and lifecycle tracking.
**86.** Build outbound email — consent-gated, unsubscribe handling, per-jurisdiction rules.
**87.** Skip phone AI for now. It's a separate engineering project and chat plus email covers most of the value.

---

## Part 7 — Phase 5: Sales, finance, inventory (weeks 44–56)

Directional.

**88.** Inventory intelligence — the window A / window B comparison. Strongest early finding available and it drops out of the schema almost for free.
**89.** Cash-flow scenarios and break-even modelling from connector data.
**90.** Site audit — speed, mobile, checkout friction.
**91.** Seasonal and trend triggers.
**92.** Sales pipeline for B2B profiles.
**93.** HR module, off by default. Role-level analysis only — no named-individual scoring, per the GDPR Article 22 exposure.

---

## Part 8 — Running throughout

Not phases. Every week, from week 1.

**94. Watch a real user** at least fortnightly. Silently.
**95. Check the cost telemetry weekly.** An agent loop bug is a runaway bill.
**96. Re-run `lint_bank.py`** on every question bank change.
**97. Keep the decision log clean** — it's your learning corpus and your legal audit trail.
**98. Update the cost model monthly** with measured numbers.
**99. Review the gates.** If a gate result is bad, the correct response is to stop and fix, not to build the next phase and hope.

---

## The first five things to do tomorrow

1. Get media generation quotes (step 2) — it's a phone call and it moves 55% of your cost to serve.
2. Book the lawyer (step 4) — six-week lead time, so it blocks nothing only if started now.
3. Decide the intake language (step 1).
4. Set up the Anthropic account with billing alerts (step 8).
5. Start step 13. The schema is the spine; everything else is a view onto it.
