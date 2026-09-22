# TASKS-PHASE3.md — Execution

Commit-sized tasks in strict order. Work top to bottom. Reference the task ID in each commit message.

**Scope: Phase 3 only** — the system stops merely diagnosing and starts doing, with the owner's recorded approval on every consequential action. Proposals with honest scenarios, an approval queue where "no" weighs the same as "yes", an execution engine that cannot run twice and can permanently undo what it did, and a trust layer that scores the agent's own suggestions against real outcomes. The Glass Business gets real stakes here: it is now publicly executing, not just reporting. Sells at **€129/month**; months ~12–22 of the programme; **35 dev-weeks budgeted — the biggest phase**.

**Sources, in precedence order:** the owner's Phase 3 scope statement (supplied 2026-09-21, folded in below — it was not previously recorded in the repo), then build-sequence Part 5 (steps 68–80), then `data-model-v1.md` §11, which declared the `Proposal` shape and the decision-log kinds in v1 precisely so this phase attaches instead of restructuring. Two deliberate amendments to the older specs are marked **Amended 2026-09-21** where they occur.

**Gate status, recorded honestly:** this plan was drafted 2026-09-21 while **Phase 2's done-when remains unmet** — no real account has connected, the two-week unattended-sync clock has not started, and no genuine anomaly has been caught. **The owner opened Phase 3 on 2026-09-21 ("start")**, the same deliberate override as P0-86 and the Phase 2 opening; nobody should later mistake it for the gates having been met. The opening covers Sessions A–C, which touch nothing external. **Session D's first real write remains gated on Phase 2's done-when being judged**, as this file has said from its first draft — that inner gate was not part of the override. The strategy note's own caution is adopted here: this task list precedes Gate 1's customer evidence, so it is **PROVISIONAL twice over** — provider write-API specifics must be verified at build time, and the session ordering should be re-judged against what real customers actually said before the first commit. Sessions A and B touch nothing external and can safely overlap the Phase 2 sync clock; **the first real write (Session D) must wait until Phase 2's done-when has been judged** — executing against a measurement layer that has never measured anything is testing two unproven layers at once.

**What Phase 3 is NOT** (still fenced, Phase 4+): support, CRM, finance, HR or inventory modules; website chat; phone AI; outbound email as infrastructure (marketing email _drafting_ is in scope; consent-gated sending machinery is Phase 4); subscription billing beyond the existing report gate. If a task seems to need one of these, stop and ask.

---

## Non-negotiables inherited, plus seven new ones

The eleven existing rules apply unchanged — and rule 9 (read-only scopes on measurement connectors, forever) is not weakened by this phase; it is joined by a separate, deliberately narrow write path. New for Phase 3:

**12. Nothing executes without a recorded human approval.** `requires_approval: true` is literal in the type and never optional. An approval is stored with the user id and timestamp; proposal, approval, rejection and execution each land in the append-only decision log with a payload hash. The compliance record showing a human approved every consequential action is a feature, not overhead (GDPR Art. 22 exposure).

**13. Write access is its own consent, never an upgrade.** Execution credentials are separate connections with their own scope registry — an explicit, minimal, per-provider allowlist of write scopes — and their own consent screen naming exactly what the system may do. The Phase 2 measurement registry keeps its build-failing no-writes test untouched; a second build-failing test pins the execution registry to its allowlist. A read-only connection can never silently gain a write scope.

**14. Hard limits are enforced at generation, and the restraint is visible.** Every proposal is checked against the owner's answer to 13.5 ("what would you never want the business to do, regardless of results") before it reaches the queue. A violating proposal is blocked — but **shown as blocked**, so the owner sees what the system chose not to propose. **Amended 2026-09-21, owner scope:** build-sequence step 70 said blocked-and-logged only; visible restraint builds more trust than silent restraint, and the Glass Business shows its work.

**15. Watching mode blocks execution, and there is an emergency stop.** A live business gets its 4–8 weeks of observation first, enforced by an integration test proving no write-capable call can execute during it (build-sequence step 67: "this test protects a real business from you"). One owner-visible control halts everything in flight within seconds; both properties are tests, not intentions.

**16. Execution is idempotent, journaled, and undoable.** A proposal cannot execute twice — idempotency key, hard attempt caps on retries — and every attempt is recorded with its result. Anything reversible gets a **permanent undo, stored indefinitely rather than for a time window**. Expired is not rejected; both are distinct statuses with distinct meanings.

**17. Published content discloses itself.** Anything the system publishes is marked AI-assisted, per platform requirements and the EU AI Act, applied automatically, with no way to switch it off.

