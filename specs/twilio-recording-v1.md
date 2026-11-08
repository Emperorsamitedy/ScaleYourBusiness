# Twilio call recording — v1 (P6-08)

What SYB's call recording (`lib/phone/twilio.ts`'s `record` verb, `lib/phone-recording/`) relies
on, and where each fact came from. Researched 2026-11-08 from Twilio's own pages. Every line is
marked **verified: true** (read on a Twilio page that day) or **verified: false** (not found on
the pages read, inferred, or SYB's own choice). Nothing here was tested against a live Twilio
account: every test uses the fake REST API and fake webhooks in `lib/phone/fake-twilio.ts`.

Sources (Twilio's own):

- [TwiML `<Start><Recording>`](https://www.twilio.com/docs/voice/twiml/recording)
- [The Recording resource (REST)](https://www.twilio.com/docs/voice/api/recording)
- [Security: media access and request signing](https://www.twilio.com/docs/usage/security)
- [Webhooks security](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
- [Requests to Twilio (authentication)](https://www.twilio.com/docs/usage/requests-to-twilio)

## Starting a recording: `<Start><Recording>`

| Fact                                                                                                  | verified |
| ----------------------------------------------------------------------------------------------------- | -------- |
| `<Recording>` nests in `<Start>`; Twilio starts recording when it executes it, then goes on to the next verb | true     |
| Attributes: `name`, `recordingStatusCallback`, `recordingStatusCallbackMethod` (GET/POST, default POST), `recordingStatusCallbackEvent` (`in-progress` `completed` `absent`, space-separated, default `completed`), `trim` (`trim-silence` default / `do-not-trim`), `track` (`inbound` `outbound` `both`, default `both`), `channels` (`mono` / `dual`, default `dual`), `recordingConfigurationId` | true     |
| `recordingStatusCallback` may be relative or absolute                                                 | true     |
| A `<Say>` placed BEFORE `<Start><Recording>` is not in the recording                                  | false — inferred: TwiML runs in order and `<Say>` plays to its end before the next verb; the page says recording begins when `<Start><Recording>` executes, and says nothing about earlier audio |
| A put-through (`<Dial>`) after `<Start><Recording>` stays in the same recording                       | false — not stated on the page; SYB keeps whatever Twilio records |
| SYB's choice: `channels="mono" track="both" trim="do-not-trim"`, POST, events `completed absent`     | n/a — one playable file of both sides, silence kept so it lines up with the transcript |

SYB enforces rule 32 in code, not by trust in the ordering above alone: `twiml()` throws
`RecordingBeforeNoticeError` unless a `<Say>` flagged as the recording notice comes before the
`record` verb, and `phone_calls.recording_notice_at` is stamped with that response. A recording
reported for a call without the stamp is deleted at Twilio without being fetched.

## The recording status callback

| Fact                                                                                                          | verified |
| ------------------------------------------------------------------------------------------------------------- | -------- |
| Parameters: `AccountSid`, `CallSid`, `RecordingSid`, `RecordingUrl`, `RecordingStatus` (`in-progress` `completed` `absent`), `RecordingDuration` (only when `completed`), `RecordingChannels` (`1`/`2`), `RecordingStartTime`, `RecordingSource`, `RecordingTrack` | true     |
| "Twilio signs all HTTP requests to your app with an `X-Twilio-Signature` HTTP header" — HMAC-SHA1 with the auth token over the URL plus the alphabetically sorted POST parameters | true     |
| Status and recording callbacks specifically are signed the same way                                         | false — the page's statement is general ("all HTTP requests"); it names no callback. SYB verifies them exactly as the voice webhook and refuses anything unsigned |
| Twilio retries a recording callback that failed                                                             | false — not found. SYB doesn't rely on it: a recording that couldn't be stored stays `pending` and the daily cron retries |
| `RecordingSource` for `<Start><Recording>` is `StartCallRecordingTwiML`                                      | false — the fake uses that value; SYB never reads the field |

SYB never fetches `RecordingUrl`: the audio is fetched from Twilio's own REST address built from
the account SID and the `RecordingSid` (shape-checked, `RE` + 32 hex), so a forged or replayed
callback can't point SYB at another host.

## Fetching and deleting

| Fact                                                                                                         | verified |
| ------------------------------------------------------------------------------------------------------------ | -------- |
| Resource: `/2010-04-01/Accounts/{AccountSid}/Recordings/{Sid}`; `.json` for metadata                          | true     |
| Media: append `.wav` (default, `audio/x-wav`, 128 kbps) or `.mp3` (`audio/mpeg`, 32 kbps). SYB fetches `.mp3` | true     |
| Media can be fetched only when the status is `completed` and it is stored at Twilio                          | true     |
| HTTP Basic auth on media URLs is an account setting, "not turned on by default"; the docs' credentials for it are an API key SID and secret | true     |
| REST requests accept Basic auth with the Account SID and Auth Token "when an API reference or guide specifies" it; API keys are recommended for applications | true     |
| SYB sends Basic auth with the Account SID and Auth Token (the line's existing settings) on every request    | n/a — SYB's choice; an API key would be the docs' preferred form. Not tested live |
| The media request may redirect to a storage host                                                             | false — not stated; `fetch` follows a redirect and drops the Authorization header across origins |
| `DELETE /2010-04-01/Accounts/{AccountSid}/Recordings/{Sid}.json` returns 204, no body                         | true     |
| Deleting removes the media for good ("cannot be recovered"); storage billing stops; metadata kept 40 days    | true     |
| Only `completed` recordings can be deleted                                                                   | true     |
| A second DELETE answers 404                                                                                  | false — inferred; SYB treats 404 as already gone |
| Recording statuses: `in-progress` `paused` `stopped` `processing` `completed` `absent` `deleted`             | true     |
| `RecordingSid` is `RE` + 32 hex (34 characters)                                                              | true     |
| `duration` is a string of seconds; `price` and `price_unit` are "the one-time cost of creating the recording" | true     |
| When `price` is filled in                                                                                     | false — the examples show `null` while in progress; the page doesn't say when |

## What SYB does with it

- **Off by default.** `phone_settings.record_calls` is false until the owner switches it on on
  `/support` (role `support.settings`, an owner's); each switch is a `recording_consent` entry on
  the decision log with the person and time. Switching on is refused unless the server has the
  three `TWILIO_*` settings, a media store and a valid `CONNECTOR_KEY`.
- **One copy.** On `completed`: fetch the MP3 (25 MB cap, 60 s timeout), seal it (AES-256-GCM,
  key HKDF-derived from `CONNECTOR_KEY`), put it in the media store under
  `recordings/<profile>/<random>.bin`, then DELETE Twilio's copy. A failed delete leaves
  `at_twilio = true` and the daily cron (`/api/cron/connector-sync`, step `phone_recordings`)
  retries it.
- **Kept `PHONE_RECORDING_KEEP_DAYS`** (default 30, 1–365) from when it was stored; the caller
  hears the number. Then the cron deletes both copies and the row.
- **Erasure (rule 22).** Erasing a call or a contact marks its recordings in the same transaction
  and deletes them from the store and at Twilio after it commits; anything that fails stays
  marked, unplayable, for the cron. The decision log keeps ids only.
- **Playback** only through `GET /api/support/phone/recording?call=<id>` (role
  `phone.recordings`, owner only), opened server-side and streamed `no-store`. The storage
  address never leaves the server.
- **Cost (rule 34).** Each stored recording logs `phone_recording` with its duration and
  `cost_eur: null`, saying Twilio's per-minute recording price isn't known when it is made (it is
  on the Twilio bill).
- **The DELETE is the only write SYB makes to Twilio**, on SYB's own account, and all it does is
  remove a caller's audio once SYB holds the only copy, or when it was never let in.
