# Changelog v0.0.17 — Ledgerline (SYB)

Opened 2026-10-12 and still in progress: Session D's build starts here.
Convention per v0.0.12 — new file, released files stay history.

---

## Orientation delta (what changed since v0.0.16)

- **Work split agreed (2026-10-12):** Samuel builds Phase 3 Session D and
  then the rest of Phase 4; Tedi takes Phase 5. When both of us add
  migrations in the same week, whoever pushes second fetches first and
  renumbers, because Drizzle numbers them in sequence.
- **SYB is not a registered company yet.** Registration follows the
  build. Everything that needs a legal entity waits for it: Meta
  Business Verification and the approvals behind it, and Stripe live
  mode. Nothing that is buildable waits.
- **Session D layer D0 is built, and Phase 4 Sessions B, D and E** (all
  below). Five new migrations, 0030–0034, all additive — production must
  apply them before this branch deploys. One new dependency:
  `@vercel/blob`. Two new crons in `vercel.json`: `execute-due` and
  `faq-cluster`. Three new screens: `/support`, `/support/test`,
  `/customers`.
- **Phase 4's buildable half is done.** Sessions A, B, D and E are
  built; C (email support) and F (outbound) need an email provider key
  with inbound, and F also needs Session D's publish path.
- **Local: 780 tests across 84 files**, typecheck, lint, format and
  build clean. Not pushed yet — Samuel pushes when he says so.

---

## For Tedi — the Stripe key is ready to connect (2026-10-12)

Samuel created the restricted key in the ScaleYourBusiness sandbox on
Stripe: name **"API key for SYB"**, one permission, **Balance: Read**,
nothing else, prefix `rk_test_`. He holds it and gives it to you
directly — never in a commit, never in Discord. What happens next is
yours, because production sign-in is on your side:

1. Paste it at `syb-kappa.vercel.app/connections`, signed in, under
   Stripe. Expect "connected"; the twelve-month backfill runs on the
   next sync (or call `/api/cron/connector-sync` with the bearer secret
   to run it now).
2. Make three or four **test payments** in the sandbox — a payment link
   paid with card `4242 4242 4242 4242`, any future expiry, any CVC — so
   the sync has something to read. One every day or two for the next
   fortnight keeps the two-week clock meaningful.
3. The morning after, look at `connector_syncs`: a row nobody triggered
   is the autonomous sync the amended gate asks for. Tell Samuel; D1
   opens.
4. If connecting fails, the screen shows Stripe's own message naming
   the permission. Send it to Samuel verbatim — the connector's wording
   is tuned from exactly that.

Also on your side before this branch deploys: migrations 0030 and 0031
on the production database (both additive, 24 → 26 locally). Not yet
needed: `BLOB_READ_WRITE_TOKEN` — nothing attaches media until D2.

---

## Built — Session D, layer D0: the foundations (2026-10-12)

Five commits, one per task, no network anywhere, every clause of D0's
done-when a passing test.

- **P3-20a Provider resolution.** `lib/execution/providers/index.ts`
  maps every registry id to its provider, typed so a registry entry
  without a provider fails the build. `undoExecution` resolves from the
  execution row and refuses a mismatched caller; the site route no
  longer hard-codes the fixture.
- **P3-20b Execution connections (rule 13).** `connections.purpose`
  (`measure` | `execute`), the unique index widened to include it, and a
  BEFORE trigger in migration 0030 that refuses a write-capable scope on
  a measure row — its pattern list mirrors `isWriteCapable`, proven on a
  13-scope sample both directions. `connectForExecution()` demands
  exactly the registry's write scopes plus its new `readback_scopes`
  (empty for both fixtures, audited as reads), one too many or too few
  refused by name. The measurement side filters every read on purpose;
  the sync runner skips an execute row as `not_measurement`.
- **P3-20c Media storage.** `lib/content/media.ts`: Vercel Blob in
  production behind `BLOB_READ_WRITE_TOKEN`, an in-memory twin for tests.
  Renders land at `renders/<profile>/<item>/<16 random bytes>` — public
  means fetchable by whoever holds the URL, not listable — and
  `content_items.media_path` is written for the first time. Release
  deletes the object and clears the path, for D2 to call.
- **P3-20d Publish state.** Six statuses on `content_items` with three
  checks (migration 0031): published and withdrawn name their platform
  and the platform's id, published carries its time, failed carries its
  sentence; withdrawn is never failed. `/content` renders the state.
