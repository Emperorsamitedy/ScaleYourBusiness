// PUT /api/locale — the language this person reads SYB in (L-1, TASKS-LANGUAGES.md).
//
//   PUT { language }   → 200 { language }
//
// Anyone's own choice: a visitor before sign-up (kept in the language
// cookie only), and anyone on a team, whatever their role (also stored on
// their users row, so it follows them to another device). It changes
// nothing about the business — the business's language and currency are
// /api/locale/business, an owner's. The status gate applies: a language
// still in review is refused unless the signed-in person is a named
// reviewer (LANGUAGE_REVIEW_ACCOUNTS).

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE } from "../../../lib/auth/access";
import { requireRole } from "../../../lib/auth/roles";
import { currentSession } from "../../../lib/auth/service";
import { logSafeError } from "../../../lib/core/log-safe";
import { LANGUAGE_COOKIE, isAppLocale, languageOpenTo } from "../../../lib/i18n/locales";
import { isLanguageReviewer } from "../../../lib/i18n/review";
import { languageCookieOptions } from "../../../lib/i18n/server";
import { setOwnLanguage } from "../../../lib/i18n/service";

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const store = await cookies();
    const session = await currentSession(store.get(AUTH_COOKIE)?.value);
    if (session) {
      const denied = requireRole(session, "language.own");
      if (denied) return denied;
    }
    const body = (await request.json().catch(() => null)) as { language?: unknown } | null;
    const language = body?.language;
    if (!isAppLocale(language) || !languageOpenTo(language, isLanguageReviewer(session))) {
      return NextResponse.json(
        { error: "that language isn't available yet", code: "language" },
        { status: 422 },
      );
    }
    if (session) await setOwnLanguage(session.user_id, language);
    const response = NextResponse.json({ language });
    response.cookies.set(LANGUAGE_COOKIE, language, languageCookieOptions());
    return response;
  } catch (error) {
    console.error(JSON.stringify({ event: "locale_own_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
