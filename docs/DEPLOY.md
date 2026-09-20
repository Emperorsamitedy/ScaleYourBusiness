# Deploying SYB to staging (P0-85 / P0-08)

One Next.js app, one Postgres. Target: Vercel (app) + Neon (database).

**Live since 2026-08-26:** https://syb-kappa.vercel.app/intake — Vercel
project `syb` (samy283407-7767), Neon project `red-breeze-79256837`
(aws-eu-central-1, Postgres 18). The steps below reproduce it from zero.

## 1. Neon — the database

1. Create a project (region: EU). Copy the pooled connection string.
2. From this repo, apply schema and seed the question bank — the bank
   loader shells out to `scripts/lint_bank.py`, so seeding runs from a
   dev machine, never from serverless:

   ```bash
   DATABASE_URL="<neon-pooled-url>" npm run db:migrate
   DATABASE_URL="<neon-pooled-url>" npm run db:seed
   ```

   Expected output: 14 migrations applied; `vocabularies: 55 / 438
entries`; `bank: 1.0.0, 153 questions`.

## 2. Vercel — the app

1. Import the GitHub repo (`CyberSammy-tg/ScaleYourBusiness`), framework
   preset Next.js, no build changes (`npm run build` passes as-is).
2. Environment variables (Production + Preview):
   - `DATABASE_URL` — the Neon pooled URL
   - `ANTHROPIC_API_KEY` — only when live-LLM intake is enabled; the
     staging intake runs `INTERVIEWER_MODE=deterministic` without it
   - `INTERVIEWER_MODE` — `deterministic` until API credits exist
3. Deploy. The intake lives at `/intake`; the root page is intentionally
   empty in Phase 0.

## 3. Verify (the P0-85 bar: reachable by a stranger, on a phone)

- Open `https://<app>.vercel.app/intake` in a private window: question
  1.1 appears, an answer records, a chip settles, the counter advances.
- Refresh: the session resumes from the cookie (`syb_intake_profile`).
- Second private window: gets its OWN fresh profile (cookie-scoped).
- Phone at 360px: single column, "Recorded (n)" strip works.
- Telemetry: after a few answers, run locally
  `DATABASE_URL="<neon-url>" npx tsx scripts/intake-report.ts` — the
  per-question table appears (P0-87 evidence for the ten real intakes).

## Notes

- Migrations are forward-only; deploy order is migrate → seed → deploy.
- No write-scope external calls exist anywhere in Phase 0 (CLAUDE.md).
- Sentry (P0-07b) attaches here too: `npx @sentry/wizard@latest -i nextjs`
  with the DSN, once an account exists.
