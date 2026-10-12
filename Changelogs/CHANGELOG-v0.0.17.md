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
- **Session D layer D0 is built** (below). Two new migrations, 0030 and
  0031, both additive — production must apply them before this branch
  deploys. One new dependency: `@vercel/blob`.
- **Local: 745 tests across 79 files**, typecheck, lint and format
  clean. Not pushed yet — Samuel pushes when he says so.

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

## Next

1. **Tedi:** the Stripe key on production, test payments, the first
   autonomous sync. That meets the amended gate and opens D1.
2. **Meanwhile, needing nothing external:** Phase 4 Session B (customer
   chat) and the other Phase 4 sessions without outside keys, per the
   work split.
3. **D1** once the gate is met and the Meta business portfolio exists;
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
