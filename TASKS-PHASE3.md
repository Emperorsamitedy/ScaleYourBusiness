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

**Status 2026-09-22:** Done — every clause of the done-when is a passing test (22 in lib/execution, 649 total). The engine is one entry point with seven ordered guards; the registry's three build gates (pinned allowlist, honest write naming under the measurement audit's own vocabulary, the rule-18 money fence) each have a deliberately planted violation proving they bite; a profile with no mode decision is blocked like a watching one; and a failed run resumes with a fresh attempt budget. **Updated 2026-09-26:** the owner-visible control now exists — one EmergencyStop component on /proposals, /site and /content, backed by /api/stop. Its asymmetry mirrors P1-44: stopping is one click with no confirmation and no sign-in (the person at the keyboard in an emergency gets to stop the machine; the row records who when a session exists, null when it doesn't), while resuming asks for confirmation and a signed-in name. When halted it is the one place --err renders at full strength, states what is and isn't stopped, and shows the stopper's own reason. A second panicked stop keeps the FIRST stop's record. Verified live: stop → halted card with timestamp → resume-with-confirmation → quiet again.

---

## Session C — Marketing: goals, content, footage _(~5 wks)_

Steps 71–73 plus the owner's scope. Content is planned and produced here; nothing publishes yet.

- [x] **P3-14** Goal setting wired end to end: the `goals` table (in the schema since P0-22) gets its service and screen, seeded from the diagnosis findings and the 13.1 answers, each goal a dated, measurable statement the trust layer (Session E) can score against.
- [x] **P3-15** Content calendar: calendar proposals tied to goal records — each planned item names its goal, channel and predicted contribution, and arrives through the P3-04 pipeline like any other proposal.
- [x] **P3-16** Posts and emails drafted in the owner's voice — voice learned from the intake conversation and any existing content the owner points at, with the source of each stylistic choice statable. Email is drafting only in this phase (sending machinery is Phase 4; drafts export or publish through connected platforms that handle consent).
- [x] **P3-17** Shot lists: the system tells the owner exactly what to film, derived from what performed before (Phase 2 observations + P3-26 outcomes as they accrue). A shot list is a proposal like any other — evidence attached.
- [x] **P3-18** Footage editing: the owner's real clips cut, captioned, cropped per platform, scored with **licensed** music, via FFmpeg. **No generated video.** **Amended 2026-09-21, owner scope:** build-sequence step 72 allowed generation as fallback; the owner's scope removes it — real footage or nothing. Editing costs measured and logged per item from the first render.
- [x] **P3-19** AI disclosure (rule 17): drafted and edited items carry the required AI-assisted labels automatically, verified per target platform at build time, with no disable path in code or UI.

**Done when:** an approved content proposal produces a finished item — drafted copy or edited footage — carrying its goal, scenario, provenance and disclosure label, sitting in a scheduled queue that has nowhere to publish yet.

**Status 2026-09-22:** Done, with one honest gate left open inside it. Verified in the browser end to end: goal added on /content, calendar proposed (a real Haiku parse of the seeded 13.5 answer put "never sound corporate" on the card as a manual limit), approved on /proposals, drafted into six disclosed items in the queue — which states on-screen that it publishes nowhere yet. The cutting room is proven by a real render in tests: 1080×1920, caption burned via libass (the static ffmpeg ships without drawtext — found by running it), disclosure verified inside the container by ffprobe, and a music request refused by name against the empty licensed manifest. **Licensed music remains owner-gated:** assets/music/manifest.json holds zero tracks until the licensing quotes exist, and the refusal message says so. Voice-card drafting runs on Sonnet behind the injectable seam; the live path awaits its first real approved plan with post/email slots. 25 tests in lib/content.

---

## Session D — Publishing and campaigns: the real writes _(~6.5 wks)_

Step 74 plus ad management. **Expanded 2026-09-30** from five lines into the layered plan below, at the owner's request and before any Session D commit. The original five task lines are kept as the layer headings (P3-20..24) so every cross-reference — CLAUDE.md, the v0.0.14/15 changelogs, the "Session D gate" strings in `lib/site/apply.ts`, `lib/site/platform.ts`, `lib/execution/scopes.ts`, `lib/content/disclosure.ts`, `lib/trust/readback.ts` and `components/content/ContentScreen.tsx` — stays valid. Sub-tasks are lettered and commit-sized. Migration numbers are indicative (next free is 0030).

**Owner decisions, recorded 2026-09-30 (the last one 2026-10-12):**

- **Meta first.** One Meta connection covers Facebook Pages, Instagram professional accounts and the Marketing API for ad accounts, and its read side (P2-19) already exists. Instagram goes through the **Facebook Login** configuration, not Instagram Login, because media deletion — the undo path — exists only there.
- **TikTok deferred.** Phase 2 has no TikTok connector, so it would be a full new provider on both the read and write side. Not in this session; re-judged after Meta's done-when.
- **Google Ads stays blocked** on the same approvals as P2-20 (developer token + OAuth verification).
- **The gate, amended.** Phase 2 is judged _good enough to proceed_ (TASKS-PHASE2.md, amendment 2026-09-30) once a Stripe test-mode restricted key is connected, the twelve-month backfill is verified on the report, and the connector-sync cron has fired successfully on its own at least once. The two-week unattended clock keeps running alongside D0–D3 and **must have completed before the first real publish** (D2's done-when), which is weeks away regardless. Building D0 needs no external account at all.
- **Pilot access before Meta's approvals (2026-10-12).** SYB is not yet a registered company, so Business Verification — and with it App Review, Tech Provider verification and open sign-up — waits for registration, which comes after the build. Until then owners reach Session D through **two routes, both Meta-sanctioned and both verified identically** by `connectForExecution()`: **(1) testers** — the owner is added as a Tester on SYB's Meta app and connects through Facebook Login (P3-20j); Meta grants every permission to app-role holders at Standard Access without review, so this is the official testing route, sized for a handful of pilot businesses rather than open sign-up; **(2) the owner's own Meta app** — the owner creates an app in their own business portfolio, where Standard Access covers their own assets without review, and pastes its token (P3-20g), the same pattern Phase 2's Meta ads connection already uses. Considered and not chosen: copy-and-post publishing with no Meta permissions, and routing through an already-approved third-party publisher.

**Sources, in precedence order:** the owner's Phase 3 scope statement; build-sequence step 74; data-model §11; ux-spec §8; then Meta's Graph API v26.0 / Marketing API v25.0 reference pages and the Vercel cron and Blob pricing pages, all read 2026-09-30. Facts Meta's own documentation contradicts or omits are marked _verify at build_ and collected at the end of the session.

**What Session D is NOT:** email sending (Phase 4 Session F); TikTok, Google Ads, LinkedIn, X; any write to checkout, payments, billing, funding or payment methods on any platform (rule 18); AI-generated imagery or video (owner scope, P3-18); anything that runs without a recorded approval (rule 12). If a sub-task seems to need one of these, stop and ask.

### D0 — Foundations the writes need _(~1 wk, no external calls)_

What the fixture-proven engine still lacks before a real provider can hang off it, found by reading the code on 2026-09-30: nothing maps `executions.provider` back to a provider object (`app/api/site/route.ts` hard-codes the fixture); nothing executes an approved proposal once `execute_not_before` passes; `content_items` has no publish state and `media_path` is never written; rendered clips live only on local disk; and the read-side `connect()` rightly refuses every write-capable scope, so a write connection needs its own door.

- [x] **P3-20a** Provider resolution: `lib/execution/providers/index.ts` maps every `ExecutionProviderId` to its provider object; `undoExecution` and the site route resolve through it instead of hard-coding `fixtureSiteExecutor`; a test asserts every registry key resolves. No behaviour change for the fixtures.
- [x] **P3-20b** Execution connections (rule 13): `connections` gains `purpose` (`measure` | `execute`, default `measure`) and the partial-unique index becomes `(account_id, provider, purpose)`. A new `connectForExecution()` in `lib/execution/connections.ts` accepts a credential only when its granted scopes equal the provider's `EXECUTION_SCOPE_REGISTRY` write scopes plus that provider's declared read-only readback scopes — one scope more or fewer is refused by name. Two invariants become tests _and_ a Postgres trigger mirroring `isWriteCapable`: a `measure` row can never hold a write-capable scope, and an `execute` row is never returned by `activeConnection()` or walked by the sync runner. Secrets take the same AES-256-GCM path under `CONNECTOR_KEY`. (A separate table was considered; one table with a purpose column keeps `metric_observations.connection_id` valid for D4's readback rows.) Migration 0030.
- [x] **P3-20c** Media storage: Vercel Blob — already the stack's "object storage for uploads", free on Hobby within 1 GB stored and 10 GB transferred a month — behind `lib/content/media.ts` with `putRendered()`, `publicUrl()` and `deleteRendered()`. Instagram fetches media from a **public URL at publish time** (docs-verified), so rendered items are uploaded at production under an unguessable path and deleted once the platform confirms the publish or the item is withdrawn. `content_items.media_path` finally gets written. Env `BLOB_READ_WRITE_TOKEN`; an in-memory store for tests.
- [x] **P3-20d** Publish state on `content_items`: `status` (`drafted` | `queued` | `publishing` | `published` | `failed` | `withdrawn`), `platform`, `platform_post_id`, `published_at`, `publish_proposal_id`, `publish_execution_id`, `last_error`. `withdrawn` is the undo and is distinct from `failed` in every query and screen. The queue read and `/content` render the new states. Migration 0031, additive.
- [x] **P3-20e** The due runner: `runDueExecutions()` in `lib/execution/due.ts` selects approved proposals whose `execute_not_before` has passed, resolves each provider (P3-20a), and executes through `executeProposal` — the seven guards untouched, the halt honoured per item, every attempt journaled. Exposed as `/api/cron/execute-due` behind `CRON_SECRET`; it also sweeps expiry (`expireDueProposals`, today lazy inside the queue read). ⏸ **Hosting decision, load-bearing:** Vercel Hobby crons run **once a day with ±59 minutes of slack**; Pro runs every minute (Vercel docs, 2026-07-15). A post that lands "some time in the 04:00 hour" is not a scheduler. Options on record: Vercel Pro (which also retires the v0.0.13 contributor-block workaround), or a GitHub Actions schedule every 30 minutes calling the endpoint with the secret as an interim. Owner's call before D2 starts.

**Done when:** an approved fixture proposal with a past `execute_not_before` executes on the next runner call and not before; a second call is a no-op; a halted account is skipped; an `execute` connection with one scope too many is refused by name and a `measure` row holding a write scope cannot exist; a rendered fixture clip lands in the fake store with a public URL and is deleted on withdraw. All tests, no network.

**Status 2026-10-12:** Done — every clause of the done-when is a passing test, five commits, no network anywhere. Provider resolution is a typed map (a registry entry without a provider fails the build) and `undoExecution` resolves from the row, refusing a mismatched caller. Execution connections live in `connections` under `purpose = execute` with the unique index widened; migration 0030 installs a BEFORE trigger mirroring `isWriteCapable` so a measure row can never hold a write-capable scope — proven on a 13-scope sample both directions, insert and update — and `connectForExecution()` demands exactly `write_scopes ∪ readback_scopes` (a new registry field, empty for both fixtures, audited as reads). The measurement side filters every read on purpose and the runner skips an execute row as `not_measurement`. Media is Vercel Blob behind one interface with an in-memory twin; renders land at `renders/<profile>/<item>/<16 random bytes>` and `media_path` is written for the first time; release deletes and clears. Publish state is six statuses with three checks (migration 0031) and renders on `/content`. The due runner sweeps expiry across all profiles, selects scheduled approvals with no execution row, runs pre-bound plans and site changes through the engine, and leaves anything else approved and named rather than guessed; it never re-runs a failed row. **Hosting placeholder, on record:** `/api/cron/execute-due` is scheduled daily at 05:00 UTC in `vercel.json` because Hobby allows nothing more frequent; until the owner's hosting decision, a scheduled post goes out some time after 05:00 on its day, not at its hour. Two things found on the way: Stripe's dashboard confirms the permission is simply called "Balance" (the connector's wording stands), and the Session C production test had pinned its clock and began failing by itself on 2026-10-06 — fixed in the P3-20d commit. 29 new tests; 745 across 79 files, typecheck, lint and format clean.

### D1 — The Meta write connection and its consent _(~1.5 wks)_ — P3-20

- [ ] **P3-20** First write connector, one platform (Meta is the likely first — its read side already exists): separate connection, separate consent screen naming exactly what may be written, write scopes from the P3-08 registry, secrets AES-encrypted like every other credential. **Platform confirmed 2026-09-30: Meta.**
- [x] **P3-20f** Registry entries, the pinned literal edited deliberately (the P3-08 friction). `meta_publish`: write scopes `pages_manage_posts`, `instagram_content_publish`, `instagram_manage_contents`; ops `publish_page_post`, `publish_page_photo`, `publish_page_video`, `publish_ig_media`, each reversible via deletion (P3-21c). `meta_ads`: write scope `ads_management`; ops `pause_campaign`, `resume_campaign`, `set_daily_budget` (reversible) and `create_campaign_paused` (**irreversible**: Meta's `DELETED` and `ARCHIVED` states are both permanent, docs-verified, so nothing created can be un-created). Readback scopes declared beside them as read-only: `pages_show_list`, `pages_read_engagement`, `read_insights`, `instagram_basic`, `instagram_manage_insights`. The three build gates (pinned literal, honest write naming, money fence) re-run; a fourth asserts no registered path under `act_*` names billing, funding or payment methods.
- [ ] **P3-20g** The connector, `lib/execution/providers/meta.ts`, mirroring `meta-ads.ts`: the credential is a token plus asset ids (`page_id`, `ig_user_id`, `ad_account_id`) — a Business Manager **system-user token**, or a long-lived token from the owner's **own Meta app** (pilot route 2) — either way verified against `/me/permissions` (Meta reports scopes, so `scopeVerification: "reported"`) and refused when anything outside P3-20f's lists is granted. The Page token is derived from the system user's assigned Pages (_verify at build_: current docs do not state the derivation; the fallback is a pasted Page token, verified the same way). Graph version pinned at `v26.0`, retries capped at 3, the read connector's error-code sets reused. Build gate: a source scan permits only the registered paths and methods, as `meta-ads.test.ts` does for GET.
- [ ] **P3-20h** The consent screen: `/connections` gains an **Execution** section, visually and textually distinct from Measurement, rendering the registry's `consent` lines verbatim ("SYB may publish posts to the Page you choose", "SYB may pause, resume or change the daily budget of campaigns", "SYB will never touch billing or payment methods"), a typed confirmation, and a decision-log entry — new `decision_kind` value `consent`, migration 0032, data-model spec updated in the same commit. Disconnect is one click; it revokes nothing on Meta's side, and the screen says so. For pilot route 2 the section carries step-by-step setup for the owner's own app — create it in their business portfolio, add the Pages, Instagram and Marketing API use cases, generate a token with exactly the listed permissions — rendered from data the way `SCOPE_GUIDE` renders the read side.
- [ ] **P3-20i** Access-level honesty. Every permission above needs Meta **App Review for Advanced Access** plus **Business Verification** before it works on assets SYB's own business does not own; **Tech Provider verification** before acting for other businesses' assets (34 permissions, including all of these, are withheld from business-claimed apps without it); and the Marketing API starts in **Limited Access** ("for development only", heavily rate-limited) until 500 successful calls in 15 days and a review. Until those exist, connections come only through the two pilot routes in the owner decisions above; Meta itself refuses anything else, and SYB says so rather than guessing on Meta's behalf. A single env flag `META_ACCESS_LEVEL` (`standard` | `advanced`) drives the screen's wording: at `standard` it offers the two pilot routes and states that open sign-up waits on SYB's company registration and Meta's approvals. No code pretends otherwise.
- [ ] **P3-20j** Facebook Login for pilot route 1, testers (added 2026-10-12): `/api/connections/meta/start` redirects to Meta's OAuth dialog requesting exactly the P3-20f scopes with a signed, single-use `state`; `/api/connections/meta/callback` exchanges the code server-side (`META_APP_ID`, `META_APP_SECRET`), swaps the short-lived user token for a long-lived one, lists the owner's Pages from `/me/accounts` and each Page's linked `instagram_business_account`, lets the owner pick, and hands the result to `connectForExecution()` — the same scope verification, encryption and consent entry as the pasted route. Adding a tester stays a manual step in Meta's App Roles screen, done by Samuel or Tedi. Not throwaway: once App Review and Tech Provider verification exist, this flow serves open sign-up unchanged and only `META_ACCESS_LEVEL` moves.

**Status 2026-10-14:** P3-20f done; P3-20g built, not yet ticked. **P3-20f:** `meta_publish` and `meta_ads` are in the registry and the pinned literal, ops and reversibility exactly as listed, consent lines carried as data (the "never billing or payment methods" sentence rides on `ads_management`'s line, because the consent test requires one line per write scope). **Owner decision, recorded:** `instagram_manage_insights` is a read Meta named with write vocabulary, so the honest-naming gate refused it as a readback scope. It is now the one entry in `VENDOR_MISNAMED_READS`, pinned in `scopes.test.ts` with its reason and exempt only as a readback scope; any other "manage" readback still fails, and the read side's audit still refuses it outright. `funding` joins the money-surface vocabulary, and the fourth gate (`auditMetaRequests`) refuses any registered `act_*` path naming billing, funding or payment methods. **P3-20g:** `lib/execution/providers/meta.ts` — Graph `v26.0`, retries capped at 3, the read connector's error-code sets exported and reused, only the four registered GETs (source scan gate). The verifier reads `/me/permissions`, refuses by name before touching any asset, then proves the Page (and that a Page token can be had), the Instagram account, or the ad account. One token holding both consents' scopes connects as neither, by design of the exact match: publishing and ads take two tokens. Every op refuses by name (`MetaOpNotBuiltError`, naming P3-21b or P3-22b) and `captureUndo` refuses rather than returning null, which the engine would read as irreversible. The pure scope check moved to `lib/execution/verify.ts` (re-exported from `connections.ts`) so the provider map stays importable without a database. **Still open in P3-20g:** the two database-backed connect tests in `meta.test.ts` could not run locally (Docker Desktop would not start on 2026-10-14) and passed in CI on `90bf9d1`; the Page-token derivation (reading the Page's `access_token` field with the system-user token) is _verify at build_ against a real Page.

**Done when:** a system-user token with exactly the registered scopes connects as an `execute` connection, its secret encrypted and never returned; a token with one scope too many or too few is refused by name; the consent is a decision-log row with a hash; a tester connects through Facebook Login and an own-app token connects by paste, both landing as identical `execute` connections; and the connection screen states the access level truthfully.

### D2 — The publish path _(~1.5 wks)_ — P3-21

Design decision, recorded: **the owner approves the finished item, not just the plan.** The calendar proposal (P3-15) was approved before a word was drafted; publishing the actual caption and clip is a second, separate proposal per item, so what goes out is what was seen. Rule 12 taken literally; bulk review (P3-05) keeps a week's posts to one screen.

- [ ] **P3-21** Scheduler and publish path: approved, scheduled items flow through the P3-10 engine — watching-check, emergency stop, idempotency, rollback and journaling all inherited, not reimplemented. A published item stores the platform's own id for readback; deleting/unpublishing is the stored undo where the platform allows it.
- [ ] **P3-21a** Publish proposals: `produceFromProposal` creates, for every drafted item whose channel is matched to a connected Meta asset, a proposal with `module: "content"`, `action.kind: "content_publishing"`, `action.detail: {item_id, platform, target}`, `execute_not_before` = the item's `scheduled_for` at a posting hour stored on the proposal (default 10:00 in the business's timezone), reversibility `easy` with the undo named ("SYB deletes the post; Meta keeps no copy"), and the item's provenance as evidence. Hard limits (13.5) and suppression (P3-28) apply as to every proposal. Items whose channel has no execute connection stay `drafted`, and the queue says why.
- [ ] **P3-21b** The executor's publish ops. Facebook: `POST /{page-id}/feed` (text, link), `/photos` with `url` = the Blob public URL, `/videos` or `/video_reels` via resumable upload (Reels: 9:16, 3–90 s, 1080×1920 — the cutting room's own output spec). Instagram: container `POST /{ig-user-id}/media` → poll `status_code` → `/media_publish`; `CAROUSEL` for multi-image, `REELS` for video; JPEG only for images. **`is_ai_generated: true` on every Instagram container** (docs-verified v25.0 — the only self-disclosure field Meta's API has); Facebook has no such field, so the P3-19 disclosure line is appended to every caption and the rendered clip's container metadata is left intact (_verify at build_: whether Meta honours C2PA/IPTC on API uploads is undocumented). A build gate scans the executor: no publish call without `is_ai_generated` or the caption disclosure. **No native Facebook scheduling** (`scheduled_publish_time`): a post Meta is holding would go out after an emergency stop, so every item is published by our runner at its due time — which is why the D0 hosting decision is what makes this a scheduler.
- [ ] **P3-21c** Undo (rule 16): `captureUndo` stores `{platform, target ids}` before attempt one. Undo is `DELETE /{post-id}` on Facebook (_verify at build_ against a test Page: the Pages guide documents it, the Post reference says "select developers only"; if it fails live, the op is re-labelled irreversible in the registry **before** any customer approves one) and `DELETE /{ig-media-id}` on Instagram (docs-verified v25.0; needs `instagram_manage_contents`; whole carousels, not children). Undo marks the item `withdrawn`, keeps the platform id forever, and is offered on `/content` beside every published item.
- [ ] **P3-21d** At-most-once, stated honestly. Meta has no client idempotency key for posts. The engine guarantees one execution row; inside it, the item is marked `publishing` before the call, and an execution that dies between Meta's success and our record leaves the item `publishing` with the attempt journaled. The runner never retries a `publishing` item; the owner sees "I may have posted this — check the Page" and resolves it by hand. Duplicate posts are structurally impossible; a lost confirmation is visible, never silent. Rate limits: Instagram allows **100 API-published posts per 24 h per account** (`/content_publishing_limit` checked before every publish); Page business-use-case usage headers are logged and backed off at 75%.
- [ ] **P3-21e** `/content` becomes the publishing queue: status per item, the platform link once published, "Withdraw" routed through `undoExecution`, the "publishes nowhere yet" copy retired, and the watch log gains "Published 'Autumn menu' to Instagram." The emergency stop is already on the screen (P3-12).

**Done when:** an approved publish proposal for a fixture-rendered clip publishes exactly once through the fake provider in tests and through the real one on a SYB-owned test Page and Instagram account, `platform_post_id` stored, the disclosure visible on-platform (screenshot in the status note), a second runner call a no-op, a halted account publishing nothing, and one published item withdrawn from its stored undo and staying withdrawn.

### D3 — Campaigns and ad management _(~1.5 wks)_ — P3-22

- [ ] **P3-22** Campaigns and ad account management — Meta first; Google Ads still ⏸ **blocked on the same Google approvals as P2-20**; TikTok **deferred 2026-09-30**. Budget changes and campaign starts are proposals with scenarios; every spend action reversible or labelled irreversible before approval.
- [ ] **P3-22a** Ad proposals from measured facts only. Generation gains two deterministic sources over the P2-19/P2-21 observations: "pause campaign X — return on ad spend below 1.0 for 14 measured days" (`paid_ads_decrease_or_pause`) and "raise X's daily budget by 20% — ROAS 3.2 over 28 days, headroom under your stated ceiling" (`paid_ads_start_or_increase`, blocked outright by a `no_paid_ads` hard limit as today). Scenario arithmetic is spend × ROAS in minor units with the currency carried (rule 1). Meta budgets are sent in the ad account currency's minor unit with **offset 1 for HUF, JPY, KRW and eleven others** (docs-verified), so the currency-offset table lives in code with a test per offset class. No ad proposal without at least 14 measured days behind it.
- [ ] **P3-22b** Executor ops: `pause_campaign` / `resume_campaign` (`status=PAUSED|ACTIVE`, undo = the previous status), `set_daily_budget` (undo = the previous `daily_budget`, captured first), `create_campaign_paused` (created with `status=PAUSED`, `objective`, `special_ad_categories`, `buying_type=AUCTION`; going live is a **separate** resume proposal). Every mutating call is preceded by the same call with `execution_options=["validate_only"]` (docs-verified) and refused on any validation error before anything changes. `DELETE` and `ARCHIVED` are never issued — both are permanent on Meta — so "delete campaign" is not an op.
- [ ] **P3-22c** Spend guardrails in code, checked at generation and again inside the executor: a budget change bounded to ±50% per approval and to the owner's stated monthly ad ceiling (goals, 13.1) when one exists; an absolute floor at Meta's minimum daily budget for the objective; refusal wording names the number it hit. Rule 18 re-proven: a test asserts no registered op or path matches billing, funding, payment methods or payment cycles.
- [ ] **P3-22d** Access-tier honesty: Limited Access allows `300 + 40 × active ads` calls per hour per ad account — enough for one business, not a customer base. The connection screen and the runner log the `ads_api_access_tier` header, and the owner-side checklist carries the Full Access application.

**Done when:** a pause proposal generated from 14 seeded loss-making days executes against the fake Marketing API and undoes to ACTIVE; a budget change runs `validate_only` first, stores the prior budget, and undoes to it; a HUF account's budget is sent as whole forints; a change beyond ±50% or over the ceiling is refused at generation with the limit named; and one real pause runs on a SYB-owned test ad account.

### D4 — Readback per post and per campaign _(~0.5 wk)_ — P3-23

- [ ] **P3-23** Performance tracking per post and per campaign, flowing into the Phase 2 observation tables so anomaly detection and the watch see marketing activity like any other metric.
- [ ] **P3-23a** Insights into `metric_observations` through the execute connection's read-only scopes, pulled by the existing daily connector-sync cron (a read, so the same runner). Per post: `content.views.daily`, `content.reach.daily`, `content.interactions.daily` with dimensions `{platform, platform_post_id}`. Per campaign: `ad_spend.daily` and `ad_purchases.daily` with `{campaign_id}`, beside the business-wide rows P2-19 already emits. Views-based metrics only — Meta retired `post_impressions_unique` and the other `*_unique` Page metrics on 2026-06-15, and Instagram `impressions` for media created after 2024-07-02 (docs-verified). Data lags up to 48 h, so the last three days are re-read. Sliced rows stay out of business-wide sums by the existing dimension filter (the v0.0.12 fix).
- [ ] **P3-23b** `readbackForProposal` chooses its series by kind: a published item is judged on its own reach and interactions against the median of the account's previous ten posts on that platform (pinned thresholds, boundary tests both ways, `too_early` under 3 measured days); an ad change on that campaign's ROAS before and after; everything else on `revenue.daily` as today. The scorecard needs no change — helped / did nothing / backfired are the same verdicts.
- [ ] **P3-23c** Shot lists (P3-17) and calendar proposals cite the per-post outcomes as evidence ("your three Reels out-performed your photo posts 4:1"), closing the loop the source line promised.

**Done when:** a seeded published item with insights rows receives a per-post verdict with the arithmetic shown; a campaign pause is judged on its own ROAS series; and a shot-list proposal cites a measured per-post outcome.

### D5 — Failure honesty and operations _(~0.5 wk)_ — P3-24

- [ ] **P3-24** Failure honesty: expired credentials, platform rejections and rate limits surface in the owner's language ("I couldn't post — the connection expired. Reconnect and I'll pick up where I left off"), degrade to paused, never fail silently.
- [ ] **P3-24a** Error taxonomy: the read connector's code sets (auth 102/190; permission 10/200/294; rate limit 4/17/32/613) plus 80001 (business-use-case limit, docs-verified) mapped once to an owner sentence, a connection state and a next step; codes met at build time are added with the test that met them. Unknown codes get the honest default ("Meta refused with code N; nothing was published"). Every mapping is a test.
- [ ] **P3-24b** Degrade to paused: an execute connection that fails authentication pauses itself, every queued item on it flips to `failed` with the same sentence, nothing retries until reconnect, and reconnecting resumes from the journal. Surfaces: `/connections`, `/content`, the watch log, the needs-you badge.
- [ ] **P3-24c** The stop covers everything: a test proves a halt between "due" and "publish" publishes nothing, a halt mid-carousel leaves no container published, and resuming re-evaluates every guard.
- [ ] **P3-24d** Telemetry: rate-limit usage headers on every attempt row, Blob storage in the ops panel's cost view, and one structured line per publish with account id, platform, item, attempt and outcome.

**Done when:** an expired token pauses the connection and explains itself on three screens; a rate-limited publish backs off and reports; a halt mid-run publishes nothing; and nothing in the session can fail without a sentence the owner can read.

### Owner-side checklist, non-code — start in parallel with D0

1. ~~A Meta **business portfolio** with SYB's app connected to it; a **system user** with the test Page, its Instagram professional account and the test ad account assigned; a token generated with exactly the P3-20f scopes.~~ **Done 2026-10-13 (Samuel):** portfolio "SYB"; Page "SYB Test" (id 1405205332673295) with the Instagram professional account @kov.emma124 linked; app "SYB" in development mode with the Page, Instagram and Marketing API use cases (Facebook Login for Business came with them); sandbox ad account "SYB Sandbox" (`act_1831651904851664`, EUR); admin system user `syb-publisher` with the app, Page and Instagram assigned, and a non-expiring token carrying exactly the nine P3-20f scopes. App ID, App Secret and the token are held by Samuel outside the repo and go into Vercel and the connections screen at D1. The unverified portfolio allowed the system user — the P3-20g fallback was not needed.
2. Pilot owners added as **Testers** in SYB's Meta app (App Roles), each accepting the invite from their own Facebook account — pilot route 1.
3. ⏸ **Blocked on company registration** (SYB is not registered yet, 2026-10-12; registration follows the build): **Business Verification**, then **App Review** for `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_contents`, `instagram_manage_insights` and `ads_management`. Meta quotes about a week per decision; secondary sources report 2–20 days. Needs a 1080p screencast, reviewer steps, test credentials and the privacy-policy URL.
4. **Tech Provider verification** before publishing for other businesses' assets — also behind registration.
5. Marketing API **Full Access** once 500 successful calls in 15 days exist with under 15% errors.
6. The **hosting decision** for the due runner (P3-20e).
7. A **Vercel Blob** store and `BLOB_READ_WRITE_TOKEN` in production.
8. `META_APP_ID` and `META_APP_SECRET` in production for P3-20j.

### Verify at build — Meta's own docs disagree or are silent (2026-09-30)

Facebook post `DELETE` availability; Page video deletion; the Facebook scheduling window (10 minutes to 30 or 75 days or 6 months depending on the page read — moot while P3-21b's no-native-scheduling holds); Page-token derivation from a system user; whether C2PA/IPTC metadata survives Facebook API uploads and triggers the "AI info" label; Business Verification turnaround. Added 2026-10-12 with the pilot routes: how many testers one app may hold; ~~whether Meta withholds system users from an unverified portfolio~~ (answered 2026-10-13: it does not — the SYB portfolio created an admin system user and issued the token unverified); and whether Meta's Platform Terms let an owner hand their own app's token to a service provider such as SYB (Phase 2's Meta ads connection already rests on the same answer).

### Cost discipline, Session D shape

Meta's APIs are free; the money is the owner's ad spend, fenced by P3-22c. Blob is free within Hobby limits, then cents. **No model call anywhere in the publish or ads path** — captions were drafted in Session C and scenarios are arithmetic. Every retry is capped at 3 by the engine.

**Done when (unchanged from the first draft):** one real item, approved by a real owner, publishes to one real platform exactly once with its disclosure label visible on-platform; one real campaign change executes with its scenario on record; and one published item is cleanly undone from its stored rollback payload.

---

## Session E — The trust layer _(~4 wks)_

Steps 75–77 plus the owner's scope. The loop closes: predictions meet measurements, and the agent gets a public report card.

- [x] **P3-25** Performance readback: every approved action tied to its goal and measured through the Phase 2 observation tables; the proposal's actual outcome renders against its predicted scenario, assumption by assumption.
- [x] **P3-26** The agent scorecard: suggestions made, approved, **helped, did nothing, backfired** — judged by deterministic rules against measured outcomes, with the arithmetic shown. This is the Glass Business scoring itself in public; the numbers render whatever they say.
- [x] **P3-27** Suggestion history and outcome detail screens: every proposal ever made, its decision, its execution, its outcome — the decision log made legible.
- [x] **P3-28** Learning from declines (step 76): rejection reasons feed proposal generation — an owner who rejected three video proposals stops receiving video proposals. Deterministic suppression rules first; no model-inferred taste.
- [x] **P3-29** Mobile approval (step 77): a proposal reviewed and decided in under 30 seconds on a phone — measured, not assumed, with the P0-71 stopwatch discipline.

**Done when:** the scorecard renders honest numbers from real executions; a published item's measured outcome appears against its prediction; and a thrice-rejected proposal kind provably stops being generated.

**Status 2026-09-22:** Built and browser-verified, with one clause honestly narrowed. The readback judges every EXECUTED proposal against the measured revenue series — after-window mean vs the 28 days before, thresholds pinned at ±5% with boundary tests in both directions, and two honest non-verdicts (too_early under 7 measured days, unmeasured without a connected source, each explaining itself). The scorecard shows suggested / approved / declined / helped / did-nothing / backfired with the approval-rate arithmetic spelled out, restraint counted separately and excluded from the rate. /history renders every proposal ever with decision, reason, prediction and outcome arithmetic. The third decline of a kind provably silences it in generation, reason stated; owner-initiated /content requests deliberately bypass suppression — answering a direct ask is not nagging. Per-PUBLISHED-item outcomes await Session D's publish path (P3-23); proposal-level readback stands in until then and shares the same tables. P3-29: a full proposal card fits a 375×812 screen with both buttons reachable (header collision found and fixed at that size); the sub-30-second stopwatch run itself stays human-timed, the P0-71 discipline. 8 tests in lib/trust.

---

## Session F — Website changes, Tier 3 _(~5 wks)_

Site-audit 74a–c plus the owner's scope. The highest-trust write surface, so it carries the strictest rules in the phase.

- [x] **P3-30** Platform detection and scoped credentials: theme/content write access only — never admin, and never anything rule 18 covers. Platforms that cannot take programmatic changes are detected and honestly labelled, never promised.
- [x] **P3-31** Preview-first, always: changes applied to a preview copy, never straight to live. Rendered before/after screenshots from the real page, mobile and desktop, on the visual approval card.
- [x] **P3-32** One-click undo, permanent: the pre-change state stored indefinitely via P3-11; undo works months later, not just inside a window.
- [x] **P3-33** Auto-rollback **only on hard failures** — errors, load regressions — never on conversion noise. The thresholds are code with tests at the boundaries, the Session E (Phase 2) discipline applied to rollback.
- [x] **P3-34** Checkout and payments untouchable (rule 18): the exclusion enforced in the change generator and the credential scopes both, with a test that a checkout-touching change cannot even be proposed.
- [x] **P3-35** The manual path for Wix and Squarespace: rendered before/after plus step-by-step instructions for the owner's own editor — a useful answer for the third of customers whose platform can't be edited programmatically.

**Done when:** a real site change previews with honest before/after renders, applies on approval, undoes with one click, and a deliberately seeded hard failure auto-rolls-back while a conversion dip does not.

**Status 2026-09-22:** Done, with the write half held at the designed gate. Platform detection names shopify/woocommerce/wordpress/webflow/wix/squarespace/custom from page markers with evidence; the fetcher is GET-only behind a resolved-IP SSRF guard. Rule 18 stands as two walls at the GENERATOR: money-path URLs refused before any fetch (proven with a fetcher that throws if called), and targets within 400 chars of checkout/payment markers unproposable. The approval card renders the REAL page before and after — live in the owner's own browser at desktop and phone widths, scripts off — an amendment from static screenshots to something strictly fresher; verified against live example.com. Apply goes through the Session B engine (fixture-site provider; the pinned registry literal extended deliberately), refuses stale diffs by refetching first, health-checks after (thresholds boundary-tested both directions), and a seeded 500 auto-rolls-back as the SYSTEM (undone_by null) while conversion noise is structurally unexpressible — no such input exists and a test scans the exports. Undo restores byte for byte, permanently. Wix/Squarespace get rendered before/afters plus deterministic editor steps, and their apply refuses honestly. REAL platform writes (Shopify theme etc.) refuse with the Session D gate named — claiming success anywhere else would be a progress bar over a lie. Two live findings fixed in the walk: dual-stack fetches died on this v6-less box until happy-eyeballs was enabled explicitly, and the preview frames now scale to their column. 11 tests in lib/site.

---

## Session G — Conversation: the request tier _(~1 wk)_

Conversation-channel step 70a.

- [x] **P3-36** "Post something about the new product" becomes a **proposal in the queue, not an action** — the chat gains a request tier that generates through P3-04, gated by hard limits and watching mode like every other source. The conversation never executes anything directly.

**Done when:** a chat request produces a queued proposal with evidence and scenario, and a request violating a hard limit lands in the restraint view with a plain-language explanation in the chat.

**Status 2026-09-22:** Done — and the prerequisite it exposed (the conversation channel itself, step 46a, never built in Phase 1) shipped with it. /chat is the read tier plus the request tier, to the spec's letter: Haiku classifies intent first (§6), asks get Sonnet answers grounded ONLY in the profile and report with honest gaps named, requests become proposals (module "conversation", originating_finding naming the exact utterance) that bypass nothing, watching mode refuses requests outright with the review date, a limit stated in chat appends to goals.owner_boundaries as a conversation-sourced fact naming its utterance at 0.70 confidence (§2.3) — and cannot be removed in chat (§5) — and tell/correct record NOTHING silently, replying that the write tier (step 60a) is not built yet. Verified live with real models: a grounded answer citing only profile facts, then "run a 20% off flash sale" born blocked against the owner's own "We never discount" with the restraint explained in chat — the done-when verbatim on screen. Per-turn cost lands on each utterance row (the live demo: ~€0.003). Every guardrail is also a test: 8 in lib/chat.

---

## Session H — Ledgerline markets itself _(~0.5 wk build, then a 3–4 week run)_

Owner idea, recorded 2026-10-13: Ledgerline runs SYB's own marketing through the product for a few weeks, then publishes that it did, with the scorecard as the proof. The Glass Business turned on ourselves. If the marketing was good, the campaign is the pitch; if it was mediocre, publishing that anyway is the pitch.

**Where it sits, and why.** After Session D: nothing publishes before D2, and "it was good" means nothing without D4's per-post readback. Ad spend needs D3. It does **not** wait on company registration: Meta's Standard Access covers an app acting on its own business's assets without App Review, and SYB's own Page, Instagram account and ad account already exist (owner-side checklist item 1). SYB can be the "real business" in Session D's done-when.

**Constraints, decided now so the run can't drift from them:**

- **No secret reveal.** Rule 17 and P3-21b label every post as AI-assisted on the platform (`is_ai_generated` on Instagram, the disclosure line on Facebook). The story is "every post was proposed by Ledgerline and approved by a person, and here are the numbers", never "surprise, it was AI".
- **Rule 12 unchanged.** Samuel or Tedi approves each item in the queue like any owner. The approvals are part of the story, not a shortcut around it.
- **Results published whatever they say.** The write-up quotes the scorecard (helped / did nothing / backfired) as rendered, with the arithmetic. Choosing to publish only after seeing good numbers turns it into an ad and is out of scope.
- **A week is too short.** Per-post verdicts are `too_early` under 3 measured days, and the comparison needs a baseline, so the run is 3–4 weeks. A new Page has no audience, so either a small ad budget through D3 (inside P3-22c's guardrails) or a baseline stated up front, never raw reach presented as success.

- [ ] **P3-40a** SYB through its own funnel — **can start today, no code**: the team runs the intake as SYB's owner, accepts the profile, generates the report, and opts into ongoing watching. The report's findings are the campaign's starting point and the "before" on record. The profile is kept as the canonical SYB account. **Start it now for a second reason:** rule 15 gives every live business 4–8 weeks of watching mode before anything executes, and SYB's own account is no exception. Started today, that period runs out while D1–D4 are built instead of after.
- [x] **P3-40b** Internal-account flag: an `internal` marker on accounts, set for SYB's own, that excludes it from Gate 2's cross-customer approval rate (P3-37), the ops funnel and cost-per-customer views, while its own scorecard keeps working. Own numbers must never pass as customer evidence. Migration, additive; a test that an internal account's decisions are absent from the cross-customer rate.
- [ ] **P3-40c** Connect SYB's own Page, Instagram and ad account as an `execute` connection through P3-20g (system-user token), and set the baseline: the counts and reach at day 0, recorded as observations so the readback has something to compare against.
- [ ] **P3-40d** The run: 3–4 weeks of calendar proposals, drafts and publishes through the normal queue, plus ad changes if a budget is set. Nothing bypasses suppression, hard limits or the emergency stop. Every decision lands in the decision log as usual.
- [ ] **P3-40e** The reveal: a public write-up (and a post from the same account) built from `/history` and the scorecard: what was proposed, what was approved or declined and why, what helped, what did nothing, what backfired. Numbers quoted as rendered. It doubles as the launch content when open sign-up arrives after registration.

**Done when:** SYB's own account has run end to end (intake → report → proposals → approved publishes → measured verdicts) for at least three weeks; its decisions are provably excluded from Gate 2's customer metrics; and the write-up is published with the scorecard as rendered on the day of writing.

**Status 2026-10-13:** P3-40b built.

- `accounts.internal` (migration 0035) is excluded from the ops funnel, abandonment and cost views and from the new `crossCustomerApprovalRate()` in `lib/trust/gate.ts`. That function is the query P3-37 will read; `/api/ops` now returns it as `gate2`. Its arithmetic is the scorecard's own, extracted to one shared `approvalRate()`.
- The account's own scorecard is unaffected.
- `scripts/mark-internal.ts <account_id>` sets the flag. It hasn't been run against production: SYB's own account doesn't exist until P3-40a.
- 3 tests in `lib/care/care.test.ts`.

P3-40a is still the team's to do, and starting it starts the watching-mode clock.

---

## Session I — Trading-hours trials _(planned 2026-10-13, owner idea)_

The second half of `TASKS-PHASE2.md` Session F (P2-26..31). Data can only suggest demand in an hour the business was closed, so a suggested change to opening hours becomes a **time-boxed trial with a measured verdict**, not a recommendation taken on faith. It touches no external platform: the owner changes their own hours, so it does **not** wait on Session D.

- [x] **P3-41** Hours-trial proposals, from P2-30's signals only. Examples: "Open at 19:00 on Fridays for 4 weeks" and "Close at midnight on Tuesdays for 4 weeks".
  - **Scenarios** are arithmetic, pessimistic / expected / optimistic: the extra or saved hour's revenue, estimated from the measured first-hour or last-hour curve, minus or plus the cost of an open hour (P2-26). Money is in minor units and the arithmetic is shown.
  - **Reversibility** is `easy`. The owner makes the change themselves: the proposal says plainly that SYB will not edit their Google listing or website (a write, so out of scope until a write connector covers it).
  - **Rules:** hard limits, suppression (P3-28) and watching mode (rule 15) apply as to every proposal. One trial per weekday at a time, so the verdicts don't mix.
  - **Readback** (P3-25) judges the trial window on that weekday's measured revenue net of the hour's cost, against the same weekday before. The verdicts are helped / did nothing / backfired, plus `too_early` under 3 measured trial days.
  - The P2-26 schedule is updated as an owner-stated fact when the trial starts, and superseded back when it ends (rule 3).

**Done when:** a seeded Friday opening signal produces a trial proposal with three scenarios and the arithmetic shown; approving it records the owner-stated schedule change; four seeded trial Fridays get a verdict net of the hour's cost; and the same proposal is refused during watching mode with the reason stated.

**Status 2026-10-13:** built except one clause; 8 tests in `lib/hours/trials.test.ts`.

- **Proposals** (`lib/hours/trials.ts`). P2-30's signals become `hours`-module `operations_change` proposals. Each has three scenarios in minor units with the formula shown:
  - open earlier: 25/50/100% of today's first-hour takings, minus the open-hour cost;
  - close earlier: the cost saved, minus 100/50/0% of the last hour lost.

  Without the cost, an opening trial shows takings and says plainly "not profit", and a closing trial isn't proposed at all.

- **Guards:** idempotent per weekday, change and month; one trial per weekday at a time; nothing before care starts or while watching (rule 15); hard limits and decline-suppression as usual. The card says SYB won't touch the Google listing or website.
- **The verdict** (`judgeHoursTrial`). The weekday's takings during the four weeks after approval, net of the hour's cost, against the four weeks before, using the readback's ±5% thresholds; `too_early` under 3 trial days.
- **Where it runs:** proposals come from the weekly-watch cron. Trials and verdicts show on `/hours`.
- **Recorded while running (added the same day):** `presence.hours_trials` holds the trials running today (`syncRunningTrials`, on the weekly job and `/hours`), and goes back to empty when they end.
  - Amended from "the schedule is updated and superseded back": the opening schedule stays the owner's own words, and the trial is a separate inferred fact derived from the approval, so a trial can never overwrite what the owner said.
  - Its days are left out of that weekday's signals, so a trial can't feed itself.
- **In the scorecard (added the same day):** `buildTrustView` judges approved `hours` trials through `trialOutcome`, beside executed proposals. A trial stays `approved`, because the owner changes the hours themselves.

---

## Session J — Alert mode: when the business isn't improving _(planned 2026-10-13, owner idea)_

When a business has been under Ledgerline's care for a decent time and isn't moving towards what the owner wants, or is moving far slower than the gap demands, the system escalates. A high-alert review goes through everything: where the business stood on day zero, everything proposed, approved, declined, executed and undone since, and what each did. It names the most likely reasons, with evidence, and proposes a recovery plan. Gate 2 asks "does it work?" across all customers; this asks it for one business, every week.

**Principles, decided now:**

- **The trigger is arithmetic, never a model** (CLAUDE.md cost rule). The review is the only model call.
- **The review may blame us.** "Our recommendations were wrong" and "the goal was unrealistic" are causes it must weigh, beside "the owner declined the key proposals", "the data is incomplete" and "something outside changed". The Glass Business includes our own failures.
- **"Solve it" means proposals.** The recovery plan goes into the queue like everything else (rule 12). Alert mode never executes and never relaxes a hard limit, suppression or watching mode.
- **No endless AI loop.** If the recovery plan doesn't move things either, a person at SYB looks next (P3-47).

**What exists today, found 2026-10-13:** goals (P3-14, `lib/content/goals.ts`) are a statement, a horizon code and a free-text `target_value`, linked to no measured series, so the gap between wanted and current can't be computed. The readback (P3-25) judges each action alone; nothing judges the whole trajectory. The decision log, supersession (rule 3) and the scorecard already hold the history the review needs.

- [x] **P3-42** Measurable goals. A goal may name a metric (a `METRIC_KEYS` series or a derived profile field), a target (money in minor units plus currency, rule 1) and a deadline (from its horizon). The **baseline** is captured automatically at the moment it's set. The free-text statement stays. A goal without a metric is labelled "not measurable, so alert mode can't watch it" rather than guessed at. Data-model spec updated in the same commit.
- [x] **P3-43** Day zero. Entering ongoing mode records a takeover entry in the decision log: the date, the profile hash and the goals. Supersession then reconstructs the profile exactly as it stood that day, which is the "before" every later judgement compares against.
- [x] **P3-44** Progress check and alert levels, inside the existing weekly watch job. Per measurable goal it compares actual progress with the straight-line path from baseline to target. The levels:
  - **On track.**
  - **Lagging:** shown on `/watch`, no review.
  - **Alert:** progress far below the path for several consecutive weekly checks, or moving away from the target.

  The alert threshold scales with the gap: a goal asking for +50% tolerates less drift than one asking for +5%. Nothing triggers before a minimum time under care has passed after watching mode ends. Honest non-states: `too_early` and `unmeasured`, each explaining itself. All thresholds are pinned in code with boundary tests both ways. An alert appears on `/progress` (amended at build: the rail badge counts approvals and nothing else, P3-05, and `/watch` only renders while a watch is running — alerts happen after it ends).

- [x] **P3-45** The case file, built deterministically with no model:
  - day zero against now, per metric;
  - every proposal with its decision and decline reason, execution, undo and readback verdict;
  - report findings that never became a proposal;
  - approved items that never executed;
  - execution failures, anomalies and the watch log;
  - stated-vs-measured contradictions;
  - which sources are connected and which aren't.

  Every line gets an evidence id.

- [x] **P3-46** The alert review: Opus, the diagnosis-report workload under CLAUDE.md's routing, reads the case file.
  - **Output:** the likely causes, ranked, each citing evidence ids. A cause without evidence is not stated. It weighs every category in the principles above.
  - **Recovery plan:** proposals into the queue, which can include stopping a strategy that did nothing (through suppression, P3-28) or revising the goal. The owner decides; the system never lowers a goal on its own.
  - **Cost:** a cost cap per review and at most one review per business per pinned interval, both in code. ~~The prompt is cached.~~ Amended at build: one call per review with a short system prompt and a different case file each time leaves no repeated prefix for caching to reuse.
  - **Owner screen:** a plain-English write-up of what we tried, what happened, what we think went wrong and what we suggest now.
- [x] **P3-47** Escalation to a person. If the goal is still in alert after the recovery plan's window, the case is flagged on `/ops` for the SYB team with the case file and the review attached. The owner is told plainly that a person is now looking. No second automatic review.

**Done when:**

- A seeded business, three months into a +20%-revenue-in-six-months goal, sitting at +2% with mostly did-nothing verdicts, reaches alert, gets a case file with every action and verdict, and receives a review whose causes all cite evidence.
- The recovery proposals land in the queue and nothing executes.
- A lagging business gets no review, and an unmeasurable goal says it can't be watched.
- A business still in alert after the recovery window is flagged on `/ops` instead of being reviewed again.

**Status 2026-10-13:** P3-42 to P3-44 built. No model call anywhere; 16 tests in `lib/care/care.test.ts`.

- **P3-42, measurable goals** (`lib/care/goal-measure.ts`). A goal names revenue, orders or website visits, a target per 30 days (minor units plus currency for money) and a deadline, given or derived from its horizon.
  - The baseline is measured: the 28 days before the goal is set, needing 21 measured days. It's stored as an inferred fact naming its series (`connector:stripe:revenue.daily`) and its formula (rule 6). A connector's backfill fills a missing baseline later.
  - Refused by name: an unknown metric, money without a currency, a fractional target, no deadline or horizon, and a target already reached.
  - Set through `PUT /api/goals` with `measure`; read back on `GET`. **No screen yet:** `/content`'s goals panel doesn't offer it.
- **P3-43, day zero** (`lib/care/day-zero.ts`). The first mode decision takes a `day_zero` snapshot and writes a `takeover` log entry (migration 0035). Its hash covers the snapshot's content hash and the goal ids, and the test recomputes it. It's written once, and a second call returns the first. Profiles already in care fall back to their first mode decision, marked `recorded: false`. The hook in `decideForProfile` itself is not covered by a test: reaching a non-deferred decision needs a half-complete profile.
- **P3-44, progress and alerts** (`lib/care/progress.ts`). This runs on the weekly-watch cron. A straight path from baseline to target.
  - Thresholds: on track from 70% of the expected progress; off track below 40%, or when falling below the baseline. Shortfalls under 5% of the baseline are noise, and that noise floor is how the alert scales with the gap.
  - Alert after 3 consecutive off-track weeks, raised once, with an on-track week resetting the count. At most one check per goal per 6 days.
  - Nothing before 8 weeks under care, inside watching mode, or inside the goal's first 28 days. `too_early` and `unmeasured` explain themselves.
  - Every boundary is tested both ways, including a decrease goal.
  - Amended at build: an alert shows on `/progress`, not the rail badge (P3-05 reserves it for approvals) and not `/watch` (which renders only during a watch).
- `lib/trust/series.ts` is the readback's series reader made shared, generalised from revenue to any metric. The readback's own tests are unchanged and pass.

**Status 2026-10-13 (later):** P3-45 to P3-47 built. Session J's done-when is met in tests, with a fake model; 10 tests in `lib/care/review.test.ts`.

- **P3-45, the case file** (`lib/care/case-file.ts`). Built by code from:
  - the goal, its baseline, day zero and the profile diff since;
  - every series before day zero and now;
  - every proposal with its decision, decline reason, limit, execution and readback;
  - report recommendations and findings nobody acted on;
  - approved-never-executed items, failed and undone executions, and anomalies since day zero;
  - stated-vs-measured pairs, open validation findings, sources, and this goal's weekly verdicts.

  Every line has an evidence id. It freezes the profile it read, and the same state gives the same hash.

- **P3-46, the review** (`lib/care/review.ts`). One Opus call, on `DIAGNOSIS_MODEL` with workload `alert_review`, when an alert is raised. Code then decides what survives:
  - a cause with no evidence, or citing an id the file doesn't hold, is rejected and kept visible;
  - every one of the 8 cause categories must be named or set aside with a reason, including `our_advice_was_wrong` and `goal_unrealistic`, or the gap is recorded.

  Suggestions with an action kind become `alert_review` proposals: pending, through hard limits and decline suppression, and nothing executes. `revise_goal` and `stop_strategy` stay the owner's to decide: no proposal kind executes them, and adding one is a registry decision.

  Caps, in code: one review per goal per 56 days, and €3 per account per month, after which the case goes straight to a person.

  **Prompt uncalibrated:** calibrate it on the first real alert, as the diagnosis prompt was.

- **P3-47, escalation.** The case goes to a person when:
  - the goal is still in alert 42 days after the review;
  - the review is unusable (no evidenced cause); or
  - the budget is spent.

  The owner sees "a person at Ledgerline is now looking" on `/progress` (and as a watch-activity entry). `/api/ops` lists open `escalations`. No automatic review runs while a person holds the case. `scripts/resolve-escalation.ts` closes it.

- Stored in `alert_reviews` (migration 0036). `GET /api/care` gives the owner, per goal: measure, baseline, latest verdict, latest review and whether a person has it.

**Screen, same day:** `/progress` (`components/care/ProgressScreen.tsx`, linked from `/watch` in both states).

- It shows, per goal: the measure and baseline, or a form to make the goal measurable; the latest verdict with its arithmetic; and the latest review, with causes in plain words and evidence counts, suggestions linked to the queue or marked "yours to decide", and a notice when a person has the case.
- Verified against the dev server with a seeded stalled business: off track, alert, review stored, one suggestion queued as a pending proposal, `revise_goal` left to the owner, and the unmeasurable goal offered the form.
- **Not checked in a browser:** the page is client-rendered, and no browser tool was available. The API it reads was verified.

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
