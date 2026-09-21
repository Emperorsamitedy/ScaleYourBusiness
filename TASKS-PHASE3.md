# TASKS-PHASE3.md — Execution

Commit-sized tasks in strict order. Work top to bottom. Reference the task ID in each commit message.

**Scope: Phase 3 only** — the system stops merely diagnosing and starts doing, with the owner's recorded approval on every consequential action. Proposals with honest scenarios, an approval queue where "no" weighs the same as "yes", an execution engine that cannot run twice, and readback that shows whether an approved action actually helped. Build-sequence Part 5 (steps 68–80) is the skeleton; `data-model-v1.md` §11 declared the `Proposal` shape and the decision-log kinds in v1 precisely so this phase attaches instead of restructuring.

**Gate status, recorded honestly:** this plan was drafted 2026-09-21 while **Phase 2's done-when remains unmet** — no real account has connected, the two-week unattended-sync clock has not started, and no genuine anomaly has been caught. Drafting is not an override; the "do not build yet" fence in CLAUDE.md stands until the owner explicitly opens Phase 3. When that happens, record the decision here, the same way TASKS-PHASE2.md records its override. Sessions A and B touch nothing external and can safely overlap the Phase 2 sync clock; **the first real write (Session D) must wait until Phase 2's done-when has been judged** — executing against a measurement layer that has never measured anything is testing two unproven layers at once.

**Status: PROVISIONAL.** Platform write-API specifics (Meta publishing endpoints, Shopify theme access, disclosure label mechanics per platform) must be verified at build time, not trusted from this plan — the same discipline that caught the Stripe scope-listing and Shopify custom-app amendments in Phase 2.

**What Phase 3 is NOT** (still fenced, Phase 4+): support, CRM, finance, HR or inventory modules; outbound email; website chat; phone AI; subscription billing beyond the existing report gate. If a task seems to need one of these, stop and ask.

---

## Non-negotiables inherited, plus six new ones

The eleven existing rules apply unchanged — and rule 9 (read-only scopes on measurement connectors, forever) is not weakened by this phase; it is joined by a separate, deliberately narrow write path. New for Phase 3:

**12. Nothing executes without a recorded human approval.** `requires_approval: true` is literal in the type and never optional. An approval is stored with the user id and timestamp; proposal, approval, rejection and execution each land in the append-only decision log with a payload hash. The compliance record showing a human approved every consequential action is a feature, not overhead (GDPR Art. 22 exposure).

**13. Write access is its own consent, never an upgrade.** Execution credentials are separate connections with their own scope registry — an explicit, minimal, per-provider allowlist of write scopes — and their own consent screen naming exactly what the system may do. The Phase 2 measurement registry keeps its build-failing no-writes test untouched; a second build-failing test pins the execution registry to its allowlist. A read-only connection can never silently gain a write scope.

**14. Hard limits are enforced at generation.** Every proposal is checked against the owner's answer to 13.5 ("what would you never want the business to do, regardless of results") before it reaches the queue. A violating proposal is blocked and logged, never shown. An owner who said "never discount" never sees a discount proposal.

**15. Watching mode blocks execution, and there is a kill switch.** An integration test asserts no write-capable call can execute while a profile is in watching mode (build-sequence step 67: "this test protects a real business from you"). A kill switch, owner-visible, halts all execution within seconds; both properties are tests, not intentions.

**16. Execution is idempotent and journaled.** A proposal cannot execute twice — idempotency key per proposal, hard attempt caps on retries — and every attempt is recorded with its result. Expired is not rejected; both are distinct statuses with distinct meanings.

**17. Generated content discloses itself.** AI-generated content carries the labels each platform and the EU AI Act require, applied automatically, with no way to disable it.

---

## Session A — Proposal spine and approval queue _(~20h)_

Steps 68 and 70. No external writes anywhere in this session — everything lands in our own tables.

