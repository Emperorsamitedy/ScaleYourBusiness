"use client";

// The language switch in the top right corner (the owner, 2026-11-20: "add a
// button to the top right corner which changes language between hun and
// eng"). Two short buttons, EN and HU, the one being read pressed in. It
// saves the person's own language through PUT /api/locale, the route every
// other picker uses (the cookie, and their users row when signed in), then
// reads the page again in that language. Nothing about the business moves:
// its language and its currency are the owner's, on the language settings.
//
// All seven languages are still on the language settings screen and in the
// entrance's footer; this is the short way between the two the owner asked
// for. Someone reading a third language sees neither pressed in.

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { AppLocale } from "../../lib/i18n/locales";
import { LANGUAGE_NAMES } from "../../lib/i18n/locales";
import "../../app/lang-toggle.css";

/** The two languages the corner switches between, in the order shown. */
export const TOGGLE_LANGUAGES = ["en", "hu-HU"] as const satisfies readonly AppLocale[];
type ToggleLanguage = (typeof TOGGLE_LANGUAGES)[number];

/** What each button says: the language's own two letters, the same in every catalogue. */
const SHORT: Readonly<Record<ToggleLanguage, string>> = { en: "EN", "hu-HU": "HU" };

export function LanguageToggle({ className }: { className?: string }) {
  const t = useTranslations("auth.foot");
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // Reading the page again in the other language takes a moment: the switch
  // stays busy until it has, so a second press cannot land in between.
  const [reading, startReading] = useTransition();

  const change = async (language: ToggleLanguage) => {
    if (busy || reading || language === locale) return;
    setBusy(true);
    try {
      const res = await fetch("/api/locale", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language }),
      });
      if (res.ok) startReading(() => router.refresh());
    } catch {
      // Unreachable: the page stays in the language it is in.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={className ? `lang-toggle ${className}` : "lang-toggle"}
      role="group"
      aria-label={t("language")}
      aria-busy={busy || reading}
    >
      {TOGGLE_LANGUAGES.map((language) => (
        <button
          key={language}
          type="button"
          lang={language}
          aria-pressed={locale === language}
          aria-label={LANGUAGE_NAMES[language]}
          title={LANGUAGE_NAMES[language]}
          disabled={busy || reading}
          onClick={() => void change(language)}
        >
          {SHORT[language]}
        </button>
      ))}
    </div>
  );
}

/**
 * The switch in the top right corner of a page that has no bar of its own
 * (the entrance: sign-in, sign-up, the free check, the idea check). It is
 * laid on the page itself, not on whatever card or column draws it, so it is
 * in the same corner on every one of them and scrolls away with the page.
 */
export function LanguageCorner() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <div className="ax-corner">
      <LanguageToggle />
    </div>,
    document.body,
  );
}