- **P3-20e The due runner.** `lib/execution/due.ts` sweeps expiry
  across all profiles, selects scheduled approvals with no execution
  row, runs pre-bound plans and site changes through the engine, and
  leaves anything else approved and named rather than guessed. A failed
  row is never retried by the clock. `/api/cron/execute-due` behind
  `CRON_SECRET`.

**Hosting placeholder, on record.** The runner is scheduled daily at
05:00 UTC in `vercel.json` because Hobby allows nothing more frequent.
Until the hosting decision, a scheduled post goes out some time after
05:00 on its day, not at its hour.

**Found on the way.** Stripe's dashboard confirms the permission is
simply called "Balance" — the connector's wording stands. The Session C
production test had pinned its clock to 2026-09-22 and then approved the
plan; approval checks expiry on real time, so the test began failing by
itself on 2026-10-06. Fixed in the P3-20d commit; `main` would have gone
red on the next push for a reason unrelated to the push.

---

## Built — Phase 4 Session B: customer chat (2026-10-13)

The first stranger-facing surface, on the opposite privilege model to
the owner's chat: no profile, no report, no proposal queue, no execution
reach. The one thing a conversation can create is a ticket. One commit;
every done-when clause a test; the browser walk on `/support/test` is
recorded as still to do, not assumed.

- **P4-05 Knowledge.** `lib/crm/knowledge.ts` renders candidates from a
  closed allowlist of fourteen public-safe field keys plus each offer's
  name, description, price and price model — nothing else in the profile
  is read — as ONE proposal (module `support`, new action kind
  `support_knowledge`). Approval then publishes them as
  `knowledge_entries`; a re-rendered fact retires the entry it replaces;
  retiring is one click; an owner-written entry takes the same queue.
- **P4-06 Chat.** `lib/support/chat.ts`. The disclosure is the first
  message of every conversation (rule 20). "A person, please" is caught
  by a plain pattern before any model call and by Haiku after. A
  question is grounded by word overlap against the public entries — no
  model, no embeddings — and Sonnet answers only from those entries,
  saying `grounded: false` when they don't cover it; an ungrounded or
  unparseable answer is a handover plus a ticket, never a guess. The
  customer's text reaches only the user turn (rule 24 verbatim in both
  prompts). Caps in code — €0.05 per conversation, €5 per account per
  month from the metering table, 40 turns, 1 000 characters, 200 new
  conversations a day — are checked before any model call.
- **P4-07 Widget and endpoint.** `support_settings.site_key` (public by
  design, rotatable) scopes `/api/support/public`, which reads no cookie,
  sets none, answers CORS for any origin, and knows only the key and a
  per-conversation token the widget keeps in `sessionStorage`.
  `public/support-widget.js` is one script tag with the disclosure
  pinned in its header. `/support` is the owner's screen (key, snippet,
  knowledge, tickets with reasons, transcripts); `/support/test` a
  pretend customer page with the real widget.
- **P4-08 Rule 21.** `lib/support/structure.test.ts` walks the import
  graph transitively from every stranger-facing entry point and fails
  the build if execution, proposals, profile, connectors, content, site,
  crm, chat, intake, auth or the rest is reached.

Migration 0032: five tables, five enums. 21 new tests across three
files. One flake caught by the full run and fixed at the source: a
customer turn stamped by the app's clock next to a reply stamped by the
database's could land out of order by a few milliseconds of skew; every
message is now stamped by one clock and a reply lands strictly after
the turn it answers.

**For Tedi, production:** migrations 0030–0032 before this branch
deploys. No new environment variable for Session B — the chat uses the
existing `ANTHROPIC_API_KEY`; `BLOB_READ_WRITE_TOKEN` waits for D2.

---

## Built — Phase 4 Session D: the self-updating FAQ (2026-10-13)

The loop that makes support cheaper every week, with the owner holding
the pen. `lib/crm/faq.ts` clusters the real questions the assistant
could not answer — tickets — with one batched Haiku call per run over
at most 200 open questions; fewer than three costs no call. A cluster
becomes a proposed knowledge entry ONLY when one of its members carries
the owner's own answer: `support_tickets.answer` (migration 0033)
records what the owner actually said when marking a ticket answered,
and the system never drafts an answer it was not given. A cluster
nobody answered is reported on `/support` as "frequently asked, not yet
answered by you". Approval publishes through the same path as every
other entry; the chat answers the next asker from it. Folding a
question into the FAQ does not close the people who asked it. Nightly
cron `/api/cron/faq-cluster` at 03:00 UTC, plus an owner-triggered run.
5 tests; the done-when is one of them, end to end.

