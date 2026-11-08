# Google Ads API — what SYB relies on (v1)

P2-20 (the daily read) and P3-22's Google half (pause, resume and daily
budget, through the execution engine). Owner decision 2026-11-08: "build
google ads too".

Every fact the code relies on is listed here, read in Google's own
documentation on **2026-11-08**, with `verified: true` when a Google page
stated it and `verified: false` when the pages read did not (the code then
takes the safe reading and says so in a comment). Nothing here was
confirmed against a real ad account: SYB's Cloud project has no Google Ads
access level beyond Test yet. Re-check every `verified: false` line on the
first real connection.

Pages read: release-notes, sunset-dates, rest/overview, rest/common/search,
rest/common/mutate, rest/design/json-mappings, docs/oauth/overview,
api-policy/access-levels, api-policy/developer-token,
concepts/call-structure, concepts/field-service, get-started/make-first-call,
get-started/handle-errors, campaigns/budgets/create-budgets, and the v26
reference for GoogleAdsService/Search, SearchGoogleAdsRequest,
CustomerService/ListAccessibleCustomers, Campaign, CampaignBudget,
CampaignStatusEnum, Metrics, Segments and Customer (all under
developers.google.com/google-ads/api).

## Version and base URL

| Fact                                                                                         | verified |
| -------------------------------------------------------------------------------------------- | -------- |
| Newest version is v26 (2026-10-14; v26.1 on 2026-10-28), sunset November 2027               | true     |
| Supported: v23 (to Feb 2027), v24 (May/June 2027), v25 (Aug 2027), v26 (Nov 2027)            | true     |
| REST base `https://googleads.googleapis.com/v26/customers/{customerId}/…`                    | true     |
| A customer id is ten digits, sent without hyphens                                            | true     |

`lib/google-ads/client.ts` pins `GOOGLE_ADS_API_VERSION = "v26"`; the fence
anchors that version, so moving to v27 is a deliberate one-line change plus
this table.

## Authentication

| Fact                                                                                                     | verified |
| -------------------------------------------------------------------------------------------------------- | -------- |
| The only scope is `https://www.googleapis.com/auth/adwords`                                              | true     |
| There is no read-only scope (none appears on any page; "Reporting" use is a policy category, not a scope) | true     |
| `Authorization: Bearer <access token>`; tokens last one hour                                              | true     |
| `login-customer-id`: the manager's id, ten digits without hyphens, only when reaching an account through a manager; omitted for direct access | true |
| `linked-customer-id`: only for partner/product-link calls (SYB never sends it)                            | true     |
| Developer tokens were retired on 2026-09-09; sending one is optional and ignored                         | true     |
| The header name `developer-token`                                                                         | false    |
| Access belongs to the Google Cloud project that owns the OAuth client                                     | true     |
| A Test-level project calling a real account gets `AuthorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` (v25+) | true |
| OAuth for web servers: offline access with `prompt=consent` returns a refresh token; the token answer's `scope` lists what was granted | true (Google's OAuth pages, read for I-45a on 2026-11-01) |

SYB therefore holds `adwords` as a **write consent** (`google_ads` in
`lib/execution/scopes.ts`), never in the measurement registry, and the
measurement audit refuses it by name (`/\/auth\/adwords$/` in
`WRITE_CAPABLE`).

## Access levels (shown on the connection card as `GOOGLE_ADS_ACCESS_LEVEL`)

| Level    | What Google allows                                                       | verified |
| -------- | ------------------------------------------------------------------------ | -------- |
| Test     | Test accounts only; 15,000 operations a day; automatic when the API is enabled | true |
| Explorer | Test and real accounts; 2,880 operations a day on real accounts          | true     |
| Basic    | 15,000 operations a day; brand verification first                        | true     |
| Standard | No daily cap beyond per-feature rate limits; manual audit, ~10 business days | true |
| Applied for on the Google Ads API overview page in Cloud Console, not API Center | true |
| The daily limit is a sliding 24-hour window                              | true     |
| A manager account is no longer needed to start                           | true     |

## Reading (P2-20)

