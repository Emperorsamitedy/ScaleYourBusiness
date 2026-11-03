// /summary/stop/<token> — where the weekly summary's "stop these emails"
// link lands (idea 42). No rail, no sign-in, no cookie: GET shows one
// button and writes nothing, so a link scanner or a mail preview stops
// nothing. The button POSTs to /api/summary/stop/<token>, which switches
// the summary off and comes back here. It changes nothing else.
//
// L-3d: its words are the "summaryStop" catalogue, in the language this
// browser reads (the cookie, through the status gate); the email itself
// is L-6.

import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { viewStop } from "../../../../lib/summary/prefs";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("summaryStop");
  return { title: t("meta"), robots: { index: false, follow: false } };
}
export const dynamic = "force-dynamic";

export default async function StopSummaryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await viewStop(token);
  const t = await getTranslations("summaryStop");
  return (
    <main className="desk unsub-desk">
      <section className="sheet unsub-sheet" aria-labelledby="stop-title">
        <p className="label">{t("label")}</p>
        {view === null ? (
          <>
            <h1 className="display unsub-title" id="stop-title">
              {t("unknown.title")}
            </h1>
            <p className="prose">{t("unknown.body")}</p>
          </>
        ) : view.stopped ? (
          <>
            <h1 className="display unsub-title" id="stop-title">
              {t("stopped.title")}
            </h1>
            <p className="prose">
              {t.rich("stopped.body", { watch: (chunks) => <Link href="/watch">{chunks}</Link> })}
            </p>
          </>
        ) : (
          <>
            <h1 className="display unsub-title" id="stop-title">
              {t("ask.title")}
            </h1>
            <p className="prose">{t("ask.body")}</p>
            <form method="post" action={`/api/summary/stop/${encodeURIComponent(token)}`}>
              <input type="hidden" name="confirm" value="1" />
              <button type="submit" className="act solid">
                {t("ask.button")} <span aria-hidden="true">→</span>
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
