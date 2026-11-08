# TikTok Marketing API — v1 (TikTok Ads, read and act)

What SYB's TikTok Ads code relies on — the OAuth exchange (`lib/tiktok/login.ts`), the request
fence (`lib/tiktok/api.ts`), the daily read (`lib/tiktok/read.ts`) and the executor
(`lib/execution/providers/tiktok-ads.ts`) — and where each fact came from. Researched 2026-11-08 from
TikTok's own pages: the TikTok API for Business documentation (read through the portal's own
document service, `business-api.tiktok.com/gateway/api/doc/client/node/get/v2/`, which serves the
same text the portal renders) and TikTok's official SDK repository (`github.com/tiktok/tiktok-
business-api-sdk`). Every line is marked **verified: true** (read on one of those pages that day)
or **verified: false** (not found there, inferred, or contradicted between TikTok's own pages).
Nothing here was tested against the live API: no app existed when it was written, and every test
uses a fake HTTP layer with the global fetch stubbed to fail if touched.

Sources (TikTok's own):

- Authorization — portal doc 1738373141733378
- Authentication (`/oauth2/access_token/`) — portal doc 1738373164380162
- Permission scope — portal doc 1753986142651394
- Create a developer app — portal doc 1738855242728450
- Sandbox accounts (to be deprecated) — portal doc 1738855331457026
- Run a synchronous report (`/report/integrated/get/`) — portal doc 1740302848100353
- Supported metrics (basic reports) — portal doc 1751443967255553
- Get ad account details (`/advertiser/info/`) — portal doc 1739593083610113
- Get campaigns (`/campaign/get/`) — portal doc 1739315828649986
- Update a campaign (`/campaign/update/`) — portal doc 1739320422086657
- Update the operation statuses of campaigns (`/campaign/status/update/`) — portal doc 1739320994354178
- Budget — portal doc 1739381246298114
- Budget verification ratio and value range for each currency — portal doc 1737585839634433
- Return codes — portal doc 1737172488964097
- Official SDK, `python_sdk/business_api_client/api/*.py` and `python_sdk/docs/*.md`

## The developer app and its review

| Fact                                                                                                                                    | verified |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A developer app needs an approved TikTok For Business developer profile first                                                           | true     |
| The app names an advertiser redirect URL (up to 10, localhost allowed) and selects its "Scope of permission"                            | true     |
| Submitting the app sends it for review, which "may take 2 to 3 business days"; tokens work once the app is approved                     | true     |
| App ID and Secret are under My Apps → App Detail → Basic Information, beside the "Advertiser authorization URL"                         | true     |
| The advertiser authorization URL is `https://business-api.tiktok.com/portal/auth?app_id=…&state=…&redirect_uri=…`                       | false    |
| The sandbox base URL is `https://sandbox-ads.tiktok.com/open_api`; sandbox accounts "will be deprecated by December 1st, 2026"           | true     |
| TikTok has no Meta-style access tier header; the app is either under review or approved, and a sandbox app only reaches sandbox accounts | false    |

## Authorization and the token

| Fact                                                                                                                                        | verified |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| The advertiser sees "a list of permissions that you selected when creating your developer application", reviews them and clicks Confirm    | true     |
| The advertiser verifies by an emailed code; TikTok then redirects to the redirect URL with `auth_code` (and `state`) in the query           | true     |
| `auth_code` is valid for one hour and can be used once                                                                                      | true     |
| `POST /open_api/v1.3/oauth2/access_token/`, JSON body `{app_id, secret, auth_code}`, header `Content-Type: application/json`                | true     |
| The response is `{code, message, request_id, data: {access_token, advertiser_ids: string[], scope: number[]}}`; `code` 0 is success          | true     |
| "A long-term access token does not expire", but becomes invalid when the advertiser cancels the authorization                              | true     |
| "You can access the endpoints according to the permissions that are granted by the advertiser"                                             | true     |
| An advertiser can untick some of an app's permissions on the authorization page                                                            | false    |
| The token is sent as the header `Access-Token: <token>` on every other call (the SDK sets `header_params['Access-Token']`)                  | true     |

**Decision this table forces (read vs write).** TikTok's permissions are separable _per app_
(each has its own scope id: Reporting, Read Campaigns, Create and Update Campaigns …), but an
advertiser authorizes the app's whole list, and SYB has one app (`TIKTOK_ADS_APP_ID`). To act —
pause, resume, change a budget — that app must hold "Create and Update Campaigns", so every token
it issues can write. The reporting permission therefore cannot be separated from the write
permission, and TikTok Ads is held the I-45a way: one **execute-purpose consent** (`tiktok_ads` in
`EXECUTION_SCOPE_REGISTRY`), never in the measurement registry (rule 9 unchanged), with the daily
read fenced to three GET endpoints by a failing test (`lib/tiktok/api.test.ts`,
`lib/tiktok/read.test.ts`). If TikTok later shows that an advertiser can grant a reporting-only
subset, a read-only measure connection can be added beside it from a second, read-only app.

## Permission scope ids SYB expects

TikTok reports `scope` as numeric ids at three levels; a first-level id grants everything under
it. SYB names each id it knows (`lib/tiktok/scopes.ts`) and the connection must carry EXACTLY the
registry's set — one more or fewer is refused by name (P3-20b).

| Scope id | TikTok's name                                                          | SYB's registry name                   | Kind     | verified |
| -------- | ---------------------------------------------------------------------- | ------------------------------------- | -------- | -------- |
| 100      | Read Ad Account Information (`/advertiser/info/`, `/oauth2/advertiser/get/`) | `tiktok.read_ad_account_information` | readback | true     |
| 200      | Read Campaigns (`/campaign/get/` …)                                    | `tiktok.read_campaigns`               | readback | true     |
| 44       | Consolidated Report (`/report/integrated/get/`, report tasks and subscriptions) | `tiktok.consolidated_report`  | readback | true     |
| 201      | Create and Update Campaigns (`/campaign/update/`, `/campaign/status/update/` …) | `tiktok.create_and_update_campaigns` | write | true |
| 1, 2, 4  | Ad Account Management, Ads Management, Reporting (first level: everything under them) | named, and refused as extra | —   | true     |
| —        | The app's "Scope of permission" can be ticked at the third level (100, 200, 201) and second level (44) | —     | —        | false    |

Consolidated Report (44) also covers creating report tasks and report subscriptions. Those write
nothing to campaigns, budgets or money, and SYB calls neither (the fence allows only
`/report/integrated/get/`).

## The read

| Fact                                                                                                                                                       | verified |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `GET /open_api/v1.3/advertiser/info/?advertiser_ids=[…]&fields=[…]`; `fields` includes `currency`, `timezone`, `name`                                      | true     |
| `GET /open_api/v1.3/report/integrated/get/` with `report_type=BASIC`, `data_level=AUCTION_CAMPAIGN`, `dimensions=["campaign_id","stat_time_day"]`          | true     |
| Array parameters are sent as JSON strings in the query (the docs' curl examples: `dimensions=["ad_id_v2","stat_time_day"]`)                                | true     |
| With `stat_time_day` the range is at most 30 days; dates are `YYYY-MM-DD` in the ad account's time zone                                                    | true     |
| `page_size` 1–1,000; `data.page_info.total_page` says how many pages                                                                                       | true     |
| Each row is `{dimensions: {campaign_id, stat_time_day: "2020-01-01 00:00:00"}, metrics: {…}}`, every metric a string                                       | true     |
| `spend` — "Sum of your total ad spend", a decimal string in the account currency                                                                         | true     |
| `campaign_name`, `currency` are available as metrics (currency needs a `campaign_id`/`advertiser_id` dimension)                                          | true     |
| `complete_payment` — "Number of website purchase actions attributed to your ads"                                                                         | true     |
| `total_complete_payment_rate` — "Total value of website purchase actions attributed to your ads" (the purchase VALUE, despite its name)                   | true     |
| `complete_payment_roas` — "Return on ad spend (ROAS) from website purchase actions" (SYB recomputes ROAS from value ÷ spend instead of storing it)        | true     |
| `conversion` — "Number of times your ad resulted in the optimization event you selected" (not stored: it isn't purchases)                                | true     |
| A day with no row for a campaign means it didn't run that day; the account-level day is then zero spend                                                  | false    |
| Attribution keeps landing for days after a click, so SYB re-reads the last 8 days (Meta's window, kept)                                                  | false    |

## The writes (only through the execution engine, only with `SESSION_D_REAL_WRITES=on`)

| Fact                                                                                                                                          | verified |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `GET /open_api/v1.3/campaign/get/?advertiser_id=…&filtering={"campaign_ids":[…]}` returns `data.list[]` with `campaign_id`, `campaign_name`, `budget`, `budget_mode`, `operation_status` | true |
| `POST /open_api/v1.3/campaign/status/update/`, JSON `{advertiser_id, campaign_ids (1–20), operation_status}`                                 | true     |
| `operation_status` is `ENABLE`, `DISABLE` (pause) or `DELETE`; "the status of deleted campaigns cannot be modified" — SYB never sends DELETE  | true     |
| `POST /open_api/v1.3/campaign/update/`, JSON `{advertiser_id, campaign_id, budget}`; `budget` is a float in the account currency's major units | true   |
| `budget_mode` is `BUDGET_MODE_INFINITE`, `BUDGET_MODE_TOTAL`, `BUDGET_MODE_DAY` or `BUDGET_MODE_DYNAMIC_DAILY_BUDGET`; SYB re-budgets `BUDGET_MODE_DAY` only | true |
| "The new budget should be at least 105% of the current spend" — a cut below that is TikTok's refusal, shown as it came                        | true     |
| Budget precision per currency: 0.01, or whole units for HUF, JPY, KRW, CLP, ISK, IDR, PYG, VND (the table in `lib/tiktok/budget.ts`)          | true     |
| Campaign minimum daily budget = 50 × the currency's budget verification ratio (USD 50, EUR 50, HUF 50, JPY 5,000)                             | true     |
| …but the Budget page says campaign daily budgets "must be at least 20 USD": TikTok's two pages disagree; SYB uses the higher (50 × ratio)      | false    |
| There is no dry-run (`validate_only`) option on these endpoints: SYB re-reads the campaign and runs its own guards instead                    | false    |
| Setting a status or budget to the value it already has is harmless, so a retried write is safe                                              | false    |

## Errors

| Code(s)                     | Meaning (TikTok's words, shortened)                         | SYB's handling                      | verified |
| --------------------------- | ----------------------------------------------------------- | ----------------------------------- | -------- |
| 0                           | OK                                                          | —                                   | true     |
| 40100, 40016, 40133         | Requests made too frequently (app / endpoint / advertiser)   | retried, at most 3 attempts in all  | true     |
| 50000, 50002                | System error / error processing the request on TikTok's side | retried, at most 3 attempts in all  | true     |
| 40102, 40104, 40105, 40106  | Access token expired / empty / invalid / core user invalid   | "reconnect TikTok"                  | true     |
| 40101                       | Secret and app ID don't match, or the auth code is invalid   | the sign-in fails, nothing stored   | true     |
| 40001                       | No permission to perform the operation                       | "the token can't do that"           | true     |
| 40000, 40002                | Invalid parameters                                           | refused, TikTok's message shown     | true     |
| 40007                       | The object doesn't exist                                     | "TikTok has no such campaign"       | true     |
