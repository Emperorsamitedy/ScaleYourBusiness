# Higgsfield API — v1 (P6-03)

What SYB's Higgsfield provider (`lib/content/generate/higgsfield.ts`) relies on, and where each
fact came from. Researched 2026-11-08 from Higgsfield's own pages. Every line is marked
**verified: true** (read on a Higgsfield page that day) or **verified: false** (not found on
Higgsfield's pages, inferred, or contradicted between their pages). Nothing here was tested
against the live API: no key existed when it was written, and every test uses a fake HTTP layer.

Sources (Higgsfield's own):

- [The API launch post](https://higgsfield.ai/blog/generate-ai-videos-higgsfield-api)
- [The API landing page](https://higgsfield.ai/higgsfield-api)
- [Docs home](https://docs.higgsfield.ai/docs)
- [Request lifecycle](https://docs.higgsfield.ai/docs/concepts/requests.md)
- [Errors](https://docs.higgsfield.ai/docs/concepts/errors.md)
- [Get request status](https://docs.higgsfield.ai/docs/api-reference/requests/get-request-status.md)
- [Kling 3.0 workflows](https://docs.higgsfield.ai/docs/models/kling-3.md)
- [Kling 3.0 Pro, text to video](https://docs.higgsfield.ai/docs/models/kling-3/pro-text-to-video.md)

## Access and billing

| Fact                                                                                          | verified |
| --------------------------------------------------------------------------------------------- | -------- |
| The API is separate from the higgsfield.ai web plans: a web plan's credits don't pay for it    | true     |
| Billing is a prepaid USD balance, pay per generation, "no subscriptions and no seats"          | true     |
| The balance can't go below zero; auto top-up exists; top-ups are valid for a year              | true     |
| Failed and moderated (`nsfw`) requests are not billed; a reserved amount is refunded           | true     |
| Keys are created in Higgsfield's API console (console.higgsfield.ai / open.higgsfield.ai)      | true     |
| A key is an ID plus a secret, shown whole once, at creation                                    | true     |
| 20 concurrent requests per key (SYB sends at most 3 at once)                                   | true     |
| The status response carries no cost field: SYB records the published price as the charge      | false    |

## Authentication

| Fact                                                                          | verified |
| ----------------------------------------------------------------------------- | -------- |
| Header `Authorization: Key <key_id>:<key_secret>` on every call to the API    | true     |
| `Content-Type: application/json` on submissions                               | true     |
| `Idempotency-Key` header on submissions; resubmitting with it is safe         | true     |
| A reused key with different parameters is refused with 422                    | true     |

SYB's env: `HIGGSFIELD_API_KEY` (the key id, or the whole `id:secret`) and
`HIGGSFIELD_API_SECRET`. Higgsfield's own examples name them `HF_API_KEY_ID` and
`HF_API_KEY_SECRET`; SYB's names follow its own convention.

## The flow: submit, then poll

| Step                                                                                                      | verified |
| --------------------------------------------------------------------------------------------------------- | -------- |
| Base URL `https://api.higgsfield.ai`                                                                      | true     |
| Submit: `POST https://api.higgsfield.ai/<model endpoint>` with the model's JSON body                      | true     |
| The answer: `status` ("queued"), `request_id` (uuid), `status_url`, `cancel_url`, `expires_after`         | true     |
| Poll: `GET <status_url>` (= `/requests/{request_id}/status`) → a `RequestStatus`                          | true     |
| Statuses: `queued`, `in_progress` (not terminal); `completed`, `failed`, `nsfw`, `canceled` (terminal)    | true     |
| Completed video: `video.url`; `expires_at` says when the output is deleted (at least seven days)          | true     |
| `failed` and `nsfw` carry `error` (string or null)                                                        | true     |
| Cancel: `POST <cancel_url>` → 202 while queued; 400 once processing started                               | true     |
| Webhooks exist instead of polling; the parameter's name and payload weren't on the pages read             | false    |
| A recommended polling interval                                                                            | false    |
| The output file is an MP4 (SYB checks for an ISO-BMFF `ftyp` box and refuses anything else)               | false    |

SYB polls every 5 seconds, at most 45 times (inside a 300-second function), submits at most
twice per attempt (the second only after a dropped connection, with the same `Idempotency-Key`),
and at most `MAX_GENERATION_ATTEMPTS` (2) attempts per candidate. At the poll cap it cancels; a
cancel that isn't accepted means the run may still be billed, so it is counted as spent.

## Errors

| HTTP | Meaning (Higgsfield's)                                    | SYB                                 | verified |
| ---- | --------------------------------------------------------- | ----------------------------------- | -------- |
| 400  | Invalid parameters or rejected input                      | stop, say so                        | true     |
| 401  | Missing or invalid credentials                            | stop: "check HIGGSFIELD_API_KEY"    | true     |
| 403  | **Insufficient balance**                                  | stop: "top it up in the console"    | true     |
| 404  | Request or model not found for this account               | stop                                | true     |
| 409  | Request still running (delete only)                       | not used                            | true     |
| 422  | Validation failed / idempotency key reused differently    | stop                                | true     |
| 423  | Model temporarily blocked                                 | another attempt, unbilled           | true     |
| 429  | Account queue full / endpoint limit                       | another attempt, unbilled           | true     |
| 500  | Unexpected server error                                   | another attempt, unbilled           | true     |
| 503  | Model disabled, or queue admission unavailable            | another attempt, unbilled           | true     |

Error bodies are `{"detail": "..."}` (a list for some validation errors) — verified: true.

## The model: Kling 3.0 Pro, text to video

**Chosen for realistic footage:** `kling-video/v3.0/pro/text-to-video` (`HIGGSFIELD_MODEL`
changes it). Higgsfield's pages make **no realism claim for any model** (verified: false that it
is the most photorealistic). It was chosen because Kling 3.0 is the family Higgsfield's own
launch post features, Pro is its higher-quality text-to-video tier with a documented schema,
and SYB's prompt asks for phone-like, natural-light footage rather than a "cinematic" look.
Kling 3.0's 4K workflow (`kling-video/v3.0/4k/text-to-video`) exists but has no published API
price, so it isn't the default. Judge the first real candidates by eye before changing it.

| Field (request body)                | Type / values                         | SYB sends   | verified |
| ----------------------------------- | ------------------------------------- | ----------- | -------- |
| `prompt`                            | string, up to 2,500 characters        | facts + fixed instruction | true |
| `duration`                          | integer seconds, 3–15, default 5      | 5           | true     |
| `aspect_ratio`                      | "16:9", "9:16", "1:1"                 | "9:16"      | true     |
| `sound`                             | "on" / "off", default "on"            | "off"       | true     |
| `cfg_scale`                         | 0–1, default 0.5                      | not sent    | true     |
| `multi_shots`, `multi_prompt`, `elements` | —                               | not sent    | true     |
| A resolution or mode field          | none documented for this workflow     | —           | true     |

Another model's body is sent as `prompt`, `duration`, `aspect_ratio` (the shape on the API
landing page's Seedance example) — verified: false for any model but Kling 3.0 Pro.

## Price

| Source (Higgsfield's)                        | Kling 3.0 per second                       | verified |
| -------------------------------------------- | ------------------------------------------ | -------- |
| API launch post                              | $0.112                                     | true     |
| API landing page (launch offer)              | $0.042, struck-through from $0.084         | true     |
| Which applies to Pro text-to-video, today    | not stated; the two pages disagree         | false    |

SYB budgets at the **higher** published figure, $0.112 a second
(`HIGGSFIELD_USD_MICROS_PER_SECOND=112000`), so the caps hold whichever is right:

- one 5-second candidate: 5 × $0.112 = **$0.56** (56 US cents, rounded up to the cent)
- one brief's three candidates: **$1.68**; at most $3.36 if every candidate needs its second attempt
- at the launch-offer price ($0.042/s) the same set would be about $0.63

## SYB's limits

- Per business, per UTC calendar month: `HIGGSFIELD_MONTHLY_CAP_MINOR`, US cents, default 6000
  ($60) — checked when proposing, again before anything is submitted, and before every retry.
- Per item, every set and retry together: $10 (`HIGGSFIELD_ITEM_CAP_MINOR` in code).
- Money is never converted: Higgsfield's caps are in USD, the fake's in EUR, each against its own
  ledger rows.
