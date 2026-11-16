# Google Business Profile API — what SYB relies on (v1)

I-45a: reading reviews (decided 2026-11-01, "as a write consent"), and since
the owner lifted I-45a on **2026-11-16** ("make all these automatic all the
owner should do is just approve", then "Google review replies + hours"):
posting a reply the owner approved under one review, and moving one opening
or closing time on the listing's regular hours after the owner approved that
exact change. Both writes run only through the execution engine
(`lib/execution/providers/google-business.ts`), behind the Session D
real-write gate, capped at station 3 on the trust ladder.

Every fact the code relies on is listed here, with `verified: true` when a
Google reference page stated it (read **2026-11-16**, the reads also on
2026-11-01) and `verified: false` when the pages read did not. Nothing here
was confirmed against a real Business Profile: SYB's Google project has no
approved Business Profile API access yet. Re-check every `verified: false`
line on the first real connection.

Pages read (developers.google.com/my-business/reference): rest/v4
accounts.locations.reviews (the resource, get, list, updateReply,
deleteReply); businessinformation/rest/v1 locations (get, patch) and
accounts.locations (the Location resource: BusinessHours, TimePeriod).

## Scope

| Fact                                                                                              | verified |
| ------------------------------------------------------------------------------------------------- | -------- |
| One scope covers the Business Profile APIs: `https://www.googleapis.com/auth/business.manage`     | true     |
| updateReply and deleteReply accept `business.manage` (or the legacy `plus.business.manage`)       | true     |
| locations.get and locations.patch require `business.manage`                                       | true     |

## Reviews

| Fact                                                                                                                      | verified |
| ------------------------------------------------------------------------------------------------------------------------- | -------- |
| reviews.list: `GET https://mybusiness.googleapis.com/v4/{parent=accounts/*/locations/*}/reviews`, pageSize ≤ 50           | true     |
| reviews.get: `GET https://mybusiness.googleapis.com/v4/{name=accounts/*/locations/*/reviews/*}`; NOT_FOUND once deleted   | true     |
| A Review carries `reviewReply` (a ReviewReply) when the owner or a manager has replied                                    | true     |
| ReviewReply is `{comment, updateTime, reviewReplyState, policyViolation}`; SYB sends `comment` only                        | true     |
| updateReply: `PUT …/{name=accounts/*/locations/*/reviews/*}/reply`, body a ReviewReply; creates the reply if none exists | true     |
| updateReply and deleteReply work only for a verified location                                                             | true     |
| deleteReply: `DELETE …/reviews/*/reply`, empty body, answers an empty JSON object                                         | true     |
| The longest reply Google accepts (SYB caps at 4 000 characters, label included)                                           | false    |
| Whether a reply passes through moderation (`reviewReplyState`) before it shows publicly                                   | false    |

## Regular hours

| Fact                                                                                                                                                  | verified |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| locations.get: `GET https://mybusinessbusinessinformation.googleapis.com/v1/{name=locations/*}`, `readMask` REQUIRED                                 | true     |
| locations.patch: `PATCH …/v1/{location.name=locations/*}`, `updateMask` REQUIRED; only the named fields change                                       | true     |
| `validateOnly=true` validates without updating, and answers empty when valid                                                                          | true     |
| `regularHours` is a BusinessHours: `{periods: TimePeriod[]}`                                                                                          | true     |
| A TimePeriod is `{openDay, openTime, closeDay, closeTime}`; days are DayOfWeek (MONDAY … SUNDAY); times TimeOfDay `{hours, minutes}`                  | true     |
| Times run 00:00–24:00; 24:00 is midnight at the end of that day; zero values are omitted in JSON (`{}` for 00:00)                                     | true     |
| The close must come after the open, later the same day or on a later day                                                                             | true     |
| Sending the whole `periods` list with `updateMask=regularHours` replaces it exactly (no per-period patch)                                              | false    |
| A midnight close may be returned as 24:00 the same day or 00:00 the next (SYB reads both as the same time)                                           | false    |
| A regularHours change shows on Maps without review delay                                                                                              | false    |

## What SYB writes, and nothing else

`lib/google-business/client.ts`'s endpoint list is the whole of it, and
`client.test.ts` fails the build on any other path, verb or update mask:

- `PUT …/reviews/{r}/reply` and `DELETE …/reviews/{r}/reply` — one review's reply;
- `PATCH …/v1/locations/{l}?updateMask=regularHours` (optionally
  `&validateOnly=true`) — the regular hours, and no other field of the listing.

The three write helpers are called from the executor alone (also a build
gate). Every write re-reads the live value first and refuses when Google no
longer shows what the approval assumed; each is reversible, and undo acts
only while SYB's change still stands.