**18. Money surfaces are untouchable.** No write ever targets checkout, payments or payment configuration — at any approval level, on any platform, in any phase. This is a registry-enforced exclusion with its own failing test, not a review-time judgement call.

---

## Session A — Proposal spine and approval queue _(~3 wks)_

Steps 68 and 70. No external writes anywhere in this session — everything lands in our own tables.

- [x] **P3-01** `proposals` table per data-model §11: profile_id, module, originating_finding, action payload (jsonb), scenario (jsonb `ScenarioBlock` with assumptions carrying sources and sensitivity), reversibility (can it be undone, and how), status (pending/approved/rejected/expired/executed/blocked), decided_by, decided_at, rejection_reason, execution_result. `requires_approval` is a check constraint pinned true.
- [x] **P3-02** Decision-log wiring: proposal, approval, rejection and execution entries with payload hashes. The enum has carried these kinds since P0-33; this task makes them real. Append-only trigger already covers the table.
- [x] **P3-03** Hard-limits evaluator (rule 14): the 13.5 answer parsed once into structured limits at capture time, then a deterministic check at generation — no model call to decide whether "never discount" means never discount. Blocked proposals stored with the limit they hit and **rendered in a restraint view** ("I didn't propose these, because you told me never to"). Tests: a violating proposal blocked-and-visible, a clean one passing.
- [x] **P3-04** Proposal generation v1: diagnosis recommendations and anomalies → proposals stating what will happen, why, the evidence behind it, the expected effect, and whether it can be undone. Scenario arithmetic (base/downside/upside, breakeven) is deterministic from measured and stated facts with `derived_from`; Sonnet words the proposal, never computes it. Every proposal points at its evidence fields — no proposal without data behind it.
- [x] **P3-05** Approval queue screen, ux-spec §8 verbatim: what will happen, why, what it's based on, what happens if you decline. Two buttons of equal visual weight; decline asks why (free text, stored — P3-28 feeds on it). **Bulk review** for batches of similar proposals and **scheduled actions** (approve now, execute at a stated time). `--signal` at full strength here and nowhere else; the rail badge counts approvals and nothing else.
- [x] **P3-06** Expiry: proposals expire after a stated window, and expired ≠ rejected in every query and screen.
- [x] **P3-07** Notifications, in-app tier only: needs-you badge for approvals, worth-knowing digest for the rest. The one-push-per-day cap is recorded here as the rule for when push arrives; no push infrastructure in this session.

**Done when:** a real profile's diagnosis produces proposals that render in the queue with honest scenarios and reversibility stated; one approval and one rejection-with-reason land in the decision log with payload hashes; and a proposal violating a 13.5 hard limit appears only in the restraint view, marked blocked.

---

## Session B — The execution fence _(~3 wks)_

Steps 67 and 69. Built and proven against a fixture provider before any real platform is touched — the same order Phase 2 used (fixture connector first, Stripe second).

- [x] **P3-08** Execution scope registry (rule 13): per-provider allowlist of write scopes in code, a build-failing test pinning it, a second test asserting the Phase 2 measurement registry still contains zero write-capable scopes, and the rule-18 exclusion test proving no checkout/payment surface is reachable. Consent screen content lives here as data, the way `SCOPE_GUIDE` renders the read registry.
- [x] **P3-09** Watching-mode write block (step 67): the integration test that refuses execution while a profile is in watching mode, wired into the engine's single entry point so it cannot be bypassed by a new call site.
- [x] **P3-10** Execution engine core: approved proposals only; idempotency key per proposal; hard attempt caps; retries with backoff; `execution_result` recorded on the proposal and an execution entry in the decision log. Refuses pending, rejected, expired, blocked and already-executed proposals with distinct errors.
- [x] **P3-11** Rollback store (rule 16): for every reversible action, the undo payload captured **before** execution and kept indefinitely; a one-click undo path through the same engine (journaled, idempotent, watching-checked like any write). Tests: undo restores the prior state on the fixture provider; an irreversible action is labelled so before approval, not discovered after.
- [x] **P3-12** Emergency stop (rule 15): owner-visible control that halts everything in flight within seconds — checked inside the engine loop, not just at enqueue. Test: a queued execution dies when the switch flips.
- [x] **P3-13** Execution telemetry: cost, duration and outcome per attempt, structured log with account id, same table pattern as connector syncs.

**Done when:** a fixture execution provider executes an approved proposal exactly once under concurrent retries; unapproved, expired and watching-mode executions are refused; a reversible action undoes cleanly from its stored payload; the emergency stop kills a queued execution mid-flight — all as tests, none needing a real platform.

