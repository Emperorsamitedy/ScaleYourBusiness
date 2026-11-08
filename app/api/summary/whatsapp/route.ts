// The weekly summary on WhatsApp: the owner's yes, and taking it back — P6-07.
//
//   POST   /api/summary/whatsapp   { number, locale, consent } — record the yes (rule 19)
//   DELETE /api/summary/whatsapp           — withdraw it, now
//   DELETE /api/summary/whatsapp?erase=1   — withdraw it and forget the number (rule 22)
//
// Behind the one door, owner role (summary.settings), and only for the
// owner the summary goes to: a yes for a number is its holder's own. The
// consent sentence comes back exactly as the screen showed it, and is
// recorded only when it is word for word what that language says
// (lib/summary/whatsapp-optin). Nothing here returns the number whole.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { isAppLocale } from "../../../../lib/i18n/locales";
import { accountOwner } from "../../../../lib/summary/prefs";
import { maskNumber } from "../../../../lib/summary/whatsapp";
import { eraseWhatsAppNumbers, optIn, withdrawOptin } from "../../../../lib/summary/whatsapp-optin";

async function recipient() {
  const access = await resolveAccess();
  if (!access) {
    return { error: NextResponse.json({ error: "no intake session" }, { status: 401 }) };
  }
  const denied = requireRole(access, "summary.settings");
  if (denied) return { error: denied };
  const owner = await accountOwner(access.account_id);
  if (!owner || access.session?.user_id !== owner.id) {
    return {
      error: NextResponse.json(
        { error: "only the owner the summary goes to can give or take back this yes" },
        { status: 409 },
      ),
    };
  }
  return { access, owner };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const r = await recipient();
  if ("error" in r) return r.error!;
  const denied = requireRole(r.access, "summary.settings");
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as {
    number?: unknown;
    locale?: unknown;
    consent?: unknown;
  };
  if (
    typeof body.number !== "string" ||
    typeof body.consent !== "string" ||
    !isAppLocale(body.locale)
  ) {
    return NextResponse.json({ error: "number, locale and consent are needed" }, { status: 422 });
  }
  const result = await optIn({
    accountId: r.access.account_id,
    userId: r.owner.id,
    number: body.number,
    locale: body.locale,
    shown: body.consent,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason },
      { status: result.reason === "invalid_number" ? 422 : 409 },
    );
  }
  return NextResponse.json({
    opted_in: true,
    number: maskNumber(result.optin.phone_number),
    opted_in_at: result.optin.opted_in_at,
  });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const r = await recipient();
  if ("error" in r) return r.error!;
  const denied = requireRole(r.access, "summary.settings");
  if (denied) return denied;
  const erase = request.nextUrl.searchParams.get("erase") === "1";
  const withdrawn = await withdrawOptin(r.owner.id, r.access.account_id);
  const erased = erase ? await eraseWhatsAppNumbers(r.owner.id) : 0;
  return NextResponse.json({ opted_in: false, withdrawn, erased });
}
