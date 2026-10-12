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
- **Session D layer D0 is built, and Phase 4 Session B** (both below).
  Three new migrations, 0030–0032, all additive — production must apply
  them before this branch deploys. One new dependency: `@vercel/blob`.
- **Local: 766 tests across 82 files**, typecheck, lint, format and
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

## Next

1. **Tedi:** the Stripe key on production, test payments, the first
   autonomous sync. That meets the amended gate and opens D1.
2. **Owner:** walk `/support` → enable → propose → approve in the queue →
   publish → `/support/test` → ask, ask the unanswerable, ask for a
   person. Each should behave as the status note promises.
3. **Meanwhile, needing nothing external:** Phase 4 Session D (the
   self-updating FAQ) and Session E (segments) — Session C (email) waits
   on `RESEND_API_KEY`, Session F on that and on D2.
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