**Status 2026-09-22:** Done — every clause of the done-when is a passing test (22 in lib/execution, 649 total). The engine is one entry point with seven ordered guards; the registry's three build gates (pinned allowlist, honest write naming under the measurement audit's own vocabulary, the rule-18 money fence) each have a deliberately planted violation proving they bite; a profile with no mode decision is blocked like a watching one; and a failed run resumes with a fresh attempt budget. The emergency stop's owner-visible control arrives with the surfaces that need it (Session D's first real write ships the button; the service and its guards exist now).

---

## Session C — Marketing: goals, content, footage _(~5 wks)_

Steps 71–73 plus the owner's scope. Content is planned and produced here; nothing publishes yet.

- [ ] **P3-14** Goal setting wired end to end: the `goals` table (in the schema since P0-22) gets its service and screen, seeded from the diagnosis findings and the 13.1 answers, each goal a dated, measurable statement the trust layer (Session E) can score against.
- [ ] **P3-15** Content calendar: calendar proposals tied to goal records — each planned item names its goal, channel and predicted contribution, and arrives through the P3-04 pipeline like any other proposal.
- [ ] **P3-16** Posts and emails drafted in the owner's voice — voice learned from the intake conversation and any existing content the owner points at, with the source of each stylistic choice statable. Email is drafting only in this phase (sending machinery is Phase 4; drafts export or publish through connected platforms that handle consent).
- [ ] **P3-17** Shot lists: the system tells the owner exactly what to film, derived from what performed before (Phase 2 observations + P3-26 outcomes as they accrue). A shot list is a proposal like any other — evidence attached.
- [ ] **P3-18** Footage editing: the owner's real clips cut, captioned, cropped per platform, scored with **licensed** music, via FFmpeg. **No generated video.** **Amended 2026-09-21, owner scope:** build-sequence step 72 allowed generation as fallback; the owner's scope removes it — real footage or nothing. Editing costs measured and logged per item from the first render.
- [ ] **P3-19** AI disclosure (rule 17): drafted and edited items carry the required AI-assisted labels automatically, verified per target platform at build time, with no disable path in code or UI.

**Done when:** an approved content proposal produces a finished item — drafted copy or edited footage — carrying its goal, scenario, provenance and disclosure label, sitting in a scheduled queue that has nowhere to publish yet.

---

## Session D — Publishing and campaigns: the real writes _(~6 wks)_

Step 74 plus ad management. **Gated twice:** Phase 2's done-when judged first, and one platform at a time, each an owner decision recorded here before its first commit.

- [ ] **P3-20** First write connector, one platform (Meta is the likely first — its read side already exists): separate connection, separate consent screen naming exactly what may be written, write scopes from the P3-08 registry, secrets AES-encrypted like every other credential. ⏸ **Owner decision: confirm the platform.**
- [ ] **P3-21** Scheduler and publish path: approved, scheduled items flow through the P3-10 engine — watching-check, emergency stop, idempotency, rollback and journaling all inherited, not reimplemented. A published item stores the platform's own id for readback; deleting/unpublishing is the stored undo where the platform allows it.
- [ ] **P3-22** Campaigns and ad account management — Meta first; Google Ads still ⏸ **blocked on the same Google approvals as P2-20** (developer token + OAuth verification, no read-only scope); TikTok needs both its read and write side built, since Phase 2 has no TikTok connector — budget it as a full new provider or defer, owner decision. Budget changes and campaign starts are proposals with scenarios; every spend action reversible or labelled irreversible before approval.
- [ ] **P3-23** Performance tracking per post and per campaign, flowing into the Phase 2 observation tables so anomaly detection and the watch see marketing activity like any other metric.
- [ ] **P3-24** Failure honesty: expired credentials, platform rejections and rate limits surface in the owner's language ("I couldn't post — the connection expired. Reconnect and I'll pick up where I left off"), degrade to paused, never fail silently.

**Done when:** one real item, approved by a real owner, publishes to one real platform exactly once with its disclosure label visible on-platform; one real campaign change executes with its scenario on record; and one published item is cleanly undone from its stored rollback payload.

---

## Session E — The trust layer _(~4 wks)_

Steps 75–77 plus the owner's scope. The loop closes: predictions meet measurements, and the agent gets a public report card.

