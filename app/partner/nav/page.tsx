// /partner/nav — NAV Online Számla across the firm's book (multi-market spec
// §E.4, the bookkeeper path): every client whose mandate lets the firm help
// connect things, with where NAV stands for each, and one form to connect
// them all. A principal or manager only; each row is checked against its own
// mandate again when sent (lib/partners/nav).

import type { Metadata } from "next";
import Link from "next/link";
import { NavBulkForm } from "../../../components/partner/NavBulkForm";
import { PageHead, SheetCard } from "../../../components/sheet/PageHead";
import { requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";
import { firmOf } from "../../../lib/partners/access";
import { navBook } from "../../../lib/partners/nav";
import { partnerSession } from "../../../lib/partners/session";
import "../../plain.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "partner")("nav.title") };
}
export const dynamic = "force-dynamic";

const KEYS = [
  "col.client",
  "col.state",
  "col.login",
  "col.password",
  "col.signature_key",
  "col.tax_number",
  "state.connected",
  "state.failed",
  "state.none",
  "outcome.skipped",
  "outcome.not_found",
  "outcome.already_connected",
  "outcome.rejected",
  "outcome.not_configured",
  "outcome.rate_limited",
  "outcome.failed",
  "submit",
  "working",
  "revoke",
  "revokeConfirm",
  "revoked",
] as const;

export default async function PartnerNavPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "partner");
  const session = await partnerSession();
  const mine = session ? await firmOf(session.user_id) : null;
  const allowed = mine && mine.role !== "staff";
  const book = allowed && session ? await navBook(session.user_id) : [];
  const words: Record<string, string> = Object.fromEntries(KEYS.map((k) => [k, tr(`nav.${k}`)]));
  words["outcome.connected"] = tr("nav.outcome.connected", { name: "{name}" });
  words.summary = tr("nav.summary", {
    connected: "{connected}",
    rejected: "{rejected}",
    skipped: "{skipped}",
    other: "{other}",
  });
  words.failed = tr("failed", { why: "{why}" });
  return (
    <main className="screen pg partner-screen">
      <PageHead
        kicker={`${tr("kicker")}${mine ? ` · ${mine.firm.name}` : ""}`}
        title={tr("nav.title")}
      >
        {!allowed ? (
          <p className="ph-lede">{session ? tr("nav.notAllowed") : tr("noSession")}</p>
        ) : (
          <>
            <p className="ph-lede">{tr("nav.intro")}</p>
            <p className="ph-lede">{tr("nav.who")}</p>
          </>
        )}
        <p className="pg-acts on-desk">
          <Link className="act" href="/partner">
            {tr("client.back")}
          </Link>
        </p>
      </PageHead>
      {allowed &&
        (book.length === 0 ? (
          <SheetCard>
            <p>{tr("nav.empty")}</p>
          </SheetCard>
        ) : (
          <NavBulkForm
            clients={book.map((c) => ({ ...c, name: c.name ?? tr("unnamed") }))}
            words={words}
          />
        ))}
    </main>
  );
}
