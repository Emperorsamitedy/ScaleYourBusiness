// /check — the free one-number entry (v1 spec §8.1 stage 1, §8.2): six
// questions, no account, the result on the same page. Public.
//
// Dressed as the sign-up page since 2026-11-17 (the owner): the wordmark,
// the questions on paper and the reel beside them, so the landing page's
// button lands inside the same door as sign-in and sign-up.

import type { Metadata } from "next";
import Link from "next/link";
import { AuthReel } from "../../components/auth/AuthReel";
import { AuthFooter } from "../../components/auth/Login";
import { Logo } from "../../components/brand/Mark";
import { EntryForm } from "../../components/entry/EntryForm";
import { entryOptions } from "../../lib/entry/options";
import { pickerContext, requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";
import "../auth-v2.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "entry")("meta.title") };
}
export const dynamic = "force-dynamic";

export default async function CheckPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const locale = await requestLocale();
  const tr = trFor(locale, "entry");
  const ref = (await searchParams).ref;
  const [options, picker] = await Promise.all([entryOptions(locale, tr), pickerContext()]);
  return (
    <div className="ax ax-signup ax-check">
      <section className="ax-col">
        <div className="ax-col-in">
          <Link href="/" className="ax-logo">
            <Logo />
          </Link>
          <main className="ax-signup-main">
            <p className="ax-kicker">{tr("kicker")}</p>
            <h1 className="ax-title ax-title-lg">{tr("title")}</h1>
            <p className="ax-copy">{tr("intro")}</p>
            <EntryForm
              {...options}
              referredBy={ref && /^[A-Za-z0-9_-]{8,40}$/.test(ref) ? ref : null}
            />
            <p className="ax-switch-light">
              <Link href="/idea">{trFor(locale, "ideas")("fromCheck")}</Link>
            </p>
          </main>
          <AuthFooter languages={picker.data.languages} language={picker.data.language} />
        </div>
      </section>
      <AuthReel />
    </div>
  );
}
