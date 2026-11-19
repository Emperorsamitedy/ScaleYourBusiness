// /shadow — the owner's day-30 shadow summary (the v1 spec §4.2): what SYB
// would have done in the business's first 30 days, scored, and nothing
// touched. With a link to share it as it is.

import type { Metadata } from "next";
import { ShadowSummaryView } from "../../components/ladder/ShadowSummaryView";
import { ShareLink } from "../../components/ladder/ShareLink";
import { PageHead } from "../../components/sheet/PageHead";
import { resolveAccess } from "../../lib/auth/access";
import { shareToken } from "../../lib/ladder/share";
import { shadowSummaryFor } from "../../lib/ladder/shadow-summary";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";
import "../plain.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "shadowSummary")("meta.title") };
}
export const dynamic = "force-dynamic";

export default async function ShadowPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "shadowSummary");
  // It is a page of "What I may do", and says so as that screen does.
  const kicker = trFor(locale, "ladder")("kicker");
  const access = await resolveAccess();
  if (!access) {
    return (
      <main className="screen pg">
        <PageHead kicker={kicker} title={tr("none")} />
      </main>
    );
  }
  const { summary, currency } = await shadowSummaryFor(access.profile_id);
  return (
    <main className="screen pg">
      <PageHead kicker={kicker} title={tr("title")}>
        <p className="pg-acts">
          <ShareLink
            path={`/shared/shadow/${shareToken(access.profile_id)}`}
            label={tr("share")}
            done={tr("copied")}
          />
        </p>
      </PageHead>
      {/* The summary is drawn by the component the public shared page uses as it is. */}
      <div className="pg-stack pg-said">
        <ShadowSummaryView summary={summary} tr={tr} locale={locale} zeroWith={currency} />
      </div>
    </main>
  );
}
