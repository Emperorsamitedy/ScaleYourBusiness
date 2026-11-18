# SETUP — everything you need to fill in

This is your workspace for making SYB complete: every key, and every
decision or file that only you can supply. Work down the list and tick each
box as you go.

## Where things go

- **On your computer:** copy `.env.example` to `.env` and fill in the
  values. `.env` is never committed (it is in `.gitignore`).
- **In production:** Vercel → your project → Settings → Environment
  Variables. Use the same names as in `.env.example`.
- **To check what's missing:** open `/ops?key=YOUR_OPS_KEY` on the running
  app. Its "launch readiness" list shows each setting as ready, missing or
  to check. It never shows a value.
- **Never** paste a key into a chat, a ticket, a commit or a screenshot.

Each entry below says what it is for, where to get it, and what happens
while it is empty. The comments in `.env.example` have the exact formats.

---

## 1. Needed to run at all

- [ ] `DATABASE_URL`: your Postgres connection string. Locally it points
      at the dev database. In production it is your hosted Postgres (for
      example Neon or Supabase).
- [ ] `CONNECTOR_KEY`: 32 random bytes. It encrypts every stored
      connection secret, including NAV credentials. Generate it with
      `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
      **Keep a safe copy.** If you lose it, every stored connection has to
      be reconnected.
- [ ] `APP_URL`: the site's address, e.g. `https://syb-kappa.vercel.app`.
      It is used in emailed links and payment redirects.
- [ ] `ANTHROPIC_API_KEY`: from console.anthropic.com. It powers the
      interview, the diagnosis and chat.
- [ ] `OPS_KEY`: any long random string. It opens `/ops`.
- [ ] `CRON_SECRET`: any long random string. Vercel's scheduled jobs send
      it to prove they are Vercel.
- [ ] `COOKIE_SECRET` (optional): gives sign-in cookies their own key.
      When empty, the key is derived from `CONNECTOR_KEY`.

## 2. Email and sign-in

- [ ] `RESEND_API_KEY`, `EMAIL_FROM`: sends sign-in links and summaries.
      Get them at resend.com with your own domain verified.
- [ ] `RESEND_WEBHOOK_SECRET`, `RESEND_EVENTS_WEBHOOK_SECRET`,
      `SUPPORT_INBOUND_DOMAIN`, `CAMPAIGN_EMAIL_FROM`: inbound support email
      and campaign delivery events. These are optional until you use those
      features.
- [ ] Sign in with Google / Microsoft / Apple (all optional):
      `GOOGLE_CLIENT_ID` and `_SECRET`, `MICROSOFT_CLIENT_ID` and `_SECRET`,
      `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`.
      Each button appears only when its keys are set.

## 3. Payments (Stripe)

- [ ] `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`: from the Stripe
      dashboard. **Payments stay switched off until these exist**, and so
      does the paid-report gate.
- [ ] Prices are moving into a price book table (the multi-market spec,
      Part B). `REPORT_PRICE_MINOR`, `REPORT_CURRENCY` and
      `EXTRA_REPORT_PRICE_MINOR` still work until that lands.
- [ ] **Subscriptions (v1 spec §8).** Plans, the €49 credit, dunning and
      the guarantee are built and tested against a stand-in Stripe. When
      the keys exist, in the Stripe dashboard: - the webhook endpoint `/api/stripe/webhook` sends
      `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
      `customer.subscription.created`, `customer.subscription.updated`,
      `customer.subscription.deleted`, `invoice.paid` and
      `invoice.payment_failed` - **SEPA Direct Debit** is switched on (euro plans offer it beside cards) - **Smart Retries** set the retry schedule for failed payments; SYB
      tells the owner after each failure and points to the card update - the **customer portal** lets an owner update the card and see invoices
- [ ] **Compliance (v1 spec §9).** Phone answering stays blocked in every
      country until counsel in that market signs the matrix row (date and
      reference) on /ops. Every call now asks consent by keypad before anything
      is transcribed. When an owner asks for their business to be erased
      (/settings/data), it leaves every benchmark at once; a person then removes
      its data and marks the request done. DPIAs for the phone and benchmark
      subsystems are counsel's before launch.
- [ ] **Partner Console (v1 spec §7).** Firms ask their clients for a
      mandate by email, so `RESEND_API_KEY` must be set for those emails to
      go out (without it the requests are made and counted as "not sent").
      A firm's own sender domain is stored but used only once it is verified
      with Resend. One person should time a 40-client onboarding (§7.7: under
      30 minutes).
- [ ] **The free check's leak rates** (`specs/entry-v1.json`) are SYB's
      rules of thumb, shown as grade-D estimates. Correct any you know better.

## 4. Measuring a business (read-only connectors)

Owners connect their own accounts inside the app. You only need the app
registrations below.

- [ ] Google (Analytics, Search Console, Business Profile):
      `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_BUSINESS_REDIRECT_URI`,
      and `GOOGLE_BUSINESS_API_APPROVED` once Google approves access.
- [ ] Google Ads: `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`,
      `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`,
      `GOOGLE_ADS_REDIRECT_URI`, `GOOGLE_ADS_ACCESS_LEVEL`.
- [ ] `PAGESPEED_API_KEY`: used by the website audit (optional).
- [ ] `META_AD_LIBRARY_TOKEN`: lets SYB read competitors' ads (optional).

## 5. NAV Online Számla, Hungary's invoice data (new)

This is SYB's identity as software when it reads a business's invoices
from the tax authority. It is set once for the whole app. **Leave
`NAV_SOFTWARE_ID` empty until counsel answers the question in section 9.**
While it is empty, SYB sends nothing to NAV.

- [ ] `NAV_SOFTWARE_ID`: exactly 18 characters (digits, capital letters,
      hyphens). Set it once and never change it.
- [ ] `NAV_SOFTWARE_DEV_NAME`, `NAV_SOFTWARE_DEV_CONTACT`: required by NAV.
- [ ] `NAV_SOFTWARE_DEV_COUNTRY`, `NAV_SOFTWARE_DEV_TAX_NUMBER`: optional.
- [ ] `NAV_ENVIRONMENT`: `test` until you are ready, then `prod`.
- Each business's technical user (login, password, signature key) is
  entered by the owner in the app's Hungarian guide and stored encrypted
  per business. Never put those in `.env`.

## 6. Acting for a business (write access, each switched on deliberately)

- [ ] `SESSION_D_REAL_WRITES`: stays empty until you decide real changes
      may go out. With it empty, SYB proposes changes and does nothing else.
- [ ] Meta (Facebook and Instagram ads and posts): `META_APP_ID`,
      `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI`, `META_ACCESS_LEVEL`.
- [ ] TikTok posting: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`,
      `TIKTOK_REDIRECT_URI`, `TIKTOK_AUDIT_STATUS`.
