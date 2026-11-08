# TikTok Content Posting API — what SYB relies on (v1)

Read 2026-11-08 from TikTok for Developers (developers.tiktok.com), for TikTok
posting through the approval queue (TASKS-PHASE3.md, P3-21, owner override of
2026-11-08). Each fact is marked `verified: true` when TikTok's own page says it,
and `verified: false` when the page is silent, ambiguous or contradicts itself —
those are checked against SYB's real TikTok app before the first real post.
The code lives in `lib/execution/providers/tiktok.ts` (the provider),
`lib/execution/tiktok-posting.ts` (the sign-in and consent) and
`lib/content/tiktok-publish.ts` (the database side). Tests run against
`lib/execution/providers/tiktok-fake.ts`, never the network.

## Pages read

- Content Posting API — Get started: `/doc/content-posting-api-get-started`
- Direct Post reference: `/doc/content-posting-api-reference-direct-post`
- Query Creator Info: `/doc/content-posting-api-reference-query-creator-info`
- Get Post Status: `/doc/content-posting-api-reference-get-video-status`
- Media Transfer Guide: `/doc/content-posting-api-media-transfer-guide`
- Content Sharing Guidelines (UX rules): `/doc/content-sharing-guidelines`
- Login Kit for Web: `/doc/login-kit-web`
- Get / Refresh / Revoke a user access token: `/docs/en/oauth-get-a-user-access-token`,
  `/docs/en/oauth-refresh-a-user-access-token`, `/docs/en/oauth-revoke-a-user-access-token`
- Manage user access tokens: `/doc/oauth-user-access-token-management`
- Scopes reference: `/doc/tiktok-api-scopes`
- Video Query: `/doc/tiktok-api-v2-video-query`

## Sign-in (Login Kit for Web)

| Fact | verified |
| --- | --- |
| Authorize at `https://www.tiktok.com/v2/auth/authorize/` with `client_key`, `scope` (comma-separated), `response_type=code`, `redirect_uri`, `state`; optional `disable_auto_auth` (SYB sends `1`, so TikTok's screen always shows) | true |
| The callback carries `code`, `scopes` (comma-separated), `state`, or `error` / `error_description` | true |
| Redirect URIs: up to 10, under 512 characters, absolute `https`, no query, no fragment, registered on the app | true |
| PKCE is required only for mobile and desktop apps (`code_verifier` "conditional"); the web flow doesn't use it | true (the web page doesn't mention PKCE; the token page says mobile/desktop) |
| The cancel value of `error` is `access_denied` | false — the page lists `error` without its values; SYB treats `access_denied` as a cancel and anything else as "didn't finish" |
| Token: `POST https://open.tiktokapis.com/v2/oauth/token/`, form-encoded, `client_key`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri` | true |
| Token answer: `access_token`, `expires_in`, `refresh_token`, `refresh_expires_in`, `open_id`, `scope` (comma-separated), `token_type=Bearer`; errors as `error`, `error_description`, `log_id` | true (the page's own "success" example shows an error body) |
| The access token lives 2 hours, the refresh token 180 days | true |
| Refresh tokens ROTATE: each refresh returns a new one and the old one stops working | true |
| Refresh: same endpoint, `grant_type=refresh_token`, `refresh_token` | true |
| Revoke: `POST /v2/oauth/revoke/`, form, `client_key`, `client_secret`, `token`; success is an empty body | true |
| Token calls are made from the server only (the client secret) | true |

## Scopes SYB asks for (registry: `tiktok_publish`)

| Scope | Why | verified |
| --- | --- | --- |
| `video.publish` (write) | "Post content directly to the user's profile" — Direct Post, creator_info and post status | true |
| `user.info.basic` (read) | open ID, avatar, display name | true (the scope exists) / false (whether Login Kit always adds it to a grant — declared so the exact-scope match can't refuse a grant TikTok always includes) |
| `video.list` (read) | "Read the user's public videos" — Video Query, for the counts readback | true |
| `video.manage` — NOT asked for | "Inspect, edit, and delete the user's published posts, including posts made through other apps" | true. Far beyond the consent, and no public delete endpoint is documented in the Content Posting API pages, so SYB's TikTok op is irreversible and a test refuses the scope by name |
| `video.upload` — NOT asked for | drafts to the inbox, not Direct Post | true |

## Creator info

| Fact | verified |
| --- | --- |
| `POST /v2/post/publish/creator_info/query/`, Bearer token, JSON body, scope `video.publish`, 20 requests a minute | true |
| Answer: `creator_username`, `creator_nickname`, `creator_avatar_url`, `privacy_level_options`, `comment_disabled`, `duet_disabled`, `stitch_disabled`, `max_video_post_duration_sec` | true |
| Public accounts get `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `SELF_ONLY`; private accounts `FOLLOWER_OF_CREATOR`, `MUTUAL_FOLLOW_FRIENDS`, `SELF_ONLY` | true |
| It must be called before a direct post, and the post form must use the latest answer | true |
| Some errors (`spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`, `reached_active_user_cap`) come back with HTTP 200 and a non-`ok` `error.code` | true — SYB checks `error.code`, not only the status |

