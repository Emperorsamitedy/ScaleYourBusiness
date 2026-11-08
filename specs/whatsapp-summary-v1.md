# The weekly summary on WhatsApp — v1 (P6-07)

Dated 2026-11-08. The owner's request: "build the whatsapp weekly summary
too". The owner already gets the weekly summary by email (idea 42); this
sends the same week to their own WhatsApp number, through Twilio, when they
choose it and have said yes to it. Code: `lib/summary/whatsapp.ts` (pure:
variables, digest, template choice, the request, the answer),
`lib/summary/whatsapp-optin.ts` (the yes), `lib/summary/run.ts` (the
runner), `app/api/summary` and `app/api/summary/whatsapp` (the screen's
API), the Weekly email card on `/watch`.

## 1. What Twilio's and Meta's docs say, as read on 2026-11-08

Confirmed in the docs:

- **A business-initiated message needs an approved template.** Twilio's
  WhatsApp API page: business-initiated notifications must be "templated
  and pre-registered", and outside the 24-hour customer service window
  only a pre-approved template can be sent.
- **WhatsApp requires an explicit opt-in.** Twilio's WhatsApp API page:
  "WhatsApp requires that your application implement explicit user
  opt-ins". Rule 19 already asks for more: a recorded fact (§3).
- **The request.** `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`,
  form-encoded, with `From=whatsapp:+<sender>`, `To=whatsapp:+<number>`,
  `ContentSid=HX…` in place of `Body`, and `ContentVariables`, "a JSON
  string that defines values for placeholder variables". Twilio's
  content-template sending page lists From, To, ContentSid and
  ContentVariables as the fields and does **not** require a Messaging
  Service. The response's `sid` starts with `SM` or `MM`; with no Messaging
  Service the first status is `queued`.
- **Auth.** HTTP Basic. Twilio's request page: where a guide names it, "use
  the Account SID as the HTTP Basic authentication username and the Auth
  Token as the password" (its examples use an API key and secret, which
  work the same way; SYB uses the phone line's SID and token).
- **Variables** (Twilio, "Using variables with Content API"): keys up to 16
  characters, values up to 1,600 characters but "we recommend using less
  than 250"; in approved WhatsApp templates variables "can't contain
  newlines"; they shouldn't start or end the body, shouldn't be right next
  to each other (a space between counts as adjacent), must be sequential,
  and "for every 'x' variables, there must be 2x+1 non-variable words".
- **Body length.** Meta's template components page: body text, "Maximum of
  1024 characters". Meta error 132005: "Translated text is too long".
