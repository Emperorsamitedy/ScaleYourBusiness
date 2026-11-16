// /t/[slug] — gap 5 (TASKS-IDEAS): a kept idea's public test page. Shows the
// owner's one line and the plan's price, with an "I'd buy this" button; says
// it is a test and that nothing is sold or taken. Each render records a
// visit (once a day per visitor, as an HMAC). Kept out of search.

import type { Metadata } from "next";
import { headers } from "next/headers";
import { InterestButton } from "../../../components/ideas/InterestButton";
import { presentMoney } from "../../../lib/i18n/format";
import { requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";
import { pageBySlug, recordTestEvent, visitorOf } from "../../../lib/ideas/testpage";
import "../../ideas.css";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: trFor(await requestLocale(), "ideas")("testPage.title"),
    robots: { index: false },
  };
}
export const dynamic = "force-dynamic";

export default async function TestPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const locale = await requestLocale();
  const tr = trFor(locale, "ideas");
  const found = await pageBySlug(slug);
  if (found?.open) {
    const h = await headers();
    const address = h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0] ?? "";
    await recordTestEvent({
      page: found.page,
      kind: "visit",
      visitor: visitorOf(found.page.slug, address.trim(), h.get("user-agent") ?? ""),
    });
  }
  return (
    <main className="auth-stage">
      <div className="statement-col">
        <section className="card entry-col">
          {!found ? (
            <p className="auth-copy">{tr("testPage.missing")}</p>
          ) : !found.open ? (
            <p className="auth-copy">{tr("testPage.closed")}</p>
          ) : (
            <>
              <h1 className="auth-title">{found.page.pitch}</h1>
              <p className="entry-figure">
                {presentMoney(
                  { amount_minor: found.page.price_minor, currency: found.page.currency },
                  locale,
                )}
              </p>
              <InterestButton slug={found.page.slug} />
              <p className="auth-copy idea-note">{tr("testPage.honest")}</p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
