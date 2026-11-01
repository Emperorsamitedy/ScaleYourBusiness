# Languages and currencies

The owner, 2026-11-01: the whole system in English (the default) plus Spanish, German, French, Hungarian, Russian and Mandarin. That means the questions, the analysis, the report, the charts and everything else. The language is chosen at the first step of sign-up and can be changed in settings. Every analysis carries its currency, and any of the world's currencies may be the business's. The translations have to be exact in grammar and wording, with research done before building.

**Decided when asked (2026-11-01):**

- **Mandarin:** Simplified Chinese (`zh-Hans`).
- **Spanish:** the Spain variety (`es-ES`).
- **Currency:** any ISO 4217 currency for the business, shown on every figure and formatted the way the chosen language writes money (`1 234,56 €` in French, `1.234,56 €` in German). Nothing is converted between currencies; rule 1 stands.
- **Accuracy:** I translate, working from a glossary of business terms. Each language stays switched off for customers until a native speaker the owner chooses has checked it.

**Research (2026-11-01):**

- `next-intl` works with Next.js 16's App Router. In Next 16 the request hook is `proxy.ts`, which was `middleware.ts`.
- It can keep the language in a cookie with no language in the URL (`localePrefix: "never"`). A known pitfall is a stale cookie after link prefetch, fixed upstream: keep both packages current and test the switch.
- Plurals come from ICU message format over CLDR rules (`Intl.PluralRules`):
  - Russian needs one, few, many and other;
  - Hungarian, German, Spanish and French need one and other;
  - Chinese needs only other.

  So "3 days", "5 days" and "21 days" each get their own correct Russian form.

## Rules for this work

These sit beside rules 1–30.

1. **No English left behind.** A screen, email or export in another language has no English sentence in it. A build-failing test checks every catalogue against English: every key is present, with the same placeholders, and every plural form the language needs is there.
2. **One term, one translation.** Business words come from a glossary (`specs/glossary-v1.json`) per language: margin, break-even, win rate, consent and the like. A test fails when a catalogue uses another word for a glossary term.
3. **Numbers, money and dates are formatted, never written in.** Every figure goes through `Intl` with the person's language and the business's currency, so a translation never contains a typed number or currency sign.
4. **Facts don't change language.** What the owner answered, and what a connector measured, is stored as it was given. Only its presentation is translated.
5. **The model writes in the person's language.** Interview turns, the report, chat answers and drafts are written in the chosen language. Customer-facing text (the support widget, campaign emails, review replies) is in the business's own language. Prompts say which, and caching (rule 8) is kept per language.
6. **No language goes live unchecked.** Each language has a status: `building`, `review` or `live`. Only `live` languages are offered to customers. `review` is open to the owner and the named reviewer.

## Stages

Each stage is its own PR, tested and merged before the next.

