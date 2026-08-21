# TASKS.md — Phase 0

Commit-sized tasks in strict order. Work top to bottom. Reference the task ID in each commit message.

**Scope: Phase 0 only** — from empty repo to a working intake that produces a validated profile. That's `build-sequence.md` steps 10 through 36a. Phase 1 tasks get written after step 35, because the ten test intakes will change things.

**Estimate: ~276 hours.** At 30 hours a week that's about nine weeks.

Sessions are dependency-ordered. Don't jump ahead — several later tasks silently assume earlier ones landed.

---

## Session A — Repo scaffold _(~8h · steps 10–12)_

- [x] **P0-01** `npm init`, TypeScript strict mode, ESLint, Prettier
- [x] **P0-02** Next.js app, empty page, runs locally
- [x] **P0-03** Postgres locally via Docker, connection verified
- [x] **P0-04** Migration tool wired up (Drizzle or Prisma), one empty migration applied
- [x] **P0-05** `.env` handling, Anthropic key loaded, never committed
- [x] **P0-06** Copy specs into `specs/`, `scripts/lint_bank.py`, `CLAUDE.md` at root
- [x] **P0-07** CI: typecheck, tests, and `lint_bank.py` all run on push
- [ ] **P0-07b** ⏸ _blocked-deferred until Session N_ — Sentry free tier, error monitoring wired, verified with a deliberate test exception _(step 11; nothing to monitor before the intake UI exists)_
- [ ] **P0-08** ⏸ _blocked-deferred until Session N_ — Deploy to staging (Vercel + Neon), verify the empty app is reachable _(nothing to deploy before the intake UI exists)_

**Done when:** an empty app deploys from a merge and CI blocks a broken question bank.

---

## Session B — Core primitives _(~14h · step 13)_

- [x] **P0-09** `Money` type: integer minor units + ISO currency. Add, subtract, multiply, format
- [x] **P0-10** Money tests including the two-currency case that must refuse to total silently
- [x] **P0-11** `Quantity`, `DateRange`, `EnumValue` with `label_raw`
- [x] **P0-12** `FieldStatus` enum — all six values, documented meanings
- [x] **P0-13** `SourceRef` with all seven kinds, `derived_from`, `method`
- [ ] **P0-14** `Field<T>` wrapper, generic over value type
- [ ] **P0-15** Tests covering every `FieldStatus` and every `SourceKind`

**Done when:** unit tests cover all six statuses and a two-currency profile cannot produce a wrong total.

> Tell Claude Code: implement §3 of `specs/data-model-v1.md` **with the tests**, not the types alone. `Field<T>` looks trivial and isn't.

---

## Session C — Conversation additions _(~4h · step 13a)_

- [ ] **P0-16** Add `conversation` to `SourceKind`, `utterance_id` to `SourceRef`
- [ ] **P0-17** `Utterance` table and type, `UtteranceIntent` enum, `cost_eur` field
- [ ] **P0-18** Confidence base values per §2.3 of `specs/conversation-channel.md`

**Done when:** the schema can hold a conversation-sourced fact. Nothing writes to it yet.

---

## Session D — Profile tables _(~20h · step 14)_

- [ ] **P0-19** `Account`, `User`, `BusinessProfile` root
- [ ] **P0-20** The fourteen section types as columns/tables
- [ ] **P0-21** `Offer` with the three type-specific detail variants
- [ ] **P0-22** `Supplier`, `Channel`, `Competitor`
- [ ] **P0-23** `StaffRole`, `CostItem`, `CustomerSegment`, `Goal`
- [ ] **P0-24** `benchmark_consent` and `benchmark_eligible` on the profile
- [ ] **P0-25** Round-trip test: create, write fields, read back, no loss

**Done when:** a full profile round-trips through JSON without losing a single field or its provenance.

---

## Session E — Supersession _(~10h · step 15)_

- [ ] **P0-26** Field writes mark the previous record superseded rather than updating
- [ ] **P0-27** Query returns newest non-superseded value by default
- [ ] **P0-28** History query returns the full dated chain
- [ ] **P0-29** Test: change a price three times → three records, newest returned

**Done when:** nothing in the codebase can overwrite a fact. This is the task that cannot be retrofitted.

---

## Session F — Vocabularies _(~8h · step 16)_

- [ ] **P0-30** Vocabulary tables, loaded from the bank JSON
- [ ] **P0-31** `other` + `label_raw` preservation
- [ ] **P0-32** Report of recurring `other` values, for promoting into the list later

---

## Session G — Decision log _(~8h · step 17)_

- [ ] **P0-33** Append-only table, updates and deletes rejected at the database level
- [ ] **P0-34** Every profile change writes an entry
- [ ] **P0-35** Test that an update attempt throws

> Enforce append-only with a `BEFORE UPDATE OR DELETE` trigger that `RAISE`s, not `REVOKE`. `REVOKE` doesn't restrict the table owner, and migrations run as owner — the protection would be absent exactly where it counts.

---

## Session H — Bank loader _(~10h · step 18)_

- [ ] **P0-36** Load 153 questions, 55 vocabularies, 8 entity schemas from JSON
- [ ] **P0-37** Bank versioning — a new version doesn't invalidate existing answers
- [ ] **P0-38** Loader refuses a bank that fails lint

---

## Session I — Condition evaluator _(~12h · step 19)_