---

## Built — Phase 4 Session E: segments and lifecycle (2026-10-13)

Arithmetic, not inference, with one honest amendment to the plan:
"measured purchase data" is the owner's own shop export, because Phase
2 measures the business as a whole and never a customer. The CSV import
now reads last order date, order count and total spent (migration 0034;
money as minor units with a batch currency, rule 1; the unreadable left
null and counted). Lifecycle thresholds are pinned and boundary-tested
both ways — new ≤ 30 days with at most one order, counted from the
purchase and not the import date; active ≤ 90; lapsing ≤ 180; lapsed
beyond; unknown without a date. VIP is 3+ orders or the top tenth of
spend. Segments separate who is in from who may be emailed — the
consent gate decides per contact — and `lib/crm/segment-proposals.ts`
puts a win-back and a thank-you in the queue once a month, through the
outbound posture, the hard limits and suppression learning, carrying
contact ids only and saying plainly that nothing sends on approval.
New action kind `customer_email`. `/customers` is the owner's screen.
9 tests; the done-when is one of them.

---

## Done — Meta test assets for Session D (2026-10-13, Samuel)

Portfolio "SYB"; Page "SYB Test" with the Instagram professional
account linked; app "SYB" in development mode with the Page, Instagram
and Marketing API use cases; a sandbox ad account in EUR; an admin
system user with a non-expiring token carrying exactly the nine D1
scopes. App ID, App Secret and the token are held outside the repo.
One "verify at build" question answered on the way: an unverified
portfolio can create a system user and issue the token, so the own-
account fallback is not needed. D1 now waits only on the Stripe gate.

**Tedi — the keys are with Samuel.** He holds the Stripe test-mode
restricted key, the Meta App ID and App Secret, and the system-user
token. When a step needs one — the Stripe key at `/connections` on
production, `META_APP_ID` and `META_APP_SECRET` in Vercel at D1 — ask
him and he hands it over directly. Nothing is in the repo or in chat.

---

## Planned — Session H: Ledgerline markets itself (2026-10-13, owner idea)

Ledgerline runs SYB's own marketing through the product for 3–4 weeks,
then publishes that it did, with the scorecard as the proof. Recorded
in `TASKS-PHASE3.md` as Session H (P3-40a–e), after Session D and
before Gate 2. It needs D2 to publish and D4 to judge. It does not need
company registration, because Meta's Standard Access covers SYB's own
Page, Instagram and ad account, which already exist.

Four constraints are fixed now:

- **No secret reveal.** Every post carries the AI label (rule 17).
- **A person approves every item** (rule 12).
- **Results are published whatever they say.**
- **SYB's own decisions are flagged internal** (P3-40b), so they never
  count toward Gate 2's customer approval rate.

**Can start today, no code — P3-40a:** run SYB through its own intake,
report and watching mode. Rule 15's 4–8 week watching period then
elapses while D1–D4 are built.

---

## Planned — trading-hours analysis and trials (2026-10-13, owner idea)

For businesses customers visit (bars, restaurants, cafés): when the
business earns and gets attention, hour by hour. Then whether the doors
open too early or too late, and whether the last hour pays for itself.
Split where the work belongs:

- **Measurement and findings:** `TASKS-PHASE2.md` Session F, P2-26 to
  P2-31.
  - Structured opening hours, timezone, and the cost of one open hour.
  - Hourly revenue with a trading-day cutoff, so 20:00–01:00 is one
    night.
  - A read-only Square point-of-sale connector, since bars rarely take
    cards through Stripe.
  - Attention by hour from GA4 and Instagram.
  - Per-weekday opening and closing signals with pinned thresholds.
  - Competitors' stated hours from the existing research.
- **Trials:** `TASKS-PHASE3.md` Session I, P3-41. A suggested hours
  change becomes a 4-week trial with three scenarios, judged by the
  readback net of the hour's cost. The owner changes their own hours, so
  it does not wait on Session D.

**The honest limit, written into both:** a closed hour records no sales,
so the data can only suggest; the trial is the proof. Cash is invisible
to connectors, so every finding states its coverage.

---

## Planned — customer blindspots (2026-10-13, owner idea)