- [x] **L-1 Foundation.**
  - `next-intl` wired in, with the language from a cookie.
  - The person's language stored on their user row, and the business's language and currency on its profile.
  - The language picker as the first step of sign-up and in settings.
  - Currency chosen at sign-up from the full ISO list.
  - Locale-aware money, number and date formatting replacing the hand-written formatters.
  - The language status gate, and the catalogue tests from rule 1.
  - The app shell, menu, sign-in and settings translated.

  **Done 2026-11-01.** What was built:
  - **next-intl 4.14.9** (peer range covers Next 16; its "without i18n routing" guide read 2026-11-01). `i18n/request.ts` takes the locale from the `syb_lang` cookie through the status gate; no language in any URL and no proxy, so every route keeps its address. The root layout sets `<html lang>` and wraps the app in `NextIntlClientProvider`. Keys are typed from `messages/en.json` (`types/next-intl.d.ts`).
  - **Storage (migration 0078):** `users.language` (the person's; null until chosen, filled from the cookie at their next sign-in, and copied back into the cookie at sign-in so it follows them), `business_profiles.language` (the business's, for its customers; default `en`), `accounts.reporting_currency_chosen_at` (a chosen currency is never replaced by the intake's country), and `login_tokens.language`/`currency` (the sign-up screen's choices travel with the link). Both language columns are checked against the seven codes in the database.
  - **The first step:** a new visitor on `/signup`, or on `/intake` with no interview under way, chooses the language and then the currency (every active ISO 4217 code, named in their language via `Intl.DisplayNames`) before anything else. An interview already under way is never interrupted. **Settings:** `/settings/language` ("Language and currency", in the menu under Your business): your own language (anyone's), and the business's language and currency (an owner's; others see them and are told so). Changing refreshes the page in place; nothing is lost.
  - **Routes:** `PUT /api/locale` (own language, role `language.own`, any role) and `PUT /api/locale/business` (role `business.locale`, owner). See docs/SECURITY-AUDIT.md.
  - **Formatting:** `components/sheet/num.ts` (`num`, `moneyFig`, `moneyText`, `moneyExact`, `delta`) and the date helpers (`shortDate`, the two `dayWords`, the two `dateWords`, `longDate`) take a locale, defaulting to English with exactly today's output; other languages go through `Intl` (`lib/i18n/format.ts`). `lib/core/money.ts` `format` already took one. Money is integer minor units until that edge; nothing converts.
  - **The gate:** `LANGUAGE_STATUS` in `lib/i18n/locales.ts` — English `live`, the six others `review`. A review language is offered, accepted and rendered only for a signed-in person on `LANGUAGE_REVIEW_ACCOUNTS` (account ids or emails; `.env.example`).
  - **Catalogues:** `messages/<locale>.json` for the menu, sign-in, sign-up, link confirmation, "Which business?", the picker and the settings screen; `specs/glossary-v1.json` with 37 terms. **`messages/catalogue.test.ts`** fails the build on a missing or extra key, unparseable ICU, a placeholder or tag that differs from English, a missing plural category, a longer sentence left in English, a typed digit or currency sign, or a glossary term translated another way; it also holds English byte-identical to the code's own strings.
  - **Registers chosen:** Spanish (Spain) _usted_; German _Sie_; French _vous_, with French typography (thin no-break space before ? ! ;); Hungarian _Ön_ with third-person verbs; Russian _вы_, lower case in interface text; Chinese _您_, full-width punctuation, a space between Chinese and Latin text or numbers. Role lines read "Your role here: …" in every translation, which avoids gendering the person.
  - **For the reviewers to look at first:** German and Spanish generic-masculine role nouns (Inhaber, Betrachter, propietario, gestor, lector); Russian "Ваши бизнесы" on "Which business?"; French "Connexions" (connected accounts) beside "connexion" (sign-in); Hungarian "Összekapcsolt fiókok" for Connections.
  - **Still English in L-1, by scope:** the error sentences the server sends (sign-in refusals, role refusals) and every other screen, email and generated text (L-2 to L-6). The fonts cover Latin and Latin Extended only: Cyrillic and Chinese fall back to system fonts until the design decides (Plex Mono has a Cyrillic subset; Zilla Slab and Archivo don't).

  **Owner steps:** put your own address (or account id) in `LANGUAGE_REVIEW_ACCOUNTS` in Vercel to see the six languages; add each native reviewer's address when you choose them; run `db:migrate` through 0078.

- [ ] **L-2 The interview.** The question bank's words (160 questions, 57 answer lists, help text) in each language as overlays beside `specs/question-bank-v1.json`, with `lint_bank.py` extended. The interviewer asks in the chosen language.
- [ ] **L-3 The screens.** Every screen's own text, in batches by area: profile, report, cash, stock, carts, pipeline, reviews, connections, team, and so on.
- [ ] **L-4 The sentences SYB builds from numbers.** These are the view models in `lib/`, such as "€3,518.50 was left in carts…". Each moves to ICU messages with plural forms.
- [ ] **L-5 What the model writes.** The interviewer, the report, chat, drafts and customer-facing replies are written in the right language (rule 5).
- [ ] **L-6 Emails, exports and shared pages.** The weekly summary, invites, sign-in links, phone alerts, the accountant export's headings, and the shared report link.
- [ ] **L-7 Native review, then live.** Each language is read by its reviewer, corrections are made, and the language is switched to `live`. This is the owner's step: choosing the reviewers.

**Owner steps:** choose a native reviewer for each of the six languages. L-7 waits on them.
