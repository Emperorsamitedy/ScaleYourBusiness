# Deploying SYB to production

One Next.js app, one Postgres. Target: Vercel (app) + Neon (database).
Every key, database URL and account step below is the owner's to do:
keys are typed into Vercel or a local `.env`, never into a chat or a
commit.

**Live since 2026-08-26:** https://syb-kappa.vercel.app — Vercel project
`syb` (samy283407-7767), Neon project `red-breeze-79256837`
(aws-eu-central-1, Postgres 18).

**As of 2026-11-04 production runs old code.** The repo moved from
`CyberSammy-tg/ScaleYourBusiness` to `JanKenzeroX/ScaleYourBusiness`, and
the Vercel project still points at the old one, so pushes to `main` no
longer deploy. Step 1 fixes that.

## 1. Vercel — point it at the repo

1. Vercel → project `syb` → Settings → Git → disconnect the old repo,
   connect `JanKenzeroX/ScaleYourBusiness`, production branch `main`.
2. Framework preset Next.js, no build changes. CI runs the same
   `npm run build` on every PR (since PR #91), so a green `main` builds.

## 2. Neon — the database

Run from a dev machine, never from serverless (the bank loader shells out
to `scripts/lint_bank.py`). Set `DATABASE_URL` to the Neon pooled URL in
your own terminal — don't paste it anywhere else.

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

- `db:migrate` applies everything up to `0082_review_push`.
  Migrations are forward-only.
- `db:seed` loads the question bank, its vocabularies and the six
  language overlays (`specs/question-bank-v1.<locale>.json`).
- Order is always migrate → seed → deploy.

## 3. Environment variables (Vercel → Settings → Environment Variables)

`.env.example` explains every one. What each group switches on:

**Needed to run at all**

- `DATABASE_URL`: the Neon pooled URL.
- `CONNECTOR_KEY`: 32 random bytes. It encrypts connection secrets at
  rest. Losing it means every connection must be made again.
- `APP_URL`: `https://syb-kappa.vercel.app` (or the real domain). Links
  in emails and Stripe redirects use it.
- `CRON_SECRET`: any long random string. Without it, the seven jobs in
  `vercel.json` refuse to run: the weekly watch (which also grades
  forecasts, checks goals and stock and sends the weekly summary),
  connector sync, due executions, FAQ clustering, competitor reads,
  footage rendering and held phone alerts.

**The AI (the interview, report, chat and drafts)**

- `ANTHROPIC_API_KEY`, and `INTERVIEWER_MODE=llm`. With
  `deterministic` the interview walks the bank in order and asks the
  model nothing.
- Leave `SONNET_MODEL` and `DIAGNOSIS_MODEL` empty until the
  recalibration run (M-2).

**Sign-in and email**

- `RESEND_API_KEY` and `EMAIL_FROM` (a verified domain). Without them,
  the sign-in link shows on screen instead of being emailed.
- Optional: `CAMPAIGN_EMAIL_FROM`, `RESEND_WEBHOOK_SECRET` (inbound
  support, webhook at `/api/support/inbound`), `RESEND_EVENTS_WEBHOOK_SECRET`
  (delivery signals, webhook at `/api/email/events`) and
  `SUPPORT_INBOUND_DOMAIN`.
- Social sign-in: the `GOOGLE_*`, `MICROSOFT_*` and `APPLE_*` keys. Each
  button works only when all of its keys are set.

**Payment** (unarmed, so the report is free, until set)

- `STRIPE_SECRET_KEY` (`sk_test_…` first), `STRIPE_WEBHOOK_SECRET`
  (webhook at `/api/stripe/webhook`). The price defaults to €49 for the
  first business and €29 for each extra one.

**Features that need their own key**

- Phone alerts: run `npm run vapid:generate` and set `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`.
- Page speed in the site audit: `PAGESPEED_API_KEY`.
- Google reviews: `GOOGLE_BUSINESS_API_APPROVED=true`, only after Google
  approves the Business Profile API.
- Media storage: `BLOB_READ_WRITE_TOKEN`.
- Meta: `META_APP_ID`, `META_APP_SECRET` and `META_OAUTH_REDIRECT_URI`.
  Keep `META_ACCESS_LEVEL=standard` until App Review.
- Niche research: `META_AD_LIBRARY_TOKEN`.
- Error monitoring: `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`.
- The ops panel: `OPS_KEY`.

**Languages**

- `LANGUAGE_REVIEW_ACCOUNTS`: your own email, plus each native reviewer's
  once chosen. Until a language is switched to `live` (stage L-7),
  everyone else sees English.

**Leave off**

- `SESSION_D_REAL_WRITES`: no real publishing until the unattended-sync
  clock is judged complete (TASKS-PHASE3.md).
- `MEDIA_PROVIDER`: no vendor has been chosen.
- `PUSH_SERVICE`: development only.

## 4. Deploy, then verify

Deploy from Vercel, or push to `main` once step 1 is done. Then, in a
private window:

- `/` shows the landing page; `/signup` asks for language and currency
  first; creating an account sends (or shows) a sign-in link.
- The link opens the interview; an answer records with its source and the
  next question comes.
- `/profile`, `/report`, `/watch` and `/history` open for a signed-in
  owner with no server error.
- `/settings/language` as an address on `LANGUAGE_REVIEW_ACCOUNTS` offers
  all seven languages. For anyone else, only English.
- `/ops?key=<OPS_KEY>` shows readiness. Each missing key is named there.
- After the first Monday 06:00 UTC, the weekly watch has run: check
  `/ops` or the Vercel cron log.

## Notes

- No write-scope external call runs anywhere until
  `SESSION_D_REAL_WRITES=on` (CLAUDE.md, rules 12–18).
- The local checks that cost money (`npm run harness` for the 20-persona
  interview run, `npm run verify:caching`, `npm run verify:models`) need
  `ANTHROPIC_API_KEY` and are the owner's to run.
