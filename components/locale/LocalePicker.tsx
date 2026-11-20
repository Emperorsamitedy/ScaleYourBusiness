"use client";

// The language and currency picker — L-1 (TASKS-LANGUAGES.md).
//
// FirstStep is the first thing a new visitor answers, on the sign-up
// screen and at the start of the intake: the language they read SYB in,
// and the currency every figure for their business is in (any ISO 4217
// code; nothing is ever converted). The settings screen uses the same two
// choices separately (components/locale/LocaleSettings.tsx).
//
// Choosing saves through the two routes — /api/locale for the person,
// /api/locale/business for the business — then refreshes the page in
// place, so the screen speaks the new language and nothing typed is lost.

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import type { AppLocale } from "../../lib/i18n/locales";
import type { CurrencyOption, LanguageOption, PickerData } from "../../lib/i18n/picker";

/** Why a save didn't happen, in a word the screen turns into its own sentence. */
export type SaveRefusal = "language" | "currency" | "role" | "unreachable" | "error";

async function put(url: string, body: Record<string, unknown>): Promise<SaveRefusal | null> {
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    if (res.status === 401 || res.status === 403) return "role";
    const payload = (await res.json().catch(() => null)) as { code?: unknown } | null;
    return payload?.code === "language" || payload?.code === "currency" ? payload.code : "error";
  } catch {
    return "unreachable";
  }
}

/** The catalogue key of a refusal's sentence. */
export function refusalKey(refusal: SaveRefusal) {
  switch (refusal) {
    case "language":
      return "locale.unavailable" as const;
    case "currency":
      return "locale.badCurrency" as const;
    case "role":
      return "locale.onlyOwner" as const;
    case "unreachable":
      return "common.unreachable" as const;
    default:
      return "common.somethingWrong" as const;
  }
}

/** Save the person's language; null on success, else the reason. */
export function saveOwnLanguage(language: AppLocale) {
  return put("/api/locale", { language });
}

/** Save the business's language and/or currency; null on success, else the reason. */
export function saveBusinessLocale(change: { language?: AppLocale; currency?: string }) {
  return put("/api/locale/business", change);
}

export function LanguageChoice({
  languages,
  value,
  onChange,
  disabled,
  legend,
}: {
  languages: LanguageOption[];
  value: AppLocale;
  onChange: (v: AppLocale) => void;
  disabled?: boolean;
  legend: string;
}) {
  const t = useTranslations("locale");
  const name = useId();
  return (
    <fieldset className="lp-langs" disabled={disabled}>
      <legend className="au-label">{legend}</legend>
      {languages.map((l) => (
        <label key={l.code} className="lp-lang">
          <input
            type="radio"
            name={name}
            value={l.code}
            checked={value === l.code}
            onChange={() => onChange(l.code)}
          />
          <span lang={l.code}>{l.name}</span>
          {l.checking && <span className="lp-checking">{t("beingChecked")}</span>}
        </label>
      ))}
    </fieldset>
  );
}

export function CurrencyChoice({
  currencies,
  value,
  onChange,
  disabled,
  id,
}: {
  currencies: CurrencyOption[];
  value: string | null;
  onChange: (v: string) => void;
  disabled?: boolean;
  id: string;
}) {
  const t = useTranslations("locale");
  return (
    <select
      id={id}
      className="au-input lp-select"
      required
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="" disabled>
        {t("currencyChoose")}
      </option>
      {currencies.map((c) => (
        <option key={c.code} value={c.code}>
          {t("currencyOption", { code: c.code, name: c.name })}
        </option>
      ))}
    </select>
  );
}

/** The first step: language, then currency, then on. */
export function FirstStep({ data }: { data: PickerData }) {
  const t = useTranslations();
  const router = useRouter();
  const [language, setLanguage] = useState<AppLocale>(data.language);
  const [currency, setCurrency] = useState<string | null>(data.currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currencyId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (data.canSetBusiness && !currency) return;
    setBusy(true);
    setError(null);
    const own = await saveOwnLanguage(language);
    const business =
      own === null && data.canSetBusiness && currency
        ? await saveBusinessLocale({ language, currency })
        : null;
    const failed = own ?? business;
    if (failed !== null) {
      setBusy(false);
      setError(t(refusalKey(failed)));
      return;
    }
    // The page is re-read in the new language; nothing on it is lost.
    router.refresh();
  };

  return (
    <form className="ax-form lp-first" onSubmit={(e) => void submit(e)}>
      <LanguageChoice
        languages={data.languages}
        value={language}
        onChange={setLanguage}
        disabled={busy}
        legend={t("locale.yourLanguage")}
      />
      {data.canSetBusiness && (
        <div className="ax-field lp-currency">
          <label className="au-label" htmlFor={currencyId}>
            {t("locale.currency")}
          </label>
          <CurrencyChoice
            id={currencyId}
            currencies={data.currencies}
            value={currency}
            onChange={setCurrency}
            disabled={busy}
          />
        </div>
      )}
      <button
        className="ax-btn ax-primary"
        type="submit"
        disabled={busy || (data.canSetBusiness && !currency)}
      >
        {busy ? t("common.saving") : t("common.continue")}
      </button>
      {error && (
        <p className="ax-error" role="alert">
          {error}
        </p>
      )}
      {/* Decluttered 2026-11-09: the currency rule and the "being checked" note, folded. */}
      {(data.canSetBusiness || data.languages.some((l) => l.checking)) && (
        <details className="ax-how">
          <summary>{t("auth.how")}</summary>
          {data.canSetBusiness && <p>{t("locale.currencyHelp")}</p>}
          {data.languages.some((l) => l.checking) && <p>{t("locale.checkingNote")}</p>}
        </details>
      )}
    </form>
  );
}