- [ ] TikTok ads: `TIKTOK_ADS_APP_ID`, `TIKTOK_ADS_SECRET`,
      `TIKTOK_ADS_REDIRECT_URI`.
- [ ] Media storage for generated images and video: `BLOB_READ_WRITE_TOKEN`
      (Vercel Blob).
- [ ] AI video (Higgsfield): `MEDIA_PROVIDER`, `HIGGSFIELD_API_KEY`,
      `HIGGSFIELD_API_SECRET`, `HIGGSFIELD_MODEL`,
      `HIGGSFIELD_MONTHLY_CAP_MINOR`, `HIGGSFIELD_USD_MICROS_PER_SECOND`.

## 7. Phone, WhatsApp and phone alerts

- [ ] Phone answering: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
      `TWILIO_PHONE_NUMBER`. Even with the keys set, a line only answers in
      a country you have unblocked in the compliance matrix (section 9).
- [ ] WhatsApp weekly summary: `TWILIO_WHATSAPP_FROM`,
      `TWILIO_WHATSAPP_SUMMARY_TEMPLATES`.
- [ ] `PHONE_RECORDING_KEEP_DAYS`: how long call recordings are kept.
- [ ] Phone alerts (Web Push): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
      `VAPID_SUBJECT`. Generate them with `npm run vapid:generate`.

## 8. Monitoring and the ledger's daily seal (optional)

- [ ] Sentry error monitoring: `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`,
      `SENTRY_TEST_KEY`.
- [ ] Write-once storage for the Proof Ledger's daily seal:
      `LEDGER_HEAD_S3_BUCKET`, `LEDGER_HEAD_S3_REGION`,
      `LEDGER_HEAD_S3_ACCESS_KEY_ID`, `LEDGER_HEAD_S3_SECRET_ACCESS_KEY`.
      The bucket needs S3 Object Lock in compliance mode. While these are
      empty, the seal is kept in the database's append-only table.

---

## 9. Not keys: decisions and files only you can supply

- [ ] **Counsel sign-off per country.** In `/ops` → "country compliance
      matrix", a country is unblocked for phone answering only with
      counsel's sign-off date and reference. Every change is logged with
      who made it and why. Hungary needs its row before any Hungarian
      phone line answers.
- [ ] **NAV software registration.** Does NAV require SYB's software ID to
      be registered, and does that need a Hungarian legal entity? NAV's
      public schema doesn't say. Ask counsel; until they answer,
      `NAV_SOFTWARE_ID` stays empty.
- [ ] **NAV guide screenshots.** The Hungarian setup guide for owners has
      one image slot per step, under `public/nav-guide/`, listed in
      `public/nav-guide/README.md`. The guide refuses to go live while any
      slot is empty. Capture each screenshot from a real Online Számla
      account, with personal data blurred.
- [ ] **Usage quotas per tier.** These are placeholders until you confirm
      them. Per business per month:

      | Tier       | LLM tokens | Video renders | Connector calls |
              | ---------- | ---------- | ------------- | --------------- |
              | Watch      | 300k       | 0             | 3k              |
              | Act        | 1.5M       | 10            | 15k             |
              | Autonomous | 4M         | 40            | 40k             |

              Owners get a notice at 80% and a hard stop at 100%. The Hungarian
              price book stays off until you confirm these.

- [ ] **Hungarian prices.** The price book's HUF rows (Watch 11 500 Ft,
      Act 35 000 Ft, Autonomous 69 000 Ft, extra business 7 000 Ft, full
      diagnosis 11 500 Ft) come from your spec. Confirm them before they go
      live. After that, a price change is a reviewed yearly edit with a
      changelog entry.
- [ ] **A DPIA and a DPA entry for NAV.** The spec names NAV as its own
      processing activity. This is a document for counsel, not code.
- [ ] **A DPA entry and a DPIA for peer benchmarks.** Contribution is on by
      default with a one-tap opt-out (v1 spec §5.5). Counsel confirms the
      legal basis and the sign-up notice. What the code does, and the
      questions for counsel, are in `specs/peer-benchmarks-dpa-notes.md`.
