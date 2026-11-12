// /check — the free one-number entry (v1 spec §8.1 stage 1, §8.2): six
// questions, no account, the result on the same page. Public.

import type { Metadata } from "next";
import { EntryForm } from "../../components/entry/EntryForm";
import { entryOptions } from "../../lib/entry/options";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";

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
  const options = await entryOptions(locale, tr);
  return (
    <main className="auth-stage">
      <div className="statement-col">
        <section className="card">
          <span className="auth-eyebrow">{tr("kicker")}</span>
          <h1 className="auth-title">{tr("title")}</h1>
          <p className="auth-copy">{tr("intro")}</p>
        </section>
        <EntryForm
          {...options}
          referredBy={ref && /^[A-Za-z0-9_-]{8,40}$/.test(ref) ? ref : null}
        />
      </div>
    </main>
  );
}
