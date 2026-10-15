# Ledgerline — plain-English overview

A one-page orientation for anyone new to the project. The detail lives in
`CLAUDE.md`, `specs/` and the `TASKS*.md` files; this page only says what the
product is, what works today, and what is still to come. Last updated
2026-10-13 (v0.0.17).

## What it is

Ledgerline is an AI business assistant for small business owners. It
interviews the owner, builds a fact sheet about the business, diagnoses what
is wrong, and then helps do the work — marketing, customers, support — but
never acts without the owner's approval.

Every number it holds records where it came from, how sure it is and when it
was true. Old values are kept, never overwritten, so history and
contradictions are visible.

## What works today

| Area             | Page           | What it does                                                                | State                                     |
| ---------------- | -------------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| Interview        | `/intake`      | Asks about the business one question at a time; resumable                   | Live                                      |
| Profile          | `/profile`     | The business fact sheet, with history and competitor research               | Live                                      |
| Diagnosis report | `/report`      | Findings and fixes — the paid product (€49 default)                         | Live; payment off until Stripe keys exist |
| Mode choice      | `/mode`        | Owner picks "just the report" or "keep watching"                            | Live                                      |
| Watching         | `/watch`       | Weekly check-in on the business                                             | Live                                      |
| Sign-in          | `/login`       | Email magic link; Google/Microsoft/Apple once keys exist                    | Live                                      |
| Ops panel        | `/ops`         | Funnel, interview drop-off, AI cost                                         | Live behind `OPS_KEY`                     |
| Connections      | `/connections` | Reads Stripe, Shopify, GA4, Meta ads — read-only                            | Built; no real account connected yet      |
| Approval queue   | `/proposals`   | AI proposes, owner approves; emergency stop                                 | Built; acts only on test stand-ins        |
| Track record     | `/history`     | How past proposals turned out                                               | Live                                      |
| Content          | `/content`     | Post drafts and plans                                                       | Drafts only — publishes nowhere yet       |
| Website changes  | `/site`        | Previews site changes                                                       | Applies to a test site only               |
| Owner chat       | `/chat`        | Ask about your business                                                     | Live                                      |
| Support          | `/support`     | Chat widget for the owner's site; says it is an AI; FAQ that updates itself | New; not yet walked through by a human    |
| Customers        | `/customers`   | Customer import, consent, segments                                          | New; not yet walked through by a human    |
| Goal progress    | `/progress`    | Measurable goals, weekly on-track check, alert review when stuck            | New; not yet walked through by a human    |
| Trading hours    | `/hours`       | Revenue by hour and weekday; opens too late? last hour pays?                | New; Stripe/Shopify card sales only       |

## What is still to come

- **Real publishing** to Facebook/Instagram, then Meta ad changes, with undo,
  spend caps and results tracking (Phase 3 Session D, `TASKS-PHASE3.md`).
- **Email support** — inbound email to tickets, AI-drafted replies a human
  approves, handover to a person (Phase 4 Session C).
- **Email marketing** to customer segments, with consent rules enforced in
  code (Phase 4 Session F).
- **Google Ads** — blocked on Google's developer-token approval.
- **Trading hours, the rest** — `/hours` already shows revenue by hour
  and proposes 4-week trials of an hours change; still to come: website
  and Instagram attention by hour, a till (point-of-sale) connection and
  competitors' hours (`TASKS-PHASE2.md` Session F, `TASKS-PHASE3.md`
  Session I).
- **Customer blindspots** — what potential customers search for, ask
  about and check before buying, compared with what the business
  actually shows them (`TASKS-PHASE2.md` Session G).
- **Alert mode, in real use** — built (`/progress`, `TASKS-PHASE3.md`
  Session J) and tested on sample data; its review prompt is tuned on
  the first real business that stalls.
- **Ledgerline markets itself** — once posting works, it runs SYB's own
  marketing for 3–4 weeks, then publishes the honest results as the
  launch story (Phase 3 Session H, `TASKS-PHASE3.md`). Step one, running
  SYB through its own interview and report, can start today.

## What is blocking, outside the code

- Company registration (needed for Meta verification and Stripe live mode).
- Connecting the Stripe test key and verifying its 12-month backfill — the
  gate before real publishing.
- Meta app keys and testers; a Vercel Blob store.
- Hosting: the current Vercel plan runs scheduled jobs once a day, so
  scheduled posts can't go out at their exact hour.
- Paying customers: no stranger has bought a report yet (Gate 1). Each phase
  since has been opened by owner override.

## Running it locally

See `docs/DEPLOY.md` for production. Locally: `docker compose up -d`, copy
`.env.example` to `.env`, `npm install`, `npm run db:migrate`, `npm run dev`,
then open http://localhost:3000. Without `ANTHROPIC_API_KEY` the pages load
but the interview runs in fixed order and the report and chats cannot run.
