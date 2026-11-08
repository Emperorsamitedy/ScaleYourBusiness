// The language and currency choices as the server reads them — L-1.
//
// Three places hold a choice, and each is read here only:
//   · the language cookie (lib/i18n/locales LANGUAGE_COOKIE): what this
//     browser shows, before and after sign-in;
//   · users.language: the person's own choice, copied into the cookie at
//     sign-in so it follows them to a new device;
//   · the currency cookie: a currency chosen on the sign-up screen before
//     there is an account to hold it, used when the account is created.
//
// The gate (rule 6) is re-checked on every read, not only when a choice
// is made: a cookie naming a language still in review shows English to
// anyone who isn't a named reviewer, so a hand-edited cookie opens nothing.

import { cookies } from "next/headers";
import type { Access } from "../auth/access";
import { AUTH_COOKIE, resolveAccess } from "../auth/access";
import { roleAllows, roleOf } from "../auth/roles";
import type { AuthedSession } from "../auth/service";
import { currentSession } from "../auth/service";
import type { AppLocale } from "./locales";
import {
  CURRENCY_COOKIE,
  DEFAULT_LOCALE,
  LANGUAGE_COOKIE,
  languageStatus,
  isAppLocale,
  offeredLanguages,
  resolveLanguage,
} from "./locales";
import type { PendingChoices, PickerData } from "./picker";
import { currencyOptions, languageOptions, readPendingChoices } from "./picker";
import { isLanguageReviewer } from "./review";
import type { BusinessLocale } from "./service";
import { businessLocale } from "./service";

/** One year: a language is a lasting choice. Same flags as the app's other cookies. */
export function languageCookieOptions(maxAge = 60 * 60 * 24 * 365) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

/**
 * The locale this request renders in — what next-intl's request config
 * uses (i18n/request.ts). A live language costs no lookup; only a cookie
 * naming a language in review asks who is signed in.
 */
export async function requestLocale(): Promise<AppLocale> {
  const store = await cookies();
  const requested = store.get(LANGUAGE_COOKIE)?.value;
  if (!isAppLocale(requested)) return DEFAULT_LOCALE;
  if (languageStatus(requested) === "live") return requested;
  const session = await currentSession(store.get(AUTH_COOKIE)?.value).catch(() => null);
  return resolveLanguage(requested, isLanguageReviewer(session));
}

export interface LanguageContext {
  /** What this request shows. */
  locale: AppLocale;
  /** Whether the signed-in person is a named reviewer (LANGUAGE_REVIEW_ACCOUNTS). */
  reviewer: boolean;
  /** The languages a picker may offer this person. */
  offered: AppLocale[];
  session: AuthedSession | null;
}

/** Everything a picker needs: the locale, the gate's answer, the session. */
export async function languageContext(): Promise<LanguageContext> {
  const store = await cookies();
  const session = await currentSession(store.get(AUTH_COOKIE)?.value);
  const reviewer = isLanguageReviewer(session);
  return {
    locale: resolveLanguage(store.get(LANGUAGE_COOKIE)?.value, reviewer),
    reviewer,
    offered: offeredLanguages(reviewer),
    session,
  };
}

/** The browser's choices, for creating an account or a profile with them. */
export async function pendingChoices(): Promise<PendingChoices> {
  const store = await cookies();
  return readPendingChoices(store.get(LANGUAGE_COOKIE)?.value, store.get(CURRENCY_COOKIE)?.value);
}

export interface PickerContext {
  data: PickerData;
  /** Whether this browser has made the first step's choice. */
  chosen: boolean;
  /** The business this browser is on, if any (the one door, lib/auth/access). */
  access: Access | null;
  /** The business's stored language and currency, when there is a business. */
  business: BusinessLocale | null;
}

/**
 * Everything the first step and the settings screen show: the languages
 * this person may pick (the gate), the currencies named in their
 * language, and whether they may set the business's choices (an owner,
 * the anonymous intake's only person, or a visitor with no business yet).
 */
export async function pickerContext(): Promise<PickerContext> {
  const [ctx, pending, access] = await Promise.all([
    languageContext(),
    pendingChoices(),
    resolveAccess(),
  ]);
  const business = access ? await businessLocale(access.profile_id) : null;
  const role = access ? roleOf(access) : null;
  const canSetBusiness = !access || (role !== null && roleAllows(role, "business.locale"));
  return {
    chosen: pending.chosen,
    access,
    business,
    data: {
      languages: languageOptions(ctx.offered),
      language: ctx.locale,
      currencies: currencyOptions(ctx.locale),
      // A currency still at its default isn't a choice: the first step asks for one.
      currency: business ? (business.currency_chosen ? business.currency : null) : pending.currency,
      canSetBusiness,
    },
  };
}
