// The first step of sign-up and of the intake — L-1 (TASKS-LANGUAGES.md):
// the language, then the currency, before anything else is asked. On the
// entrance screens' layout (ux-spec §2): the desk carries the headline, one
// paper sheet carries the choice. Decluttered 2026-11-09 on the owner's
// instruction: no kicker, no lede (the currency's no-conversion rule is
// under the form's "How this works").

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
          <h1 className="au-headline" id="au-first-h">
            {t("locale.first.headline")}
          </h1>
        </section>
        <section className="sheet au-sheet" aria-labelledby="au-first-h">
          <div className="au-sheet-body">
            <FirstStep data={data} />
          </div>
        </section>
      </main>
    </div>
  );
}
