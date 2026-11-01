// PUT /api/locale/business — the business's language and currency (L-1, TASKS-LANGUAGES.md).
//
//   PUT { language?, currency? }  → 200 { language, currency, currency_chosen }
//                                 | 200 { kept: "browser", currency } before there is a business
//
// The business's language is what its customers will read (support,
// campaign emails, review replies); its currency is the one every figure
// is shown in, any ISO 4217 code. Nothing is converted (rule 1): amounts
// already recorded keep the currency they were given in.
//
// An owner's, through the one door: a business with an owner needs that
// owner's session (role business.locale); an intake nobody owns yet acts
// as its owner (lib/auth/roles roleOf). Before there is any business at all
// — the sign-up screen's first step — the currency is kept in a cookie and
// the account is created with it (lib/auth/service, lib/intake/service).

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { isIsoCurrency } from "../../../../lib/core/currencies";
import { logSafeError } from "../../../../lib/core/log-safe";
import type { AppLocale } from "../../../../lib/i18n/locales";
import { CURRENCY_COOKIE, isAppLocale, languageOpenTo } from "../../../../lib/i18n/locales";
import { isLanguageReviewer } from "../../../../lib/i18n/review";
import { languageCookieOptions } from "../../../../lib/i18n/server";
import { LocaleError, setBusinessLocale } from "../../../../lib/i18n/service";

const refuse = (error: string, code: "language" | "currency") =>
  NextResponse.json({ error, code }, { status: 422 });

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => null)) as {
      language?: unknown;
      currency?: unknown;
    } | null;
    const access = await resolveAccess();

    let language: AppLocale | undefined;
    if (body?.language !== undefined) {
      const reviewer = isLanguageReviewer(access?.session ?? null);
      if (!isAppLocale(body.language) || !languageOpenTo(body.language, reviewer)) {
        return refuse("that language isn't available yet", "language");
      }
      language = body.language;
    }
    let currency: string | undefined;
    if (body?.currency !== undefined) {
      const code = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "";
      if (!isIsoCurrency(code)) return refuse("that isn't a currency I know", "currency");
      currency = code;
    }
    if (language === undefined && currency === undefined) {
      return NextResponse.json({ error: "a language or a currency is needed" }, { status: 400 });
    }

    if (!access) {
      // No business yet (the sign-up screen): the browser keeps the currency
      // until the account exists. The business's language starts as the
      // person's own, from the language cookie, when the profile is made.
      const response = NextResponse.json({ kept: "browser", currency: currency ?? null });
      if (currency) response.cookies.set(CURRENCY_COOKIE, currency, languageCookieOptions());
      return response;
    }

    const denied = requireRole(access, "business.locale");
    if (denied) return denied;
    const now = await setBusinessLocale(access, { language, currency });
    console.log(
      JSON.stringify({
        event: "business_locale_changed",
        account_id: access.account_id,
        language: language ?? null,
        currency: currency ?? null,
      }),
    );
    return NextResponse.json(now);
  } catch (error) {
    if (error instanceof LocaleError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(JSON.stringify({ event: "business_locale_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
