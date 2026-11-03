// /history — the ledger: the scorecard's record and every superseded fact
// (Session E + the owner's History design, 2026-10-17), and SYB's own
// forecast track record (idea 54). The facts-changed half and the track
// record are read here, on the server, behind the same door as /api/trust;
// both are read-only and the screen renders without either if it fails.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { HistoryScreen } from "../../components/trust/HistoryScreen";
import { resolveAccess } from "../../lib/auth/access";
import { loadFactWords } from "../../lib/bank/words";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";
import { logSafeError } from "../../lib/core/log-safe";
import { trackRecord } from "../../lib/forecasts/load";
import type { TrackView } from "../../lib/forecasts/view";
import type { FactChange } from "../../lib/trust/fact-changes";
import { factChanges } from "../../lib/trust/fact-changes";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("history.meta");
  return { title: t("title") };
}

export default async function HistoryPage() {
  let facts: FactChange[] | null = null;
  let track: TrackView | null = null;
  const access = await resolveAccess().catch(() => null);
  if (access) {
    try {
      facts = await factChanges(access.profile_id);
      // L-3a: each fact named in the reader's language, from the bank's overlay.
      const locale = await requestLocale();
      if (locale !== "en") {
        const fw = await loadFactWords(locale);
        facts = facts.map((f) => {
          const label = fw.label(f.key);
          return label ? { ...f, label } : f;
        });
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "history_facts_error",
          account_id: access.account_id,
          ...logSafeError(error),
        }),
      );
    }
    try {
      // L-4a: the record's own words in the reader's language (lib/forecasts/view).
      const locale = await requestLocale();
      track = await trackRecord(access.profile_id, new Date(), {
        tr: trFor(locale, "trackWords"),
        locale,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "history_track_error",
          account_id: access.account_id,
          ...logSafeError(error),
        }),
      );
    }
  }
  return <HistoryScreen facts={facts} track={track} />;
}
