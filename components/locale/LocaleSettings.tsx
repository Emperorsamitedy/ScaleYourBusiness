"use client";

// /settings/language — Your business · Language and currency (L-1).
//
// Two cards. "You": the language this person reads SYB in — anyone's own
// choice, whatever their role. "This business": the language its
// customers will read and the currency every figure is in — an owner's;
// anyone else sees them and is told who can change them. Saving refreshes
// the page in place, so the screen speaks the new language at once.

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import type { AppLocale } from "../../lib/i18n/locales";
import { LANGUAGE_NAMES } from "../../lib/i18n/locales";
import type { PickerData } from "../../lib/i18n/picker";
import { PageHead, SheetCard } from "../sheet/PageHead";
import type { SaveRefusal } from "./LocalePicker";
import {
  CurrencyChoice,
  LanguageChoice,
  refusalKey,
  saveBusinessLocale,
  saveOwnLanguage,
} from "./LocalePicker";

export interface LocaleSettingsProps {
  data: PickerData;
  /** The business's language and currency, or null when there's no business yet. */
  business: { language: AppLocale; currency: string } | null;
}

export function LocaleSettings({ data, business }: LocaleSettingsProps) {
  const t = useTranslations();
  const router = useRouter();
  const currencyId = useId();
  const [own, setOwn] = useState<AppLocale>(data.language);
  const [bizLanguage, setBizLanguage] = useState<AppLocale | null>(business?.language ?? null);
  const [currency, setCurrency] = useState<string | null>(business?.currency ?? null);
  const [busy, setBusy] = useState<"own" | "business" | null>(null);
  const [notice, setNotice] = useState<{ part: "own" | "business"; text: string } | null>(null);

  const say = (part: "own" | "business", failed: SaveRefusal | null) =>
    setNotice({ part, text: failed === null ? t("common.saved") : t(refusalKey(failed)) });

  const saveOwn = async () => {
    setBusy("own");
    const failed = await saveOwnLanguage(own);
    setBusy(null);
    say("own", failed);
    if (failed === null) router.refresh();
  };

  const saveBusiness = async () => {
    if (!bizLanguage || !currency) return;
    setBusy("business");
    const failed = await saveBusinessLocale({ language: bizLanguage, currency });
    setBusy(null);
    say("business", failed);
    if (failed === null) router.refresh();
  };

  // A business language no longer open to this person still shows, so nothing is silently changed.
  const bizLanguages =
    bizLanguage && !data.languages.some((l) => l.code === bizLanguage)
      ? [
          ...data.languages,
          { code: bizLanguage, name: LANGUAGE_NAMES[bizLanguage], checking: true },
        ]
      : data.languages;

  return (
    <main className="screen lp-screen">
      <PageHead
        kicker={`${t("locale.settings.kicker")} · ${t("locale.settings.title")}`}
        title={t("locale.settings.title")}
      />
      <SheetCard label={t("locale.settings.you")} title={t("locale.yourLanguage")}>
        <p className="lp-help">{t("locale.yourLanguageHelp")}</p>
        <LanguageChoice
          languages={data.languages}
          value={own}
          onChange={setOwn}
          disabled={busy !== null}
          legend={t("locale.yourLanguage")}
        />
        <div className="lp-actions">
          <button
            type="button"
            className="act solid"
            disabled={busy !== null}
            onClick={() => void saveOwn()}
          >
            {busy === "own" ? t("common.saving") : t("common.save")}
          </button>
          {notice?.part === "own" && (
            <p className="lp-notice" role="status">
              {notice.text}
            </p>
          )}
        </div>
      </SheetCard>

      {business && bizLanguage && (
        <SheetCard label={t("locale.settings.business")} title={t("locale.businessLanguage")}>
          <p className="lp-help">{t("locale.businessLanguageHelp")}</p>
          <LanguageChoice
            languages={bizLanguages}
            value={bizLanguage}
            onChange={setBizLanguage}
            disabled={!data.canSetBusiness || busy !== null}
            legend={t("locale.businessLanguage")}
          />
          <div className="lp-field">
            <label className="au-label" htmlFor={currencyId}>
              {t("locale.currency")}
            </label>
            <CurrencyChoice
              id={currencyId}
              currencies={data.currencies}
              value={currency}
              onChange={setCurrency}
              disabled={!data.canSetBusiness || busy !== null}
            />
            <p className="lp-help">{t("locale.currencyHelp")}</p>
          </div>
          {data.canSetBusiness ? (
            <div className="lp-actions">
              <button
                type="button"
                className="act solid"
                disabled={busy !== null || !currency}
                onClick={() => void saveBusiness()}
              >
                {busy === "business" ? t("common.saving") : t("locale.settings.saveBusiness")}
              </button>
              {notice?.part === "business" && (
                <p className="lp-notice" role="status">
                  {notice.text}
                </p>
              )}
            </div>
          ) : (
            <p className="lp-help">{t("locale.onlyOwner")}</p>
          )}
        </SheetCard>
      )}

      {data.languages.some((l) => l.checking) && (
        <p className="lp-help">{t("locale.checkingNote")}</p>
      )}
    </main>
  );
}
