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

## Go live on your own domain — the order

Each line is the owner's. About two hours, most of it waiting on DNS.
The sections below hold the detail.

1. **Domain.** Buy it. Vercel → `syb` → Settings → Domains → add it
   (and `www.` if wanted); set the DNS records Vercel shows at the
   registrar.
2. **Repo.** Vercel → Settings → Git → connect
   `JanKenzeroX/ScaleYourBusiness`, branch `main` (section 1).
3. **Database.** Nothing to run: since 2026-11-08 every production
   deploy runs `db:migrate` then `db:seed` inside Vercel's build
   (`scripts/vercel-build.mjs`), where the Sensitive `DATABASE_URL` lives.
   A failing step fails the deploy and the live one stays. Section 2 still
   works by hand from a dev machine.
4. **Keys a live site can't do without** (Vercel → Environment
   Variables, Production): `DATABASE_URL`, `CONNECTOR_KEY` (the same one
   as before, or every old connection must be made again),
   `APP_URL=https://<your domain>`, `CRON_SECRET`, `ANTHROPIC_API_KEY`
   with `INTERVIEWER_MODE=llm`, and `BLOB_READ_WRITE_TOKEN` (Vercel →
   Storage → Blob).
5. **Email from your domain.** Resend → Domains → add the domain, set its
   DNS records, wait for "verified"; then `RESEND_API_KEY` and
   `EMAIL_FROM="SYB <hello@your domain>"`. Until then sign-in links show on
   screen.
6. **Redirects that name the domain.** Anything with a callback URL takes
   the new domain: Stripe's webhook (`/api/stripe/webhook`), Meta's
   `META_OAUTH_REDIRECT_URI`, the Google, Microsoft and Apple sign-in
   redirects. Only for the ones you switch on.
7. **Deploy.** Redeploy `main` from Vercel. Then walk section 4's checks
   in a private window. Set `OPS_KEY` to any long string and open
   `/ops?key=<OPS_KEY>` to see which keys are still missing.