What potential customers search for, ask about and check before buying,
compared with what the business actually shows them. A blindspot is
demand with no answer on the owner's site or profile. Recorded in
`TASKS-PHASE2.md` Session G, P2-32 to P2-37, all read-only:

- **A "what customers check" list** per business type, as data.
- **Google Search Console,** a new read-only connector: the real
  searches the site appeared for.
- **Deeper GA4 reads:** pages people land on and leave from, and
  site-search terms.
- **Support questions** counted by topic, with no customer text leaving
  support.
- **Competitor norms:** what competitors show that the business doesn't.
- **The finder** that ranks blindspots by demand.

Fixes go through the existing queues: site change, content item or
knowledge entry.

**Found on the way:** the site audit's Tier 1 (`specs/site-audit.md` §2,
walking the site as a customer with screenshots) and its Tier 2 GA4
evidence (§3) were specified but never scheduled. Tier 2 is now P2-34;
Tier 1 remains unscheduled and needs an owner decision.

---

## Planned — alert mode (2026-10-13, owner idea)

When a business under Ledgerline's care isn't improving, or improves far
slower than the gap between its goal and today demands, the system
escalates. Recorded in `TASKS-PHASE3.md` Session J, P3-42 to P3-47:

- **Measurable goals:** a metric, a target and a deadline, with the
  baseline captured when the goal is set. Today a goal is free text
  linked to nothing, so the gap can't be computed.
- **Day zero recorded:** the profile as it stood at takeover.
- **Weekly progress check:** on track, lagging or alert, by arithmetic,
  with thresholds that scale with the size of the gap.
- **A case file** of everything done since day zero.
- **An Opus review:** likely causes, each with evidence, including "our
  advice was wrong". The recovery plan goes into the queue as proposals.
- **A person at SYB** takes over if the recovery plan doesn't move it
  either.

Nothing executes on its own and no limit is relaxed.

---

## Built — alert-mode foundations and the internal flag (2026-10-13)

The parts of the new plans that need no key, no external account and
nothing Samuel is building. 19 new tests, no model call anywhere.

- **P3-40b, internal accounts.** `accounts.internal` keeps SYB's own
  numbers out of the ops funnel, cost view and Gate 2's new
  cross-customer approval rate (`lib/trust/gate.ts`, returned by
  `/api/ops` as `gate2`). Set it with `scripts/mark-internal.ts`.
- **P3-42, measurable goals.** A goal can name revenue, orders or website
  visits, a target per 30 days and a deadline. The starting value is
  measured from the 28 days before, with its source named. Set on
  `/progress` or through `PUT /api/goals`.
- **P3-43, day zero.** A business's first mode decision freezes the
  profile and writes a verifiable `takeover` entry in the decision log.
- **P3-44, progress and alerts.** Each week, every measurable goal is
  judged on track / lagging / off track against the straight path to
  its target. Three off-track weeks in a row raise an alert, shown on
  `/progress`. Thresholds are pinned and boundary-tested both ways.

**Then P3-45 to P3-47, the rest of alert mode:**

- **A case file** of everything since day zero, every line with an
  evidence id.
- **One Opus review** when a goal reaches alert. Code throws out any
  cause without real evidence and records any cause category the review
  skipped, including "our advice was wrong".
- **Its suggestions** enter the queue as ordinary pending proposals,
  through the owner's limits and decline-suppression.
- **A person at SYB takes the case** when the goal is still in alert six
  weeks later, when the review is unusable, or when the €3 monthly budget
  per account is spent. It shows on `/ops`; no AI loop.

The prompt is uncalibrated until a real alert happens. 10 more tests.

**The owner's screen is `/progress`,** linked from `/watch`. It shows
each goal's measure or a form to make it measurable, the latest weekly
verdict, and the review's causes and suggestions. Its API was verified
against a seeded stalled business; the page itself hasn't been looked at
in a browser yet. **Owner: please walk it.**

**Migrations 0035 and 0036** (additive: the `internal` column, the
`takeover` decision kind, the `alert_reviews` table) must be applied to
production with 0030–0034 before this deploys. Samuel: if you add a migration before this is pushed, the
second to push renumbers.

---

## Built — trading hours, first half (2026-10-13)

Phase 2 Session F, P2-26, P2-27 and most of P2-30. The full status is in
`TASKS-PHASE2.md`.

- **Opening hours** are still the owner's own words. Haiku reads them
  once into a weekly schedule, and code throws out anything impossible
  instead of guessing.
