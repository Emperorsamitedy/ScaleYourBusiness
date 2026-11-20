// The first step of the intake — L-1 (TASKS-LANGUAGES.md): the language,
// then the currency, before anything else is asked. Decluttered 2026-11-09
// on the owner's instruction: no kicker, no lede (the currency's
// no-conversion rule is under the form's "How this works").
//
// Since 2026-11-20 (the owner: "the interview pages aren't updated and they
// look soooooo bad") it wears the entrance's own look, the card of the
// sign-in page (components/auth/Login.tsx, app/auth-v2.css): a visitor who
// starts the interview without an account meets one product, not two. It
// had kept the look from before the entrance was redesigned: a serif
// headline on the desk, capitals, an arrow on its button.

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { PickerData } from "../../lib/i18n/picker";
import { Logo } from "../brand/Mark";
import { FirstStep } from "./LocalePicker";
import "../../app/auth-v2.css";
import "../../app/locale.css";

export async function FirstStepScreen({ data, signIn }: { data: PickerData; signIn?: boolean }) {
  const t = await getTranslations();
  return (
    <div className="ax ax-signin">
      <Link href="/" className="ax-logo">
        <Logo onDark />
      </Link>
      <main className="ax-card" aria-labelledby="ax-first-h">
        <div className="ax-head">
          <h1 className="ax-title" id="ax-first-h">
            {t("locale.first.headline")}
          </h1>
        </div>
        <FirstStep data={data} />
      </main>
      {signIn && (
        <p className="ax-switch">
          <Link href="/login">{t("auth.mast.signIn")}</Link>
        </p>
      )}
    </div>
  );
}
