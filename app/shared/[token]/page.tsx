// /shared/<token> — a read-only diagnosis report someone was sent (idea 51).
//
// A stranger's page, like /u/<token>: no rail, no sign-in, nothing about the
// viewer recorded. The token is the whole credential (lib/report/share.ts).
// The page shows the report as it was when the link was made, with nothing
// that leads into the account, and a footer saying so. Any link that
// doesn't work — unknown, revoked, expired, mistyped — gets the SAME plain
// page, so nobody can learn which links exist by trying them.
//
// L-6: the page's own words are in the viewer's language — the language
// cookie through the gate (lib/i18n/server requestLocale), as every page
// reads it; nothing else of the viewer's is read, and nothing is set.
//
// noindex and no-referrer here (metadata) and in next.config.ts's headers
// for /shared/*, where the response is also marked uncacheable.

import type { Metadata } from "next";
import { SharedReportScreen } from "@/components/report/SharedReport";
import type { ReportView } from "@/components/report/types";
import { wordsFor } from "../../../lib/i18n/recipient";
import { requestLocale } from "../../../lib/i18n/server";
import { viewSharedReport } from "../../../lib/report/share";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await wordsFor(await requestLocale(), "shared");
  return {
    title: t("pageTitle"),
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
  };
}
export const dynamic = "force-dynamic";

export default async function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const shared = await viewSharedReport(token);
  if (shared === null) {
    const { t } = await wordsFor(await requestLocale(), "shared");
    return (
      <main className="desk unsub-desk">
        <section className="sheet unsub-sheet" aria-labelledby="shared-dead-title">
          <p className="label">{t("label")}</p>
          <h1 className="display unsub-title" id="shared-dead-title">
            {t("deadTitle")}
          </h1>
          <p className="prose">{t("deadBody")}</p>
        </section>
      </main>
    );
  }
  const { shared_at: sharedAt, ...report } = shared;
  // The server's SharedReport is the browser's ReportView minus the owner-only parts.
  return <SharedReportScreen report={report as unknown as ReportView} sharedAt={sharedAt} />;
}