What stays off on purpose: `SESSION_D_REAL_WRITES` (real posting waits
for Meta's App Review and Business Verification, P3-20i) and
`GOOGLE_BUSINESS_API_APPROVED` (waits for Google). The site is live
without them; the screens say what each one waits for.

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

`/ops?key=<OPS_KEY>` checks each of these live, one section per feature: which
variables are set (never their values), the callback URLs to paste, and what
stays switched off. A feature nobody has started setting up shows OFF, not
MISSING.

- Phone alerts: run `npm run vapid:generate` and set `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`.
- Page speed in the site audit: `PAGESPEED_API_KEY`.
- Google reviews: `GOOGLE_BUSINESS_API_APPROVED=true`, only after Google
  approves the Business Profile API.
- Google Ads (P2-20 / P3-22): `GOOGLE_ADS_ACCESS_LEVEL` (`test`, `explorer`,
  `basic` or `standard` — what Google approved, shown to owners as is), plus
  an OAuth client: `GOOGLE_ADS_CLIENT_ID` and `GOOGLE_ADS_CLIENT_SECRET`, or
  nothing more to reuse `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. Optional:
  `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`,
  `GOOGLE_ADS_REDIRECT_URI`. Without the required ones the Google Ads card
  names exactly what is missing. The steps on Google's side are below.
- Media storage: `BLOB_READ_WRITE_TOKEN`.
- Meta: `META_APP_ID`, `META_APP_SECRET` and `META_OAUTH_REDIRECT_URI`.
  Keep `META_ACCESS_LEVEL=standard` until App Review.
- Niche research: `META_AD_LIBRARY_TOKEN`.
- TikTok posting: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` and
  `TIKTOK_REDIRECT_URI`; keep `TIKTOK_AUDIT_STATUS=unaudited` until TikTok's
  audit passes. The owner's steps: (1) create a TikTok for Developers account
  at developers.tiktok.com and an organization for SYB; (2) create the SYB
  app (Manage apps → Connect an app) with its icon, description, terms and
  privacy URLs; (3) add the **Login Kit** product and register the redirect
  URI `<APP_URL>/api/connections/tiktok-posting/callback`, byte for byte;
  (4) add the **Content Posting API** product and switch **Direct Post** on;
  (5) add the scopes `video.publish`, `user.info.basic` and `video.list` (no
  others: SYB refuses a grant with one more); (6) copy the client key and
  secret from Credentials into the env above; (7) submit the app for
  TikTok's review and then the Content Posting API **audit**. Until the
  audit passes, every post goes out private ("only me"), TikTok lets the app
  post for only a few accounts a day, and the screen says so. Real posts also
  wait for `SESSION_D_REAL_WRITES=on`, like Meta's.
- TikTok Ads (read spend, act on approved proposals): `TIKTOK_ADS_APP_ID`,
  `TIKTOK_ADS_SECRET` and `TIKTOK_ADS_REDIRECT_URI`. Owner steps:
  1. Create a TikTok For Business account and register as a developer at
     business-api.tiktok.com (TikTok approves the developer profile).
  2. Under My Apps, create an app; set its advertiser redirect URL to
     `<APP_URL>/api/connections/tiktok/callback`.
  3. Under Scope of permission, tick exactly: Ad Account Management → Read
     Ad Account Information; Ads Management → Campaign → Read Campaigns and
     Create and Update Campaigns; Reporting → Consolidated Report. Nothing
     else — a token with one permission more or fewer is refused by name.
  4. Submit the app for TikTok's review (2–3 business days); its sign-ins
     work only once it is approved. SYB doesn't use TikTok's sandbox
     accounts (TikTok retires them on 1 December 2026).
  5. Copy the App ID and Secret from Basic Information into
     `TIKTOK_ADS_APP_ID` and `TIKTOK_ADS_SECRET`, and the redirect URL into
     `TIKTOK_ADS_REDIRECT_URI`. Then connect from `/connections`. Reading
     starts with the next connector-sync cron; changes stay off with
     `SESSION_D_REAL_WRITES` (see Leave off). Facts: `specs/tiktok-ads-api-v1.md`.
- Error monitoring: `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`.
- The ops panel: `OPS_KEY`.
- Phone answering (P6-02): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and
  `TWILIO_PHONE_NUMBER` (E.164, e.g. `+447700900123`). In Twilio, set the
  number's "A call comes in" webhook to `<APP_URL>/api/phone/voice` and its
  call status callback to `<APP_URL>/api/phone/voice?step=status`, both
  HTTP POST. Then turn the line on from `/support`. One business per number.
- The weekly summary on WhatsApp (P6-07): the same `TWILIO_ACCOUNT_SID` and
  `TWILIO_AUTH_TOKEN`, plus `TWILIO_WHATSAPP_FROM` (the WhatsApp-enabled
  sender, E.164) and `TWILIO_WHATSAPP_SUMMARY_TEMPLATES` (JSON, locale →
  approved ContentSid, e.g. `{"en":"HX…","de-DE":"HX…"}`; `en` required).
  Submit the template text in `specs/whatsapp-summary-v1.md` for Meta's
  approval first. Then the owner picks WhatsApp on `/watch`, gives their
  number and ticks the opt-in; nothing goes without that yes.
- AI video (P6-03): buy Higgsfield **API** credit (a prepaid USD balance,
  separate from any higgsfield.ai web plan), create a key in Higgsfield's
  API console, then set `MEDIA_PROVIDER=higgsfield`, `HIGGSFIELD_API_KEY`
  (the key id) and `HIGGSFIELD_API_SECRET`. Optional:
  `HIGGSFIELD_MONTHLY_CAP_MINOR` (US cents per business per month, default
  6000 = $60), `HIGGSFIELD_MODEL` and `HIGGSFIELD_USD_MICROS_PER_SECOND`
  (see `specs/higgsfield-api-v1.md`). Needs media storage
  (`BLOB_READ_WRITE_TOKEN`). Three 5-second candidates cost about $1.68.

**Google Ads, the owner's steps on Google's side** (checked against
Google's pages on 2026-11-08; `specs/google-ads-api-v1.md` keeps what is
confirmed and what isn't)

1. In Google Cloud Console, pick the project that owns the OAuth client SYB
   will use (the sign-in client, or a new project for Google Ads alone — a
   separate project keeps adwords' verification from holding up sign-in).
   Enable the **Google Ads API**.
2. Open the Google Ads API overview page in that project
   (`console.cloud.google.com/google/ads-apis/overview`). Access is granted
   to the project now, not to a developer token: a new project starts at
   **Test** (test accounts only). Apply there for **Explorer** (real
   accounts, 2,880 operations a day) and then **Basic** (15,000 a day,
   after brand verification and Google's review). Google says a developer
   token and a manager account are no longer needed to start (developer
   tokens were retired on 2026-09-09; the old API Center application is
   gone). A Google Ads manager account is still useful to hold test
   accounts for trying it out (not confirmed on the pages read). Set
   `GOOGLE_ADS_ACCESS_LEVEL` to the level Google has granted, and change it
   when Google changes it: owners see it on their card.
3. On the OAuth consent screen, add the scope
   `https://www.googleapis.com/auth/adwords`. It is a sensitive scope, so
   Google's app verification is needed before anyone outside the test users
   can grant it; until then add pilot owners as test users.
4. Add the redirect URI `<APP_URL>/api/connections/google-ads/callback` to
   the OAuth client.
5. In Vercel, set the keys above. Reads start on the next daily sync; a
   change runs only after the owner approves a proposal, and only once
   `SESSION_D_REAL_WRITES=on`.

**Languages**

- `LANGUAGE_REVIEW_ACCOUNTS`: your own email, plus each native reviewer's
  once chosen. Until a language is switched to `live` (stage L-7),
  everyone else sees English.

**Leave off**

- `SESSION_D_REAL_WRITES`: no real publishing until the unattended-sync
  clock is judged complete (TASKS-PHASE3.md).
- `MEDIA_PROVIDER`: leave empty until the Higgsfield API key above is set;
  then `higgsfield`. Never `fake` in production (it is refused there).
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
