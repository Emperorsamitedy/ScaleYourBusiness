// /summary/stop/<token> — where the weekly summary's "stop these emails"
// link lands (idea 42). No rail, no sign-in, no cookie: GET shows one
// button and writes nothing, so a link scanner or a mail preview stops
// nothing. The button POSTs to /api/summary/stop/<token>, which switches
// the summary off and comes back here. It changes nothing else.

import type { Metadata } from "next";
import Link from "next/link";
import { viewStop } from "../../../../lib/summary/prefs";

export const metadata: Metadata = {
  title: "Weekly summary — SYB",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function StopSummaryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await viewStop(token);
  return (
    <main className="desk unsub-desk">
      <section className="sheet unsub-sheet" aria-labelledby="stop-title">
        <p className="label">Email preferences</p>
        {view === null ? (
          <>
            <h1 className="display unsub-title" id="stop-title">
              This link isn&rsquo;t one we recognise.
            </h1>
            <p className="prose">
              Check that the whole link from the email was copied. Nothing has changed.
            </p>
          </>
        ) : view.stopped ? (
          <>
            <h1 className="display unsub-title" id="stop-title">
              The weekly summary is off.
            </h1>
            <p className="prose">
              I won&rsquo;t email it again. Everything it reported is still on your{" "}
              <Link href="/watch">Watching</Link> screen, and you can switch it back on there.
            </p>
          </>
        ) : (
          <>
            <h1 className="display unsub-title" id="stop-title">
              Stop the weekly summary email?
            </h1>
            <p className="prose">
              One click and it stops. Sign-in links and the Support screen&rsquo;s notices are not
              affected.
            </p>
            <form method="post" action={`/api/summary/stop/${encodeURIComponent(token)}`}>
              <input type="hidden" name="confirm" value="1" />
              <button type="submit" className="act solid">
                Stop these emails <span aria-hidden="true">→</span>
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
