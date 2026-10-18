// /history — the ledger: the scorecard's record and every superseded fact
// (Session E + the owner's History design, 2026-10-17). The facts-changed
// half is read here, on the server, behind the same door as /api/trust;
// it is read-only and the screen renders without it if it fails.

import type { Metadata } from "next";
import { HistoryScreen } from "../../components/trust/HistoryScreen";
import { resolveAccess } from "../../lib/auth/access";
import { logSafeError } from "../../lib/core/log-safe";
import type { FactChange } from "../../lib/trust/fact-changes";
import { factChanges } from "../../lib/trust/fact-changes";

export const metadata: Metadata = { title: "History — Ledgerline" };

export default async function HistoryPage() {
  let facts: FactChange[] | null = null;
  const access = await resolveAccess().catch(() => null);
  if (access) {
    try {
      facts = await factChanges(access.profile_id);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "history_facts_error",
          account_id: access.account_id,
          ...logSafeError(error),
        }),
      );
    }
  }
  return <HistoryScreen facts={facts} />;
}
