// GET /api/page-setup — the guided page set-up's data (specs/page-setup-v1.md,
// TASKS-FEEDBACK.md "Guided page set-up").
//
//   { kit, connected: { page, instagram }, links }
//
// The kit is what to type into Facebook's and Instagram's own forms, taken
// from the business's fact sheet, each piece with where it came from; a fact
// the sheet does not hold is a gap with the interview question that fills
// it. `connected` is what the publishing connection holds today. `links` are
// the platforms' own guides.
//
// Behind the one door (lib/auth/access). GET only: this route reads. It has
// no way to create or claim a Page, takes nothing from the caller, sends
// nothing to a platform, and is the same on every plan.

import { NextResponse } from "next/server";
import { resolveAccess } from "../../../lib/auth/access";
import { logSafeError } from "../../../lib/core/log-safe";
import { requestLocale } from "../../../lib/i18n/server";
import { PAGE_SETUP_LINKS } from "../../../lib/pages/kit";
import { loadPageSetup } from "../../../lib/pages/kit-load";

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const view = await loadPageSetup(access.account_id, access.profile_id, await requestLocale());
    return NextResponse.json({ ...view, links: PAGE_SETUP_LINKS });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "page_setup_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
