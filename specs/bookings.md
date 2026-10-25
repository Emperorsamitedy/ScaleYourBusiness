# Bookings — appointments as measurement

**Why.** Customer interviews (2026-10): "We have to handle gyms and salons just as well as a dropshipping webshop." A gym's or salon's real numbers live in its **booking system**: appointments kept, no-shows, cancellations, clients coming back, how full the chairs or classes are. Before this spec, nothing read them.

**Two ways in, one set of measures:**

1. **Square Appointments**, through the Square connector that already reads payments (Phase 2 P2-28), with Square's read-only Bookings permissions.
2. **A bookings export** the owner imports from any other system (CSV), mapped by a column table that is data (rule 4, `specs/bookings-import-map-v1.json`).

Both write appointments to `booking_appointments`. The daily measures go to `metric_observations` under a connection, the table every connector feeds, so measured facts supersede the owner's estimates exactly as a connector's do, with the delta shown (rule 11). Read-only throughout (rule 9): Square is asked only for read permissions, and an import reads a file the owner hands over.

---

## 1. Research: which booking systems can be read (2026-10-22)

Checked against public documentation on 2026-10-22, about an hour in total. "Read API" means one a small business can authorise for its own account without being a software partner.

| Platform | Public read API | How it is authorised | Free? | Appointments CSV export | Sources |
| --- | --- | --- | --- | --- | --- |
| Square Appointments | **Yes**, Bookings API: `GET /v2/bookings` (ListBookings), `GET /v2/bookings/{id}` | OAuth or access token. Read: buyer-level `APPOINTMENTS_READ`; seller-level (all the seller's bookings) `APPOINTMENTS_READ` + `APPOINTMENTS_ALL_READ`. Writes are separate (`APPOINTMENTS_WRITE`, `APPOINTMENTS_ALL_WRITE`). | API free. Bookings need a location on an eligible Square Appointments plan | Yes, from the Square Dashboard | developer.squareup.com: reference/square/bookings-api/list-bookings; docs/oauth-api/square-permissions; docs/bookings-api/use-the-api; reference/square/enums/BookingStatus |
| Mindbody | Yes, Public API v6, but per-site activation | Developer account (API key) plus the studio owner activating the integration on their own site (activation link or code), which cannot be automated | Free under 5,000 calls a cycle, then paid per call (sources disagree on the rate) | Yes: Schedule at a Glance and Attendance reports export CSV | developers.mindbodyonline.com; help.grow.com (Mindbody); docs.gymdesk.com/help/mindbodyexports |
| Fresha | **No** public merchant API (partner-only; a public MCP server serves consumer booking only) | — | — | Yes: Sales > Appointments > Export > CSV | supergood.ai/api-report-card/fresha (third party); support.heygoldie.com (Importing from Fresha) |
| Booksy | **No** self-serve API: Booksy Public API is partner-gated (RSA key pair issued to approved partners) | — | — | **No self-service export**: Booksy support sends a CSV on request | support.heygoldie.com (Importing from Booksy); supergood.ai/docs/booksy-api (third party) |
| Treatwell (Connect) | **No** public API found; supplier terms mention APIs only as Treatwell makes them available | — | — | Not documented publicly | treatwell.ie/partners; treatwell.es supplier terms |
| Glofox (ABC Glofox) | Partly: REST API, but credentials are issued by email request to ABC Fitness (`apiactivation@abcfitness.com`) per studio | `x-api-key` + `x-glofox-api-token` + branch id headers | Tied to the subscription (third-party claim) | Reports export, columns not documented | gf-dev-docs.glofox.com/request-access; apis.io/providers/glofox (third party) |
| SimplyBook.me | **Yes**, JSON-RPC API with an API key (the API custom feature), `getToken` exchanges it for a short-lived token. The admin API can also write; there is no read-only key | API key, full admin access | Feature availability depends on plan | Yes: Reports (Client, Detailed) to Excel; save as CSV | support.juvonno.com (Exporting from SimplyBook.me); supergood.ai/api-report-card/simplybook-me |
| Acuity Scheduling | Yes, REST API with user id + API key (basic auth). The key is account-wide, not read-only | API key, paid plan (minimum tier unconfirmed: sources say Emerging or Powerhouse) | Paid plan | Yes: Reports > Import/Export, CSV, optionally with cancelled appointments | help.acuityscheduling.com/hc/articles/16676916553485; docs.coupler.io (third party) |
| Calendly | Yes, API v2: personal access token or OAuth, scoped since 2025; `scheduled_events:read` (+ `invitees:read` for who) | Token with explicitly requested scopes | API on paid plans | Not as a documented appointments CSV | developer.calendly.com/docs/authentication/scopes; developer.calendly.com/personal-access-tokens |
| Timely | Gated: an account-wide API token on paid plans, no public developer docs (sources disagree on token vs OAuth) | Account token or partner OAuth | Paid plan | Yes: Reports > Appointment Schedule > CSV; full exports via support (up to 48 h) | help.gettimely.com/hc/en-gb/articles/20753162121239; support.heygoldie.com (Importing from Timely) |

**What this decided.**

- **Square is the only one connected now.** It is the only platform here with a read-only permission a small business grants itself, verified by the provider (Square reports a token's scopes), so the scope audit is a real check.
- **Mindbody** has a real read API, but needs SYB's own developer account and a per-site activation. Re-judge it when a Mindbody studio asks.
- **SimplyBook.me and Acuity** have APIs, but their keys are full admin keys with no read-only scope. Connecting them would break rule 9's spirit (a key that could write), so they come in by export.
- **Calendly** is scoped and read-only-capable (`scheduled_events:read`) but is a meeting scheduler rather than a salon or gym system; deferred until asked.
- **Everyone else comes in by export.** That is why the import exists, and why its column map is wide.

---

## 2. Square: what is read

The Square connector (`lib/connectors/providers/square.ts`) gains two optional read permissions:

| Permission | Why |
| --- | --- |
| `APPOINTMENTS_READ` | ListBookings. Square's permission table: buyer-level read needs this alone. |
| `APPOINTMENTS_ALL_READ` | Seller-level read: every booking at the seller's locations, not just the ones this application created. Square requires both for seller-level access. |

Both are read-only by name and by Square's own table (the writes are `APPOINTMENTS_WRITE` and `APPOINTMENTS_ALL_WRITE`, which the scope registry would refuse). They are **optional**: a token carrying only the payment permissions still connects and reads payments, and bookings are read only when **both** were granted (the sync passes the granted scopes to the provider). The registry entry is a deliberate change with its reason written beside it; the scope audit test stays green.

**What is read** — `GET /v2/bookings` per window, `start_at_min` / `start_at_max` covering at most 31 days (Square's limit; windows are 30), cursor-paged, no `location_id` (all locations). Per booking, only:

- `id` (the idempotency key), `status`, `start_at`, `location_id` (not stored);
- `customer_id`, turned into a keyed hash before it is stored; the raw id is never written;
- per appointment segment: `service_variation_id`, `team_member_id`, `duration_minutes` (summed).

Never read: `customer_note`, `seller_note`, `address`. Square bookings carry no price, so booking revenue is not measured from Square; the payments read already measures Square takings.

**Statuses** come from `square_api` in the map file. Square has no "completed" status: an `ACCEPTED` booking in the past that the seller did not mark `NO_SHOW` is the attended one, so it counts as completed. `PENDING` in the past was never accepted and is left out. `NO_SHOW` is no-show. Both cancellations and `DECLINED` are cancellations. Square does not separate late cancellations: its `NO_SHOW` docs say it covers a client who "cancelled it without enough notice", so late-cancellation rate is reported as **not separated by Square** rather than zero.

---

## 3. The import

`POST /api/bookings` (signed-in owner only) with the file's text, the platform it came from, the currency of its price column, and the date order when the file's dates need it.

### Columns

Headers are normalised (lower-case, everything outside a–z and 0–9 removed) and matched against the platform's names first, then the generic ones, in `specs/bookings-import-map-v1.json`. Each role takes the first matching column; a column serves one role.

| Role | Used for | Required |
| --- | --- | --- |
| `ref` | the idempotency key | no: without it, a content key is used (below) |
| `start`, or `date` (+ `time`) | the day it counts on | **yes** |
| `status` | the closed status set | **yes**: without it a kept appointment and a no-show look the same, and the import refuses the file rather than guess |
| `service`, `staff`, `duration` | stored as written | no |
| `client_id`, else `client_email`, else `client_phone` | the client key (hashed) | no: without one, rebooking is unmeasured |
| `price` | booking revenue, in the batch currency | no: without it, revenue is unmeasured |
| `cancelled_at` | late cancellation, when the status says only "cancelled" | no |

Names are **not** a client identity: two clients called Anna would merge. A file with names only gets no client key, and rebooking says so.

### Statuses

Normalised to a closed set: `completed`, `no_show`, `cancelled_late`, `cancelled`, `booked_future`.

- A "booked"-type word (booked, confirmed, pending…) on a day **after** the import's date is `booked_future`. On today or earlier it is **left out as not closed out** ("the booking system never recorded what happened"), never assumed completed.
- A plain cancellation with a `cancelled_at` less than **24 hours** (`LATE_CANCEL_HOURS`) before the start is `cancelled_late`. Without that column, it stays `cancelled`.
- An unknown word is left out and counted under its own reason.

### Dates

ISO (`2026-10-01`, `2026-10-01 14:30`, `2026-10-01T14:30:00`), slash or dot dates (`01/10/2026`, `1.10.2026`), and English month names (`1 Oct 2026`, `Oct 1, 2026`). Times: `14:30`, `2:30 PM`. A slash date where both parts are 12 or under is ambiguous: the owner states the order (day first or month first) for the batch, and if the file proves both orders (13/01 and 01/13) the import refuses it. The wall-clock date in the file is the day the appointment counts on; no timezone is applied.

### What is kept, and what is not

- Kept: day, time, status, service, staff, duration, price in minor units with the batch currency (rule 1), and the keyed client hash.
- **Never kept: client names, emails or phone numbers.** The client key is HMAC-SHA256 under a key derived from the server secret (`derivedKey("bookings-client-v1")`), over the account id, the identity kind and the normalised value. It shows that the same client came back and cannot be reversed. Erasing a customer on `/customers` also clears the client key computed from their email or phone (rule 22's spirit).
- Unreadable rows are **counted and left out**, never guessed: no date, an unreadable date, no status, an unknown status, a past booking never closed out, an unreadable price, a duplicate inside the file.

### Idempotency

One row per `(connection, source_ref)`, a unique index. `source_ref` is the platform and the file's own reference when it has one (`fresha:ref:B-1042`), otherwise a content key: a hash of the day, time, client key, service and staff. Re-importing an overlapping export updates the rows it already has (a booking that has since been completed changes status) and adds only the new ones; the daily measures are then recomputed from the table for every day the file touched, so nothing is counted twice.

### Provenance

Every account has at most one import source, a `connections` row with provider `bookings_import`, purpose `measure`, no secret and no scopes. It is never pulled by the sync runner and never listed as a connection. Each file is a `booking_imports` row (platform, currency, time, counts, the columns understood). The measured facts name the series as `connector:bookings_import:<metric>` (so they read as measured), and their note and method say "bookings export from Fresha, imported 2026-10-22". The batch is one decision-log entry (`import`), counts and a hash, no PII.

---

## 4. The measures

Deterministic arithmetic (`lib/bookings/measures.ts`), no model.

**Daily series** (`metric_observations`, every day from the first to the last appointment day, up to yesterday, zeros included):

| Metric | What |
| --- | --- |
| `appointments_completed.daily` | completed appointments that day |
| `appointments_no_show.daily` | no-shows |
| `appointments_cancelled_late.daily` | late cancellations (not emitted for Square, which does not separate them) |
| `appointments_cancelled.daily` | other cancellations |
| `booking_revenue.daily` | price of completed appointments, per currency (only when the source has prices) |

`appointments_completed.daily` and `booking_revenue.daily` are watched by the anomaly layer like orders and revenue. The no-show and cancellation counts are **not**: small daily counts are mostly zeros and a single no-show would read as a spike, so they are judged as 28-day rates instead.

**28-day measures**, over the 28 days ending on the latest measured day (four whole weeks, so every weekday counts four times):

| Measure | Arithmetic | Thresholds |
| --- | --- | --- |
| Appointments completed | count of `completed` | — |
| No-show rate | no-shows ÷ due, where due = completed + no-show + late-cancelled (the slots that were still held when the time came) | needs `MIN_DUE_APPOINTMENTS` = 20 due appointments; below that, "too few to call a rate" |
| Late-cancellation rate | late cancellations ÷ due | the same 20; "not separated" for Square |
| Rebooking rate | of clients with a completed appointment in the cohort window (the 28 days ending `REBOOK_DAYS` = 42 days before the latest day, so every one had a full 42 days to come back), the share with another booking that was kept or still held (completed, no-show, late-cancelled or booked) starting within 42 days after it | needs `MIN_REBOOK_CLIENTS` = 10 clients in the cohort; unmeasured when the source has no client identity |
| Revenue from bookings | sum of completed appointments' prices | one currency only; two in the window is a refusal (rule 1) |
| Utilisation | completed ÷ (stated weekly capacity × 4) | **only** when the owner stated `service.capacity_per_week` (question 1.4.2.3b, appointments a week) above zero. Otherwise unmeasured, and the screen says so: it is never assumed |

All thresholds are pinned in code with boundary tests both ways.

**Profile facts** (written as measured, superseding through the ordinary path, rule 3):

| Field | Value | Supersedes |
| --- | --- | --- |
| `service.no_show_rate` | the measured rates in words: "6.1% no-shows and 2.0% late cancellations, of 245 due appointments, 2026-09-24 to 2026-10-21" (the bank's own type is long text, 1.4.2.3c) | the owner's own words about no-shows, shown beside it (rule 11) |
| `revenue.repeat_customer_rate` | rebooking rate, a percentage (the bank asks 0–100, 4.1d) | the owner's estimate, with the delta |
| `service.appointments_completed_28d` | number | measured only |
| `service.no_show_rate_28d`, `service.late_cancellation_rate_28d` | percentages | measured only |
| `service.booking_revenue_28d` | Money | measured only |
| `service.utilisation_28d` | percentage, only with stated capacity | measured only |

Booking revenue deliberately does **not** supersede `revenue.monthly_revenue`, and completed appointments do not supersede `revenue.order_count_monthly`: a booking system's list price is not takings (no tips, products, discounts or unpaid no-show fees), and a Square or Stripe connection measuring takings would fight it for the same field. They stay their own facts, on the fact sheet and in the report's stated-against-measured table where they replaced something the owner said.

A rate on fewer than the minimums is a refusal with the count, never a fact.

---

## 5. The screen

`/connections`, under the sources panel, in its own sheet ("Import bookings"): that is where the owner's other measured sources live. `/customers` imports contacts under a consent attestation, a different act with different rules, and mixing the two would put a booking file under a consent statement it does not need.

It shows: the platform picker, the currency of the price column, the date order when it matters, then, after an import, the columns it understood (role → header as written), what it added, updated and left unchanged, everything it left out by reason, and the 28-day measures with their arithmetic, or the plain reason a measure is not measured.

---

## 6. What is unverified

- **Every export's headers.** No platform publishes its appointment export's column list; the platform names in the map file are marked `verified: false`. The first real export from each platform should be checked against them, and the map file extended (it is data).
- **Square Bookings with a real token**: whether a personal access token reports `APPOINTMENTS_ALL_READ`, and whether a location without an Appointments plan returns an empty list or an error.
- **Square's 31-day range limit** is from Square's guide; the reference page lists it only as the default.
