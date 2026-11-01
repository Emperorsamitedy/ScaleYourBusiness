// The first step of sign-up and of the intake — L-1 (TASKS-LANGUAGES.md):
// the language, then the currency, before anything else is asked. On the
// entrance screens' layout (ux-spec §2): the desk carries the promise, one
// paper sheet carries the choice.

import { getTranslations } from "next-intl/server";
import type { PickerData } from "../../lib/i18n/picker";
import { AuthMasthead } from "../auth/AuthMasthead";
import { FirstStep } from "./LocalePicker";
import "../../app/auth.css";
import "../../app/locale.css";

export async function FirstStepScreen({ data, signIn }: { data: PickerData; signIn?: boolean }) {
  const t = await getTranslations();
  return (
    <div className="desk au">
      {signIn ? (
        <AuthMasthead href="/login">
          <span className="au-mast-pre">{t("auth.mast.haveAccount")}</span>
          {t("auth.mast.signIn")}{" "}
          <span className="au-arrow" aria-hidden="true">
            &rarr;
          </span>
        </AuthMasthead>
      ) : (
        <AuthMasthead />
      )}
      <main className="au-main">
        <section className="au-lede">
          <p className="au-kicker">{t("locale.first.kicker")}</p>
          <h1 className="au-headline">{t("locale.first.headline")}</h1>
          <p className="lp-lede">{t("locale.first.lede")}</p>
        </section>
        <section className="sheet au-sheet" aria-labelledby="au-sheet-title">
          <header className="au-sheet-head">
            <p className="au-sheet-label">{t("locale.first.kicker")}</p>
            <h2 className="au-sheet-title" id="au-sheet-title">
              {t("locale.settings.title")}
            </h2>
          </header>
          <div className="au-sheet-body">
            <FirstStep data={data} />
          </div>
        </section>
      </main>
    </div>
  );
}
