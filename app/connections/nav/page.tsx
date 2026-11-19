// /connections/nav — NAV Online Számla, Hungary's invoice data (the
// multi-market spec §E.4). The owner's guide to creating a read-only
// technical user, step by step with real screenshots, then the form that
// proves it with NAV at once and shows the business's own registered name.
// The guide is offered only when every screenshot is in place and SYB's NAV
// software identity is configured; until then the page says it isn't
// available yet. Hungarian first; English for an owner reading in English.

import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { NavConnect } from "../../../components/connections/nav/NavConnect";
import { PageHead, SheetCard } from "../../../components/sheet/PageHead";
import type { AppLocale } from "../../../lib/i18n/locales";
import { isAppLocale } from "../../../lib/i18n/locales";
import { trFor } from "../../../lib/i18n/server-tr";
import { NAV_GUIDE_STEPS, navGuideReady } from "../../../lib/connectors/nav/guide";
import { navSoftwareFromEnv } from "../../../lib/connectors/nav/service";
import "../../plain.css";

export const metadata: Metadata = { title: "NAV Online Számla · ScaleX" };
export const dynamic = "force-dynamic";

export default async function NavPage() {
  const locale = await getLocale();
  const hu = locale !== "en";
  let configured: boolean;
  try {
    configured = navSoftwareFromEnv() !== null;
  } catch {
    configured = false;
  }
  const ready = configured && navGuideReady();
  // Where this screen sits, in the menu's own words.
  const where: AppLocale = isAppLocale(locale) ? locale : "en";
  const nav = trFor(where, "nav");
  const kicker = `${nav("group.business")} · ${nav("item.connections")}`;
  if (!ready) {
    return (
      <main className="screen pg">
        <PageHead kicker={kicker} title="NAV Online Számla">
          <p className="ph-lede">
            {hu
              ? "A NAV-kapcsolat még nem érhető el. Amint elkészül, itt lépésről lépésre végigvezetjük."
              : "Connecting NAV isn't available yet. When it is, this page walks you through it step by step."}
          </p>
        </PageHead>
      </main>
    );
  }
  return (
    <main className="screen pg">
      <PageHead kicker={kicker} title="NAV Online Számla">
        <p className="ph-lede">
          {hu
            ? "A ScaleX csak olvassa a számláit a NAV-ból: a kiállítottakat bevételként, a befogadottakat költségként. Semmit nem küld be és nem módosít."
            : "ScaleX only reads your invoices from NAV: those you issued as revenue, those you received as costs. It never submits or changes anything."}
        </p>
      </PageHead>
      <div className="pg-stack">
        <SheetCard>
          <ol className="nav-guide">
            {NAV_GUIDE_STEPS.map((s) => (
              <li key={s.image}>
                <p className="auth-copy">{hu ? s.hu : s.en}</p>
                <img src={`/nav-guide/${s.image}`} alt="" width={600} loading="lazy" />
              </li>
            ))}
          </ol>
          <NavConnect hu={hu} />
        </SheetCard>
      </div>
    </main>
  );
}