- [ ] **P3-01** `proposals` table per data-model §11: profile_id, module, originating_finding, action payload (jsonb), scenario (jsonb `ScenarioBlock` with assumptions carrying sources and sensitivity), status (pending/approved/rejected/expired/executed), decided_by, decided_at, rejection_reason, execution_result. `requires_approval` is a check constraint pinned true.
- [ ] **P3-02** Decision-log wiring: proposal, approval, rejection and execution entries with payload hashes. The enum has carried these kinds since P0-33; this task makes them real. Append-only trigger already covers the table.
- [ ] **P3-03** Hard-limits evaluator (rule 14): the 13.5 answer parsed once into structured limits at capture time, then a deterministic check at generation — no model call to decide whether "never discount" means never discount. Blocked proposals logged with the limit they hit. Tests: a violating proposal blocked, a clean one passing.
- [ ] **P3-04** Proposal generation v1: diagnosis recommendations and anomalies → proposals with scenarios. Scenario arithmetic (base/downside/upside, breakeven condition) is deterministic from measured and stated facts with `derived_from`; Sonnet words the proposal, never computes it. Every proposal points at its evidence fields — no proposal without data behind it.
- [ ] **P3-05** Approval queue screen, ux-spec §8 verbatim: what will happen, why, what it's based on, what happens if you decline. Two buttons of equal visual weight. `--signal` at full strength here and nowhere else; the rail badge counts approvals and nothing else.
- [ ] **P3-06** Rejection reasons and expiry: declining asks why (free text, stored — the learning corpus P3-21 will feed on); proposals expire after a stated window, and expired ≠ rejected in every query and screen.
- [ ] **P3-07** Notifications, in-app tier only: needs-you badge for approvals, worth-knowing digest for the rest. The one-push-per-day cap is recorded here as the rule for when push arrives; no push infrastructure in this session.

**Done when:** a real profile's diagnosis produces proposals that render in the queue with honest scenarios; one approval and one rejection-with-reason land in the decision log with payload hashes; and a proposal violating a 13.5 hard limit is blocked at generation, visible only in the log.

---

## Session B — The execution fence _(~16h)_

Steps 67 and 69. Built and proven against a fixture provider before any real platform is touched — the same order Phase 2 used (fixture connector first, Stripe second).

- [ ] **P3-08** Execution scope registry (rule 13): per-provider allowlist of write scopes in code, a build-failing test pinning it, and a second test asserting the Phase 2 measurement registry still contains zero write-capable scopes. Consent screen content lives here as data, the way `SCOPE_GUIDE` renders the read registry.
- [ ] **P3-09** Watching-mode write block (step 67): the integration test that refuses execution while a profile is in watching mode, wired into the engine's single entry point so it cannot be bypassed by a new call site.
- [ ] **P3-10** Execution engine core: approved proposals only; idempotency key per proposal; hard attempt caps; retries with backoff; `execution_result` recorded on the proposal and an execution entry in the decision log. Refuses pending, rejected, expired and already-executed proposals with distinct errors.
- [ ] **P3-11** Kill switch (rule 15): owner-visible control that halts execution within seconds — checked inside the engine loop, not just at enqueue. Test: a queued execution dies when the switch flips.
- [ ] **P3-12** Execution telemetry: cost, duration and outcome per attempt, structured log with account id, same table pattern as connector syncs.

**Done when:** a fixture execution provider executes an approved proposal exactly once under concurrent retries; unapproved, expired and watching-mode executions are refused; the kill switch stops a queued execution mid-flight — all as tests, none needing a real platform.

---

## Session C — Goals and the content pipeline _(~18h)_

Steps 71–73. Content is planned and generated here; nothing publishes yet.

- [ ] **P3-13** Goal setting wired end to end: the `goals` table (in the schema since P0-22) gets its service and screen, seeded from the 13.1 answers, each goal a dated, measurable statement the readback (P3-20) can be scored against.
- [ ] **P3-14** Content planning: calendar proposals tied to goal records — each planned item names its goal, channel and predicted contribution, and arrives through the P3-04 pipeline like any other proposal.
- [ ] **P3-15** Content generation, owner-footage first (step 72): the upload-and-edit path is the default in the UI, generation is the fallback — not the other way around. Media generation costs measured and logged per item from the first call.
- [ ] **P3-16** AI disclosure (rule 17): generated items carry the required labels automatically, verified per target platform at build time, with no disable path in code or UI.

