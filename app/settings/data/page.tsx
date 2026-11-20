// /settings/data — the owner asks for this business to be erased (v1 spec §9.4).

import type { Metadata } from "next";
import { PostForm } from "../../../components/partner/PostForm";
import { PageHead, SheetCard } from "../../../components/sheet/PageHead";
import { resolveAccess } from "../../../lib/auth/access";
import { erasureOf } from "../../../lib/compliance/erasure";
import { dayMonthYear } from "../../../lib/i18n/format";
import { requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";
import "../../plain.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "erasure")("meta.title") };
}
export const dynamic = "force-dynamic";

export default async function DataPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "erasure");
  const nav = trFor(locale, "nav");
  const access = await resolveAccess();
  const r = access ? await erasureOf(access.profile_id) : null;
  return (
    <main className="screen pg">
      {/* Once asked, the headline is the state: when, and what it already did. */}
      <PageHead
        kicker={`${nav("group.business")} · ${nav("item.erasure")}`}
        title={
          r
            ? tr("requested", { date: dayMonthYear(r.requested_at.slice(0, 10), locale) })
            : tr("kicker")
        }
      />
      <div className="pg-stack">
        <SheetCard>
          <p>{tr("body")}</p>
          {!r && access && (
            <PostForm
              endpoint="/api/business/erasure"
              fixed={{}}
              submit={tr("ask")}
              failed={tr("failed", { why: "{why}" })}
              className="act"
            />
          )}
        </SheetCard>
      </div>
    </main>
  );
}
