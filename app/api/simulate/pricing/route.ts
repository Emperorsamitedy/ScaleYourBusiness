// What-if pricing's API — idea 43.
//
//   GET /api/simulate/pricing   the owner's priced products and services, each figure
//                               with its provenance, and the response band for their
//                               kind of business. The arithmetic runs in
//                               lib/simulate/pricing.ts on either side.
//
// Read-only, and there is no POST: what-if pricing never changes a price and
// never makes a proposal that would (rule 18 keeps checkout and payments
// untouchable). Reading needs the intake cookie, as /api/simulate does.

import { NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { logSafeError } from "../../../../lib/core/log-safe";
import { gatherPricingInputs } from "../../../../lib/simulate/pricing-inputs";
import { SIM_WORDS } from "../../../../lib/simulate/words";
import { requestWords } from "../../../../lib/i18n/request-words";

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    // L-4b: the figures' sources in the reader's words; the figures stay as measured.
    const words = await requestWords(SIM_WORDS);
    const inputs = await gatherPricingInputs(access.profile_id, undefined, words);
    return NextResponse.json({ inputs });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "simulate_pricing_read_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on my side" }, { status: 500 });
  }
}