**Done when:** an approved content proposal produces a draft item carrying its goal, scenario, provenance and disclosure label, sitting in a scheduled queue that has nowhere to publish yet.

---

## Session D — Publishing: the first real write _(~20h)_

Step 74. **Gated twice:** Phase 2's done-when judged first, and the platform choice is an owner decision recorded here before the first commit. Build-sequence order says social publishing first (Meta is already a measurement provider; its write side is the smallest new surface). The alternative first write — website changes per site-audit 74a–c — is larger and stays in Session F.

- [ ] **P3-17** First write connector, one platform: separate connection, separate consent screen naming exactly what may be written, write scopes from the P3-08 registry, secrets AES-encrypted like every other credential. ⏸ **Owner decision: which platform.**
- [ ] **P3-18** Scheduler and publish path: approved, scheduled items flow through the P3-10 engine — watching-check, kill switch, idempotency and journaling all inherited, not reimplemented. A published item stores the platform's own id for readback.
- [ ] **P3-19** Failure honesty: expired credentials, platform rejections and rate limits surface in the owner's language ("I couldn't post — the connection expired. Reconnect and I'll pick up where I left off"), degrade to paused, never fail silently.

**Done when:** one real item, approved by a real owner, publishes to one real platform exactly once, with the disclosure label visible on the platform and the execution journaled end to end.

---

## Session E — Readback and learning _(~16h)_

Steps 75–77. The loop closes: predictions meet measurements.

- [ ] **P3-20** Performance readback: every published item tied to its goal and measured through the Phase 2 observation tables; the proposal's actual outcome renders against its predicted scenario, assumption by assumption.
- [ ] **P3-21** Rejection learning (step 76): rejection reasons from the decision log feed proposal generation — an owner who rejected three video proposals stops receiving video proposals. Deterministic suppression rules first; no model-inferred taste.
- [ ] **P3-22** Mobile approval (step 77): a proposal reviewed and decided in under 30 seconds on a phone — measured, not assumed, with the P0-71 stopwatch discipline.

**Done when:** a published item's measured outcome appears against its prediction, and a thrice-rejected proposal kind provably stops being generated.

---

## Session F — Second executors _(unscheduled, owner priority)_

Declared so they attach cleanly; not ordered until the owner picks.

- [ ] **P3-23** Conversation `request` intent → proposals (conversation-channel step 70a), gated by hard limits and watching mode like every other source.
- [ ] **P3-24** Website changes (site-audit 74a–c): platform detection, dual-render approval card, apply-and-rollback for platforms with APIs, and the manual-instructions path for Wix and Squarespace — never promising automatic changes to a platform that can't take them.

---

## Gate 2 — does it actually work? _(steps 78–80)_

Runs after Session E has real traffic through it. Not a formality; the build-sequence budget for this phase is 14 weeks with 18 planned, and this gate is why.

- [ ] **P3-25** Approval rate measured across all customers. Under 30% means the system doesn't understand these businesses well enough to act on them — and more modules will not fix that.
- [ ] **P3-26** Outcomes measured on approved actions against their scenario predictions, stated honestly.
- [ ] **P3-27** Decide, on the record: high approval and measurable results → continue to Phase 4 planning. High approval and flat results → the software works and doesn't produce outcomes; that is a positioning problem and it gets solved before selling harder.

---

## Cost discipline, Phase 3 shape

The €50/month rule and workload routing stand. New spend in this phase: Sonnet words proposals (never computes them — scenarios are arithmetic); content generation is the first real media cost and gets measured from call one (the step-2 media quotes finally matter); site-audit's ~€0.08 per change proposal applies if P3-24 opens. Every retry loop in the engine has a hard cap, and execution telemetry (P3-12) makes the phase's true cost a query, not archaeology.

## Phase 3 is done when

A real business receives proposals with honest scenarios, approves one on a phone in under 30 seconds, and the action executes exactly once with its disclosure label on the platform; its measured outcome renders against the prediction; one hard-limit violation and one watching-mode execution attempt were provably blocked; a rejection with a reason has visibly changed what gets proposed; and Gate 2's approval rate and outcome numbers exist as queries with honest values — whatever they say.
