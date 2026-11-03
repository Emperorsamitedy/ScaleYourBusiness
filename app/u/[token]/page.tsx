// /u/<token> — the unsubscribe page a campaign email links to (P4-15, rule 23).
//
// A stranger's page: no rail, no sign-in, no cookie. GET shows the business
// name and ONE button, and writes nothing, so a link scanner or a mail
// preview that follows the link unsubscribes nobody. The button POSTs to
// /api/u/<token>, which writes the suppression at once and comes back here.
// Everything it reads goes through lib/unsubscribe, whose import fence keeps
// it to the database, hashing and the suppression write.
//
// L-6: whoever holds the link is one of the business's customers, so the
// page speaks the business's language (lib/unsubscribe unsubscribeLocale,
// through the gate); a link SYB never minted is answered in English.

import type { Metadata } from "next";
import { unsubscribeLocale, viewUnsubscribe } from "../../../lib/unsubscribe/unsubscribe";
import { wordsFor } from "../../../lib/i18n/recipient";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { t } = await wordsFor(await unsubscribeLocale((await params).token), "unsubscribe");
  return { title: t("campaign.pageTitle"), robots: { index: false, follow: false } };
}

export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await viewUnsubscribe(token);
  const { locale, t } = await wordsFor(await unsubscribeLocale(token), "unsubscribe");
  const business = view?.business ?? t("campaign.thisBusiness");
  return (
    <main className="desk unsub-desk" lang={locale}>
      <section className="sheet unsub-sheet" aria-labelledby="unsub-title">
        <p className="label">{t("label")}</p>
        {view === null ? (
          <>
            <h1 className="display unsub-title" id="unsub-title">
              {t("unknownTitle")}
            </h1>
            <p className="prose">{t("unknownBody")}</p>
          </>
        ) : view.done ? (
          <>
            <h1 className="display unsub-title" id="unsub-title">
              {t("campaign.doneTitle", { business })}
            </h1>
            <p className="prose">{t("campaign.doneBody")}</p>
          </>
        ) : (
          <>
            <h1 className="display unsub-title" id="unsub-title">
              {t("campaign.askTitle", { business })}
            </h1>
            <p className="prose">{t("campaign.askBody")}</p>
            <form method="post" action={`/api/u/${encodeURIComponent(token)}`}>
              <input type="hidden" name="confirm" value="1" />
              <button type="submit" className="act solid">
                {t("campaign.button")} <span aria-hidden="true">→</span>
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
