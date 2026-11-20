// /shared/shadow/<token> — a day-30 shadow summary someone was sent (the v1
// spec §4.2: the conversion event, as a shareable artifact). A stranger's
// page: no rail, no sign-in, nothing about the viewer recorded, nothing that
// leads into the account. A link that doesn't work gets the same plain page.

import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "../../../../components/brand/Mark";
import { ShadowSummaryView } from "../../../../components/ladder/ShadowSummaryView";
import { readShareToken } from "../../../../lib/ladder/share";
import { shadowSummaryFor } from "../../../../lib/ladder/shadow-summary";
import { requestLocale } from "../../../../lib/i18n/server";
import { trFor } from "../../../../lib/i18n/server-tr";
import "../../../auth-v2.css";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: trFor(await requestLocale(), "shadowSummary")("meta.title"),
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
  };
}
export const dynamic = "force-dynamic";

export default async function SharedShadowPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const locale = await requestLocale();
  const tr = trFor(locale, "shadowSummary");
  const profileId = readShareToken(token);
  if (profileId === null) {
    return (
      <div className="ax ax-signin ax-dress">
        <Link href="/" className="ax-logo">
          <Logo onDark />
        </Link>
        <main className="ax-card">
          <p className="auth-copy">{tr("none")}</p>
        </main>
      </div>
    );
  }
  const { summary, currency } = await shadowSummaryFor(profileId);
  return (
    <div className="ax ax-signin ax-dress">
      <Link href="/" className="ax-logo">
        <Logo onDark />
      </Link>
      <main className="ax-card ax-card-wide">
        <ShadowSummaryView summary={summary} tr={tr} locale={locale} zeroWith={currency} />
      </main>
    </div>
  );
}