| Fact                                                                                                     | verified |
| -------------------------------------------------------------------------------------------------------- | -------- |
| `POST …/customers/{id}/googleAds:search`, body `{query, pageToken}`                                      | true     |
| `pageSize` is refused (`PAGE_SIZE_NOT_SUPPORTED`); pages are 10,000 rows                                 | true     |
| Answer: `results`, `nextPageToken` (only when more remain), `fieldMask`                                  | true     |
| `POST …/googleAds:searchStream` answers a JSON array of batches (built into the fence, not used yet)     | true     |
| `customers:listAccessibleCustomers` returns the resource names the user reaches directly                 | true     |
| …its REST method (GET) and path `/v26/customers:listAccessibleCustomers`, answer `resourceNames`         | false    |
| REST JSON is lowerCamelCase (`metrics.costMicros`, `campaignBudget.amountMicros`); GAQL stays snake_case  | true     |
| int64 fields arrive as JSON strings (proto3 canonical mapping)                                           | false — `readInt64` accepts a string or a number |
| `segments.date` is `yyyy-MM-dd`                                                                          | true     |
| `segments.date` is in the account's time zone                                                            | false    |
| GAQL `WHERE segments.date BETWEEN 'a' AND 'b'`                                                           | false    |
| `campaign.id` int64, `campaign.name` string, `campaign.status` ENABLED / PAUSED / REMOVED                 | true     |
| `metrics.cost_micros` int64                                                                              | true     |
| `metrics.cost_micros` is in the account currency, 1,000,000 micros a unit                                | false (stated for budgets only) |
| `metrics.clicks` int64; `metrics.conversions` double (actions counted in "Conversions")                  | true     |
| `metrics.conversions_value` double                                                                       | true     |
| `metrics.conversions_value` is in the account currency                                                   | false    |
| `customer.currency_code` (immutable), `customer.time_zone`, `customer.descriptive_name`, `customer.manager` | true  |

What SYB reads (`lib/google-ads/read.ts`):

```
SELECT customer.id, customer.descriptive_name, customer.currency_code,
       customer.time_zone, customer.manager FROM customer

SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros,
       metrics.clicks, metrics.conversions, metrics.conversions_value
FROM campaign WHERE segments.date BETWEEN '<from>' AND '<to>'
```

Money: micros → integer minor units of the account currency, rounded half
away from zero, a day's campaigns summed in micros first (rule 1). A row in
another currency than the one consented is refused. Google's conversions
are not necessarily purchases, so they are their own series
(`ad_conversions.*`) and never `ad_purchases.daily`; the conversion value
is the ROAS numerator (`ad_purchase_value.campaign.daily`), worded as
"conversion value Google attributes".

## Changing (P3-22, Google half)

| Fact                                                                                                     | verified |
| -------------------------------------------------------------------------------------------------------- | -------- |
| `POST …/customers/{id}/campaigns:mutate` and `…/campaignBudgets:mutate`                                  | true     |
| Body `{operations:[{update:{resourceName,…}, updateMask}]}`; `updateMask` sits beside `update`            | true     |
| An update mask lists fields comma-separated ("name,status" in Google's example)                          | true     |
| A status-only mask `"status"`                                                                            | false (follows the example) |
| The budget mask written `"amountMicros"` (proto3 JSON writes FieldMask paths in lowerCamelCase)          | false    |
| `validateOnly: true` on a mutate request (a dry run)                                                     | false (stated for search) |
| Answer `{results:[{resourceName}]}`                                                                      | false (shown in client code, not REST JSON) |
| Resource names `customers/{c}/campaigns/{id}`, `customers/{c}/campaignBudgets/{id}`                       | true     |
| `campaign_budget.amount_micros`: "micros in the account's local currency; one million micros is one unit" | true    |
| Monthly spend is capped at 30.4 × the daily amount                                                        | true     |
| `campaign_budget.explicitly_shared` (default true on create): a shared budget serves several campaigns   | true     |
| Total budgets are `CUSTOM_PERIOD` (need `explicitly_shared=false`, start and end dates)                  | true     |
| The `campaign_budget.period` field name                                                                  | false    |
| A budget must be a multiple of the currency's smallest unit                                              | false — SYB sends whole minor units only |
| A minimum daily budget                                                                                   | false — none assumed; the dry run refuses what Google won't take |

Guardrails, in code, at generation and again in the executor: ±50% of the
budget captured before attempt one, the owner's stated monthly ceiling over
the whole account (every platform in that currency, never converted), a
shared or non-daily budget refused by name, removed campaigns never
touched, re-activation held to the ceiling, the emergency stop checked
between the dry run and the change, and the real-write gate
(`SESSION_D_REAL_WRITES=on`). The only fields written are `status` and
`amountMicros`; nothing touches billing (rule 18).

## Errors

| Fact                                                                                                     | verified |
| -------------------------------------------------------------------------------------------------------- | -------- |
| Body `{error:{code, message, details:[{"@type":"…GoogleAdsFailure", errors:[{errorCode:{…}, message}], requestId}]}}` | true |
| `USER_PERMISSION_DENIED` when a manager-reached call lacks `login-customer-id`                             | true     |
| HTTP 401 auth, 403 permission, 429 quota (RESOURCE_EXHAUSTED)                                            | false — mapped as usual for Google APIs |
| `errorCode` keys `authenticationError`, `authorizationError`, `quotaError`                                | false — SYB matches the error names as text |