## Direct Post

| Fact | verified |
| --- | --- |
| `POST /v2/post/publish/video/init/`, Bearer, JSON, scope `video.publish`, 6 requests a minute | true |
| `post_info`: `privacy_level` (required, one of creator_info's options), `title` (≤ 2200 UTF-16 units), `disable_duet`, `disable_stitch`, `disable_comment`, `video_cover_timestamp_ms`, `brand_content_toggle`, `brand_organic_toggle`, `is_aigc` | true |
| `is_aigc`: "Set to true if the video is AI generated content" — TikTok labels it as AI-generated | true. SYB sets it from the item's own provenance (`media.is_ai_generated`): true for generated clips, false for edited real footage, whose caption still ends with "AI-assisted edit of real footage" (rule 17) |
| `source_info.source`: `FILE_UPLOAD` (with `video_size`, `chunk_size`, `total_chunk_count`) or `PULL_FROM_URL` (with `video_url`) | true |
| `PULL_FROM_URL` only from a domain or URL prefix verified in the developer portal | true — SYB's renders sit in Vercel Blob storage, a domain SYB can't verify, so SYB uses FILE_UPLOAD only (a build gate refuses PULL_FROM_URL) |
| Answer: `publish_id`, and `upload_url` for FILE_UPLOAD, valid one hour | true |
| Errors: `invalid_param`, `access_token_invalid`, `scope_not_authorized`, `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`, `reached_active_user_cap`, `unaudited_client_can_only_post_to_private_accounts`, `url_ownership_unverified`, `privacy_level_option_mismatch`, `rate_limit_exceeded`, 5xx | true |
| No idempotency key exists for a post | true (none is documented) — SYB's at-most-once is its own: claimed before init, `sent_at` written just before the last chunk, a lost answer read back by `publish_id` |
| Whether `brand_content_toggle` is required | false — the table's marker is ambiguous; SYB always sends `false` (it never posts paid partnerships) |

## Upload (FILE_UPLOAD)

| Fact | verified |
| --- | --- |
| `PUT` the bytes to `upload_url` with `Content-Type`, `Content-Length`, `Content-Range: bytes FIRST-LAST/TOTAL` | true |
| Chunks 5–64 MB; under 5 MB one chunk; over 64 MB several; the last may be up to 128 MB; `total_chunk_count` = floor(size / chunk_size); 1–1000 chunks, in order | true |
| 206 = more expected; 201 = all received, posting begins; 400/403/404/416; 5xx = retry the chunk | true |
| MP4 (recommended), WebM, MOV; H.264 recommended; 23–60 fps; 360–4096 px per side; up to 10 minutes; up to 4 GB | true — SYB uploads at most 256 MB, read from its own media store |
| The `upload_url` host is under `tiktokapis.com` | false — the reference shows `open-upload.tiktokapis.com`; SYB refuses any other host, so a different live host fails closed and the fence is widened here first |

## Post status

| Fact | verified |
| --- | --- |
| `POST /v2/post/publish/status/fetch/` with `{publish_id}`, scope `video.publish` or `video.upload`, 30 a minute | true |
| `status`: `PROCESSING_UPLOAD`, `PROCESSING_DOWNLOAD`, `SEND_TO_USER_INBOX`, `PUBLISH_COMPLETE`, `FAILED`; `fail_reason` when failed | true |
| `publicaly_available_post_id` (TikTok's spelling) is a list of int64, filled only once the post is public and has passed moderation | true — SYB keeps an int64 exact (JSON.parse alone rounds it; found by the provider's own test). Until a public id exists SYB stores the `publish_id` as the platform id, and the readback swaps in the public id when it appears |
| `fail_reason` values listed (`file_format_check_failed`, `duration_check_failed`, …, `spam_risk`) | true — each is "nothing was published" |

## Audit, privacy and limits — access honesty

| Fact | verified |
| --- | --- |
| "All content posted by unaudited clients will be restricted to private viewing mode"; an audit lifts it | true |
| Unaudited clients can post only with `SELF_ONLY` visibility, and serve up to 5 users per 24 hours | true (Content Sharing Guidelines) |
| A per-creator cap of roughly 15 posts a day applies to every client | true ("typically around 15") |
| SYB's screen states it: `TIKTOK_AUDIT_STATUS` unset (anything but `audited`) offers only "Only me" and says why | — |

## The UX rules SYB follows (Content Sharing Guidelines)

| Rule | verified | Where |
| --- | --- | --- |
| Show the creator's nickname so the owner knows where it goes | true | `/content` TikTok form |
| Fetch the latest creator info when the post form renders; if the creator can't post now, stop and say so | true | `GET /api/content/tiktok`, and preflight again before every post |
| Privacy picked by hand from creator_info's options, no default preselected | true | the form's select starts on "Choose…"; approval is refused until it is chosen |
| Comment, Duet and Stitch off by default; grey out what the creator has off | true | the form; the init forces off what the account has off |
| Commercial-content disclosure off by default; "Your brand" / "Branded content" | true | SYB offers "This promotes my own business" (brand_organic) only; never branded content |
| A consent declaration before Publish referencing TikTok's Music Usage Confirmation | true | the form |
| Tell the owner a post may take minutes to appear; poll status | true | the form; the provider polls up to 10 times, then the sweep |
| Don't add watermarks, logos or promotional text | true | SYB adds none; the caption's own AI-disclosure line is the owner's approved text (rule 17) |
| Content must not be sent until the user expressly consents | true | the recorded approval of the finished item (rule 12) |
| Whether a scheduled send (approved now, posted at its time by SYB's runner) satisfies "user-initiated" | false | to confirm in TikTok's audit; until then every post is private |

## Readback (counts)

| Fact | verified |
| --- | --- |
| `POST /v2/video/query/?fields=…` with `filters.video_ids` (up to 20), scope `video.list`; fields include `id`, `view_count`, `like_count`, `comment_count`, `share_count` | true |
| Whether it returns private (`SELF_ONLY`) posts | false — the scope reads "public videos"; SYB reads only posts with a public id, so a private post writes nothing (rule 5: unavailable is not zero) |
| Landing as `content.views.daily` and `content.interactions.daily` (likes + comments + shares), dimensions `{platform: "tiktok", platform_post_id}` | — SYB's mapping |

## Deleting a post

| Fact | verified |
| --- | --- |
| The Content Posting API pages document no delete or unpublish endpoint | true |
| Only `video.manage` mentions deleting (and editing), including posts made by other apps; "Deleted posts can be restored in TikTok within 30 days" | true |
| So: `publish_tiktok_video` is `reversible: false` in the registry, the proposal is labelled `hard` before approval, and `/content` says "delete it in the TikTok app" instead of offering Withdraw | — |