- [ ] **P3-25** Performance readback: every approved action tied to its goal and measured through the Phase 2 observation tables; the proposal's actual outcome renders against its predicted scenario, assumption by assumption.
- [ ] **P3-26** The agent scorecard: suggestions made, approved, **helped, did nothing, backfired** — judged by deterministic rules against measured outcomes, with the arithmetic shown. This is the Glass Business scoring itself in public; the numbers render whatever they say.
- [ ] **P3-27** Suggestion history and outcome detail screens: every proposal ever made, its decision, its execution, its outcome — the decision log made legible.
- [ ] **P3-28** Learning from declines (step 76): rejection reasons feed proposal generation — an owner who rejected three video proposals stops receiving video proposals. Deterministic suppression rules first; no model-inferred taste.
- [ ] **P3-29** Mobile approval (step 77): a proposal reviewed and decided in under 30 seconds on a phone — measured, not assumed, with the P0-71 stopwatch discipline.

**Done when:** the scorecard renders honest numbers from real executions; a published item's measured outcome appears against its prediction; and a thrice-rejected proposal kind provably stops being generated.

---

## Session F — Website changes, Tier 3 _(~5 wks)_

Site-audit 74a–c plus the owner's scope. The highest-trust write surface, so it carries the strictest rules in the phase.

- [ ] **P3-30** Platform detection and scoped credentials: theme/content write access only — never admin, and never anything rule 18 covers. Platforms that cannot take programmatic changes are detected and honestly labelled, never promised.
- [ ] **P3-31** Preview-first, always: changes applied to a preview copy, never straight to live. Rendered before/after screenshots from the real page, mobile and desktop, on the visual approval card.
- [ ] **P3-32** One-click undo, permanent: the pre-change state stored indefinitely via P3-11; undo works months later, not just inside a window.
- [ ] **P3-33** Auto-rollback **only on hard failures** — errors, load regressions — never on conversion noise. The thresholds are code with tests at the boundaries, the Session E (Phase 2) discipline applied to rollback.
- [ ] **P3-34** Checkout and payments untouchable (rule 18): the exclusion enforced in the change generator and the credential scopes both, with a test that a checkout-touching change cannot even be proposed.
- [ ] **P3-35** The manual path for Wix and Squarespace: rendered before/after plus step-by-step instructions for the owner's own editor — a useful answer for the third of customers whose platform can't be edited programmatically.

**Done when:** a real site change previews with honest before/after renders, applies on approval, undoes with one click, and a deliberately seeded hard failure auto-rolls-back while a conversion dip does not.

---

## Session G — Conversation: the request tier _(~1 wk)_

Conversation-channel step 70a.

- [ ] **P3-36** "Post something about the new product" becomes a **proposal in the queue, not an action** — the chat gains a request tier that generates through P3-04, gated by hard limits and watching mode like every other source. The conversation never executes anything directly.

**Done when:** a chat request produces a queued proposal with evidence and scenario, and a request violating a hard limit lands in the restraint view with a plain-language explanation in the chat.

---

## Gate 2 — does it actually work? _(steps 78–80)_

Runs after Session E has real traffic through it. Not a formality; 35 dev-weeks earns a hard look.

- [ ] **P3-37** Approval rate measured across all customers. **Under 30% means stop adding modules** — a system owners won't trust to act isn't worth extending, and more modules will not fix that.
- [ ] **P3-38** Outcomes measured on approved actions against their scenario predictions, stated honestly — the scorecard's aggregate, not a new number.
- [ ] **P3-39** Decide, on the record: high approval and measurable results → continue to Phase 4 planning. High approval and flat results → the software works and doesn't produce outcomes; that is a positioning problem and it gets solved before selling harder.

---

## Cost discipline, Phase 3 shape

The €50/month rule and workload routing stand until revenue moves them. Sonnet words proposals and drafts copy (never computes — scenarios are arithmetic); FFmpeg renders are compute, not tokens, and get measured per item from the first render; licensed music is a per-track cost that needs a quote before P3-18 starts (the build-sequence step-2 media quotes finally matter); site-audit's ~€0.08 per change proposal applies in Session F. Every retry loop in the engine has a hard cap, and execution telemetry (P3-13) makes the phase's true cost a query, not archaeology.

## Phase 3 is done when

A real business receives proposals with honest scenarios and stated reversibility; approves one on a phone in under 30 seconds; the action executes exactly once, disclosed as AI-assisted on the platform, and can be permanently undone; blocked proposals are visible as restraint; one hard-limit violation, one watching-mode attempt and one checkout-touching change were provably stopped; the scorecard renders helped / did nothing / backfired from measured outcomes; a rejection with a reason has visibly changed what gets proposed; and Gate 2's approval rate exists as a query with an honest value — whatever it says.