- [ ] **P0-39** All seven operators: `eq`, `neq`, `includes`, `gt/gte/lt/lte`, `answered/unanswered`, `and`, `or`, `not`
- [ ] **P0-40** The `.length` accessor on array fields
- [ ] **P0-41** Tests for each operator plus three levels of nesting

> No `if (sells.includes('physical'))` anywhere in application code. Branching is data.

---

## Session J — Applicability resolver _(~10h · step 20)_

- [ ] **P0-42** Given a profile, return currently applicable questions
- [ ] **P0-43** Test: services-only profile never surfaces inventory questions
- [ ] **P0-44** Test: adding "physical products" later makes them appear

---

## Session K — Completeness scorer _(~8h · step 21)_

- [ ] **P0-45** Weighted score, `core` heavy, `optional` near-zero
- [ ] **P0-46** `core_complete` true when the 25 always-asked are answered or explicitly unknown
- [ ] **P0-47** `blocking_gaps` list

---

## Session L — Interviewer agent _(~28h · steps 22–23)_

- [ ] **P0-48** Prompt: profile + applicable questions + history → next question ID + `selection_reason`
- [ ] **P0-49** Cheap core before expensive deep, using `priority` and `cost`
- [ ] **P0-50** **Prompt caching on the bank** — verify `cache_read_input_tokens` from turn two
- [ ] **P0-51** Token and cost logging per call, tagged by workload
- [ ] **P0-52** Harness: 20 synthetic profiles run end to end
- [ ] **P0-53** Assert across all 20: never asks an inapplicable question, never repeats one

**Done when:** the harness passes on all 20 and caching is confirmed in the API response.

---

## Session M — Answer parser _(~20h · steps 24–25)_

- [ ] **P0-54** Haiku parser: free text → typed value
- [ ] **P0-55** Estimate detection — "about", "roughly" lowers confidence and preserves the wording in `note`
- [ ] **P0-56** Multi-answer extraction: one paragraph fills several fields
- [ ] **P0-57** Interviewer skips what the paragraph already answered
- [ ] **P0-58** Test: "about 4 and a half million a month, before tax" → correct `Money`, lowered confidence, note kept

---

## Session N — Intake shell _(~30h · steps 26–27)_

- [ ] **P0-59** Design tokens as CSS custom properties, exact values from the UX spec
- [ ] **P0-60** Three-column stage layout, centre card, side columns
- [ ] **P0-61** Question card: eyebrow, prompt, help, control slot, action row
- [ ] **P0-62** Controls: text, long_text, number, money, boolean
- [ ] **P0-63** Controls: single_select, multi_select
- [ ] **P0-64** Control: file
- [ ] **P0-65** "I don't know" as a visible link, writing `unknown`
- [ ] **P0-66** Progress as `6 / 25 core`, never a percentage
- [ ] **P0-67** Keyboard: Enter submits, Cmd/Ctrl-Enter from textarea, full tab order

---

## Session O — Entity list sub-form _(~20h · step 28)_

- [ ] **P0-68** Repeating row form inside the question card
- [ ] **P0-69** Core sub-fields shown, "Add detail" reveals the rest
- [ ] **P0-70** Collapses to one chip: "4 products · 3 with costs", expands on click
- [ ] **P0-71** Timed test: five products entered in under 90 seconds

> The most complex control in the intake and the most likely abandonment point. Give it real time.

---

## Session P — Chips and motion _(~18h · steps 29–31)_

- [ ] **P0-72** Provenance chip: question, answer, mono source line, status dot
- [ ] **P0-73** Settle animation, ~580ms total, alternating columns
- [ ] **P0-74** `prefers-reduced-motion` disables all of it
- [ ] **P0-75** Chips clickable → reopen, keeping history, recording a reason
- [ ] **P0-76** Mobile layout: single column, "Recorded (6)" strip
- [ ] **P0-77** Usable at 360px, verified on a real phone

---

## Session Q — Validation _(~24h · steps 32–34)_

- [ ] **P0-78** Rule engine, declarative and versioned
- [ ] **P0-79** The nine rules from §7 of the data model
- [ ] **P0-80** Each rule: one passing test, one firing test
- [ ] **P0-81** Runs on every field write, not as a batch
- [ ] **P0-82** Reconcile panel — wording exactly as specified, curious not corrective
- [ ] **P0-83** Both resolution paths: "Both are right" and "Let me fix one"
- [ ] **P0-84** `ValidationFinding` and its resolution persist correctly

---

## Session R — Real intakes _(~24h · steps 35–36)_ ⚠ GATE

- [ ] **P0-85** Deploy to staging, make it reachable by a stranger
- [ ] **P0-86** Run ten intakes with real business owners. Watch silently, say nothing
- [ ] **P0-87** Log every hesitation, every confusion, the actual abandonment point
- [ ] **P0-88** Rewrite the questions that failed — expect 15 to 30
- [ ] **P0-89** Increment bank version, lint passes
- [ ] **P0-90** Compare measured API cost per intake against the €1.31 estimate

**Do not skip P0-86.** Friends being polite is not this task.

---

## Phase 0 is done when

A stranger can complete an intake, on a phone, and the result is a profile where every fact carries its source and confidence, contradictions were caught as they happened, and nothing was overwritten.

Localisation is not a Phase 0 task. Every string stays in `LocalizedText` and no copy
is hard-coded in a component, so adding a locale later is content work rather than a
refactor. Which locale, and whether at all, is decided at Gate 1 from customer geography.

Then write the Phase 1 tasks — informed by what the ten intakes taught you, not by what I guessed today.
