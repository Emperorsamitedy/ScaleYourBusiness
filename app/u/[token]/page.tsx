// /u/<token> — the unsubscribe page a campaign email links to (P4-15, rule 23).
//
// A stranger's page: no rail, no sign-in, no cookie. GET shows the business
// name and ONE button, and writes nothing, so a link scanner or a mail
// preview that follows the link unsubscribes nobody. The button POSTs to
// /api/u/<token>, which writes the suppression at once and comes back here.
// Everything it reads goes through lib/unsubscribe, whose import fence keeps
// it to the database, hashing and the suppression write.

import type { Metadata } from "next";
import { viewUnsubscribe } from "../../../lib/unsubscribe/unsubscribe";

export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await viewUnsubscribe(token);
  return (
    <main className="desk unsub-desk">
      <section className="sheet unsub-sheet" aria-labelledby="unsub-title">
        <p className="label">Email preferences</p>
        {view === null ? (
          <>
            <h1 className="display unsub-title" id="unsub-title">
              This link isn&rsquo;t one we recognise.
            </h1>
            <p className="prose">
              Check that the whole link from the email was copied. Nothing has changed.
            </p>
          </>
        ) : view.done ? (
          <>
            <h1 className="display unsub-title" id="unsub-title">
              You&rsquo;re unsubscribed from {view.business}.
            </h1>
            <p className="prose">
              They won&rsquo;t send you marketing email through Ledgerline again. This is permanent;
              you don&rsquo;t need to do anything else.
            </p>
          </>
        ) : (
          <>
            <h1 className="display unsub-title" id="unsub-title">
              Stop marketing email from {view.business}?
            </h1>
            <p className="prose">
              One click and it&rsquo;s done, for good. Replies to your own questions are not
              affected.
            </p>
            <form method="post" action={`/api/u/${encodeURIComponent(token)}`}>
              <input type="hidden" name="confirm" value="1" />
              <button type="submit" className="act solid">
                Unsubscribe <span aria-hidden="true">→</span>
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