- **Errors.** Meta 132000 (variable count mismatch), 132001 (template
  missing in that language or not approved), 132012 (variables formatted
  wrongly), 132018 (an issue with the parameters); Twilio 63028
  (ContentVariables don't match the template).

Not confirmed on an official page:

- **Tabs and "more than 4 consecutive spaces".** Meta's API answers "Param
  text cannot have new-line/tab characters or more than 4 consecutive
  spaces" — quoted by WATI's and Clickatell's guides and a ManyChat thread,
  not found on a Meta or Twilio page. SYB folds every run of whitespace to
  one space anyway, so the rule holds either way.
- **Whether 1,024 counts the variables' values.** Assumed yes; SYB keeps
  the four variables to 900 characters together, and the template's own
  words are about 200.
- **The error envelope** (`code`, `message`, `more_info`, `status`). Not
  described on the pages read; SYB keeps only a numeric `code` if present.
- **Idempotency.** No idempotency key is documented for the Messages API.
  The claim (§4) is the only guard, as it was before Resend's key.
- **Price.** Not known at send time (§5).
- **Category.** Submitted as **Utility** (an update about the owner's own
  account, sent because they asked). Meta may recategorise it as Marketing;
  not knowable before review.

## 2. The template to submit

One template per language, each approved by Meta, its `HX…` ContentSid set
in `TWILIO_WHATSAPP_SUMMARY_TEMPLATES` (§6). Name: `syb_weekly_summary`.
Category: Utility. Four variables, in order:

| Var     | What                                                                                      | Cap  |
| ------- | ----------------------------------------------------------------------------------------- | ---- |
| `{{1}}` | The business's name; "your business" (in that language) when it has none                  | 60   |
| `{{2}}` | The week, as the email writes it, e.g. "2–8 Nov 2026"                                     | 60   |
| `{{3}}` | A one-line digest of the email's sections: lines joined with " · ", then "and N more"      | ≤480 |
| `{{4}}` | The Watching screen, `<APP_URL>/watch`                                                    | 200  |

The four together never pass 900 characters; the digest gets what's left.

**English (en), exactly:**

```
Your SYB week for {{1}}, covering {{2}}. This week: {{3}} Everything is on your Watching screen: {{4}} Nothing runs until you approve it. To stop these messages, switch them off there.
```

It begins and ends with text, no two variables touch, and it has 27 words
of its own for 4 variables (the rule wants 9). Sample values for review:
`{{1}}` Kenji's Bakery, `{{2}}` 2–8 Nov 2026, `{{3}}` 2 proposals wait for
your decision. · Raise the cut price to €42 · and 3 more, `{{4}}`
https://syb-kappa.vercel.app/watch.

The other six, to submit **after a native speaker has read them** (the
Watching screen's name is the one each language's menu uses):

- **es-ES:** `Su semana con SYB para {{1}}, del {{2}}. Esta semana: {{3}} Todo está en su pantalla Observando: {{4}} Nada se ejecuta sin su aprobación. Para dejar de recibir estos mensajes, desactívelos allí.`
- **de-DE:** `Ihre SYB-Woche für {{1}}, Zeitraum {{2}}. Diese Woche: {{3}} Alles sehen Sie unter „Beobachtung“: {{4}} Nichts läuft, bevor Sie es freigeben. Um diese Nachrichten zu beenden, schalten Sie sie dort aus.`
- **fr-FR:** `Votre semaine SYB pour {{1}}, période du {{2}}. Cette semaine : {{3}} Tout figure sur votre écran Observation : {{4}} Rien ne s’exécute tant que vous ne l’avez pas validé. Pour ne plus recevoir ces messages, désactivez-les là-bas.`
- **hu-HU:** `Az Ön SYB-hete – {{1}}, időszak: {{2}}. Ezen a héten: {{3}} Mindent megtalál a Figyelés képernyőn: {{4}} Semmi sem fut az Ön jóváhagyása nélkül. Ha nem kéri ezeket az üzeneteket, ott kapcsolhatja ki őket.`
- **ru-RU:** `Ваша неделя с SYB для {{1}}, период {{2}}. На этой неделе: {{3}} Всё есть на экране «Наблюдение»: {{4}} Ничего не запускается без вашего одобрения. Чтобы больше не получать эти сообщения, отключите их там.`
- **zh-Hans:** `您好，这是 {{1}} 的 SYB 每周摘要，时间为 {{2}}。本周：{{3}} 所有内容都在您的“观察”页面上：{{4}} 未经您批准，什么都不会执行。如需停止接收这些消息，请在该页面关闭。`

Each one starts and ends with words of its own (Meta refuses a template
that starts or ends with a variable, 2388299). Chinese has no spaces, so
Meta's word count for the 2x+1 rule is uncertain there; the reviewer should
check it passes. A language with no approved template
falls back to the English one — and then the digest is in English too, so
one message never mixes two languages.

## 3. The yes (rule 19) and the number (rule 22)

- The owner the summary goes to (the account's first owner, as for the
  email) types their number and ticks a box whose words are
  `watch.summary.whatsapp.consent` in their screen's language:
  "Send my weekly SYB summary to this number on WhatsApp. I can stop it
  here at any time, and SYB keeps the number for nothing else."
- The screen sends the sentence back as shown; the server records the yes
  only when it is word for word that language's sentence now.
  `whatsapp_optins` keeps the number (E.164, via `toE164`), the version
  (`whatsapp-summary-v1`, bumped whenever the sentence changes), the
  language, the sentence's sha256, and `opted_in_at`. At most one live yes
  per user (a partial unique index); a new yes withdraws the old.
- Withdrawing is one click and immediate: `withdrawn_at` is stamped, and the
  runner reads the live yes at send time.
- The number is erasable PII: "Stop and forget my number" (and removing the
  person from the team) nulls it and stamps `erased_at`, keeping the dates,
  version and hash. A check holds `phone_number IS NULL` exactly when erased.
- Only the recipient can give or take back a yes (the API answers 409 for
  any other session); the screen shows the number's last three digits only.

## 4. The run

- The channel is the owner's `users.notification_prefs.weekly_summary_channel`:
  `email` (the default, also for anything unreadable), `whatsapp` or `both`.
- Per channel: email needs `RESEND_API_KEY`; WhatsApp needs all four keys
  (§6) and a live yes. Both need `APP_URL`. With no channel possible the
  outcome is `not_configured` and nothing is claimed — as before.
- One claim per (account, ISO week) BEFORE any send, never retried, however
  many channels. `weekly_summaries.status` is the email's outcome (null
  when the email wasn't a channel that week); `whatsapp_status`,
  `whatsapp_sid`, `whatsapp_error_code` and `whatsapp_optin_id` are the
  message's. A check holds at least one channel per row.
- Twilio's answer: 2xx with an `SM`/`MM` SID is `sent`; a 4xx other than
  409 is `refused` (nothing went out; its numeric code kept); a 5xx, 409,
  timeout or a 2xx without a SID is `unknown` (it may have gone). None is
  retried. The run's outcome is `sent` only when every channel sent.
- Variables that would break WhatsApp's rules (`variableProblems`) are
  refused before any call. They never do: `cleanVariable` folds whitespace
  and the caps are enforced in code.
- Email-only owners get exactly what they got before: the same claim, the
  same email, the same row.

## 5. Logs and cost (rule 34)

Every log line carries ids and counts only — never the number, never a
variable's text. Each WhatsApp send logs `weekly_summary_whatsapp` with
workload `weekly_summary_whatsapp`, provider `twilio`, the outcome, the
template's language, the variables' character count, and `cost: null,
cost_known: false`: Meta and Twilio price a template message per country
and category, and the price shows only on the Twilio bill.

## 6. Settings

- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — the phone line's own (P6-02).
- `TWILIO_WHATSAPP_FROM` — the WhatsApp-enabled sender, E.164.
- `TWILIO_WHATSAPP_SUMMARY_TEMPLATES` — JSON, locale → ContentSid, e.g.
  `{"en":"HX…","de-DE":"HX…"}`; must hold `en`.

Any missing or malformed: WhatsApp is not set up, and `/watch` names what's
needed.
