# Guided page set-up: what SYB relies on (v1)

The marketing teammate's idea (recorded 2026-11-18): ScaleX could create a
client's Facebook Page or Instagram account for them. It cannot, and must not
try: no platform lets an ordinary app create a Page or an account, and Meta's
Developer Policies forbid creating or claiming a Page for a person without
their consent and charging for it. What ScaleX can do is everything around
the one step the owner has to take themselves: prepare what to type from the
business's own fact sheet, send the owner to the platform's own form, and
then read back whether the Page and its Instagram account are there.

The plan is in `TASKS-FEEDBACK.md` ("Guided page set-up", G-1 to G-6). Three
rules ride with it, and a test holds each:

1. **The owner creates; ScaleX prepares.** Nothing in the code calls a
   platform to create or claim a Page or an account.
2. **No platform password, ever.** The guide has no field for one and no
   request carries one. The owner signs in on the platform's own site.
3. **Free on every plan.** The guide is never behind a price.

Every fact the guide relies on is listed here, with `verified: true` when one
of the platform's own pages stated it on the day read and `verified: false`
when it did not. Re-check every `verified: false` line before it is shown to
an owner as a fact; until then the guide words it as advice ("keep it short")
or leaves it out.

Pages read on **2026-11-20**: developers.facebook.com/devpolicy (Developer
Policies, section 11 "Pages API"); developers.facebook.com/docs/instagram-api/
getting-started and the Instagram Graph API's Page reference; the Meta
Business Help Centre article 473994396650734 (its title only: the page's
steps are drawn by script and could not be read); the Instagram Help Centre
(its Page-connection steps, through a search engine's excerpt of the page).

## What Meta allows

| Fact                                                                                                                            | verified |
| ------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Developer Policies 11.2: "Don't charge a fee for creating or claiming a Page."                                                  | true     |
| Developer Policies 11.5: "Don't create or claim a Page on behalf of people without their consent."                              | true     |
| Section 11 of the Developer Policies is "Pages API" and has seven numbered clauses                                              | true     |
| An ordinary app has no API call that creates a Facebook Page (only test users and allowlisted apps; read 2026-11-18)            | false    |
| Instagram has no API call that creates an account or switches one to a professional account (read 2026-11-18)                   | false    |
| Meta's Platform Terms forbid an app from asking for a person's Meta login (a third party's quotation; Meta's own text not read) | false    |

## Where the owner does it

| Fact                                                                                                                                  | verified |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Meta's own guide, "Create a Facebook Page for your business", is at `https://www.facebook.com/business/help/473994396650734`          | true     |
| The create form itself is at `https://www.facebook.com/pages/create` (third-party guides agree; Meta's own page not read)             | false    |
| The form asks for a Page name and a category, and offers a bio                                                                        | false    |
| On Instagram, a Page is connected from the profile: Edit profile, then Page, then "Create Facebook Page" or "Connect an existing Page" | true     |
| The switch to a professional account is under Edit profile, "Switch to professional account", then Business or Creator                | false    |
| Instagram's own guide to a business account is at `https://help.instagram.com/502981923235522` (others link it so; title not read)    | false    |
| A private Instagram account becomes public when it turns professional                                                                 | false    |

## What the fields may hold

None of these limits was read on a platform's own page. The kit therefore
never states a limit: it keeps what it prepares well inside the smallest
figure anyone reports, so the text fits whichever is true.

| Fact                                                                                                | verified | What the kit does                              |
| --------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| A Page name may be up to 75 characters                                                              | false    | Offers the business's name as it was given     |
| A Page's bio may be up to 101 characters                                                            | false    | Keeps the short line to 100 characters or less |
| An Instagram bio may be up to 150 characters                                                        | false    | The same short line                            |
| An Instagram username may hold letters, numbers, full stops and underscores, up to 30 characters    | false    | Suggests a name in those characters, 30 or less |
| A username is unique across the platform, so a suggested one may be taken                           | false    | Says so, and calls it a suggestion             |

## Reading it back

| Fact                                                                                                                              | verified |
| --------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `GET /me/accounts` lists the Pages the signed-in person manages (with `pages_show_list`)                                          | true     |
| A Page's connected Instagram professional account is its `instagram_business_account` field (`GET /{page-id}?fields=…`)           | true     |
| `GET /me/accounts` can be asked for `id,name,access_token,instagram_business_account` in one call                                  | true     |
| Developers report `/me/accounts` coming back empty for a Page held through a business portfolio unless `business_management` is granted | false    |

SYB already makes these reads when an owner gives write access for publishing
(`lib/execution/meta-login.ts`, `lib/execution/providers/meta.ts`: `my_pages`,
`page`, `ig_user`). The guide adds no request of its own: its last step is
that same consent, and what the guide shows as done is what that connection
holds (a Page id; an Instagram account id or none).

## What is not in scope

X (Twitter) and TikTok accounts: both forbid or lack automated creation, and
SYB publishes to neither through a Page. Google Business Profile: a listing is
claimed and verified by post or phone, a different road; not part of this
guide.