- **The timezone** comes from the country when the country has only one
  (Hungary, most of Europe). Otherwise it's unknown, and the screen says
  why.
- **Stripe and Shopify** now also record revenue and orders per hour, in
  UTC, so daylight saving and a bar's after-midnight hours are handled
  when the data is read.
- **`/hours`** shows each weekday's revenue curve, whether the doors may
  open too late, and whether the last hour pays for itself, all with the
  arithmetic and the honest limits.

**Trials (P3-41).** A signal such as "Fridays may open too late" becomes
a 4-week trial in the approval queue. It carries three worked scenarios
(how much the new hour might earn, minus what an hour costs) and gets a
verdict afterwards from what was actually taken. Proposals are made by
the weekly job, never during watching mode, one trial per weekday at a
time. The owner changes their own hours; nothing touches their Google
listing.

**Bank 1.3.0** changes the interview for every business that customers
visit: the opening-hours question moves up to "important", and one new
question asks what an open hour costs. **Production needs `npm run
db:seed`** (the bank loader) after deploy. Samuel: your interview tests
pin question counts. They're updated here (153 → 154).

---

## Built — customer blindspots, and the rest of trading hours (2026-10-13)

`TASKS-PHASE2.md` Sessions F and G; every API shape was checked against
the official docs first.

- **`/blindspots`** compares what potential customers want with what the
  site shows:
  - **Missing from your site:** things customers asked the support chat,
    typed into the site's search box or searched on Google, or that
    competitors show.
  - **Hard to find:** things the site does show that people keep asking
    about anyway.
  - **Seen, not clicked:** Google searches where the site appears on
    page one but rarely gets the click.

  No customer's words ever leave the support system; only counts do.

- **New connection: Google Search Console** (read-only).
- **New connection: Square** (read-only). It reads every location's
  payments, card and cash rung up at the till, by day and by hour. For a
  Square bar or café, `/hours` therefore covers its till takings, not
  just card sales.
- **Google Analytics** now also reads visits by hour, landing pages and
  site searches.
- **`/hours`** gains:
  - when people look the business up online before it opens;
  - when competitors open, from their own pages;
  - a timezone picker for countries with several timezones.
- **Trials:** a running trial is recorded in the profile, and its verdict
  now counts in the agent's scorecard.
- **Found in the docs:**
  - Google Analytics has no "exits" figure, so bounce rate is used instead.
  - **Square records cash rung up on its tills**, so cash becomes
    measurable for Square businesses.
  - Instagram no longer lists its "followers online by hour" figure, so
    it isn't used.

---

## Next

1. **Tedi:** the Stripe key on production, test payments, the first
   autonomous sync. That meets the amended gate and opens D1.
2. **Owner:** walk `/support` → enable → propose → approve in the queue →
   publish → `/support/test` → ask, ask the unanswerable, ask for a
   person → answer the ticket in your words → cluster. Then
   `/customers` → import a shop export → propose. Each should behave as
   the status notes promise.
3. **Phase 4's remainder needs keys:** Session C (email support) waits
   on `RESEND_API_KEY` with inbound; Session F (outbound) on that and
   on Session D's publish path. Nothing else in Phase 4 is buildable
   without them.
4. **D1** once the gate is met and the Meta business portfolio exists;
   the **hosting decision** before D2.

---

## Decided — pilot access to Meta before the approvals (2026-10-12)

Business Verification needs a registered company, so App Review, Tech
Provider verification and open sign-up for Session D's publishing all
wait. Until then, owners connect through two Meta-sanctioned routes,
recorded in `TASKS-PHASE3.md` (owner decisions, P3-20g/h/i, new
P3-20j, owner-side checklist):

1. **Testers.** The owner is added as a Tester on SYB's Meta app and
   connects through Facebook Login. Meta grants every permission to
   app-role holders at Standard Access without review. New sub-task
   P3-20j builds that login flow, and it is not throwaway: once the
   approvals exist, the same flow serves open sign-up.
2. **The owner's own Meta app.** The owner creates an app in their own
   business portfolio and pastes its token. Standard Access covers
   their own assets without review — the pattern Phase 2's Meta ads
   connection already uses.

Considered and not chosen: copy-and-post publishing, and routing through
an already-approved third-party publisher. D1 grows from about one week
to about one and a half; Session D from about six to six and a half.
Three new "verify at build" items: the tester limit per app, system
users on an unverified portfolio, and Meta's terms on handing an
own-app token to a service provider.
