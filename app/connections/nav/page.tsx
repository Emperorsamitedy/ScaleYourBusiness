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
import { NAV_GUIDE_STEPS, navGuideReady } from "../../../lib/connectors/nav/guide";
import { navSoftwareFromEnv } from "../../../lib/connectors/nav/service";

export const metadata: Metadata = { title: "NAV Online Számla — ScaleX" };
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
  return (
    <main className="auth-stage">
      <section className="card">
        <span className="auth-eyebrow">NAV Online Számla</span>
        {!ready ? (
          <p className="auth-copy">
            {hu
              ? "A NAV-kapcsolat még nem érhető el. Amint elkészül, itt lépésről lépésre végigvezetjük."
              : "Connecting NAV isn't available yet. When it is, this page walks you through it step by step."}
          </p>
        ) : (
          <>
            <p className="auth-copy">
              {hu
                ? "A ScaleX csak olvassa a számláit a NAV-ból: a kiállítottakat bevételként, a befogadottakat költségként. Semmit nem küld be és nem módosít."
                : "ScaleX only reads your invoices from NAV: those you issued as revenue, those you received as costs. It never submits or changes anything."}
            </p>
            <ol className="nav-guide">
              {NAV_GUIDE_STEPS.map((s) => (
                <li key={s.image}>
                  <p className="auth-copy">{hu ? s.hu : s.en}</p>
                  <img src={`/nav-guide/${s.image}`} alt="" width={600} loading="lazy" />
                </li>
              ))}
            </ol>
            <NavConnect hu={hu} />
          </>
        )}
      </section>
    </main>
  );
}
