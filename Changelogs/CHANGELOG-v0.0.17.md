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
