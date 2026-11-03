// GET /api/profile/export?part=current|history — idea 49, the accountant
// export: the business's money facts as a CSV download (lib/profile/
// money-export.ts).
//
// Owner-only: the one door (lib/auth/access) AND a signed-in session for
// this profile's account. An anonymous intake (cookie only) can read its
// own fact sheet, but a file that leaves the product is the owner's call,
// so it needs the owner signed in. A GET that writes nothing; the response
// is an attachment that no cache keeps.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { loadFactWords } from "../../../../lib/bank/words";
import { logSafeError } from "../../../../lib/core/log-safe";
import { wordsFor } from "../../../../lib/i18n/recipient";
import { requestLocale } from "../../../../lib/i18n/server";
import type { ExportPart } from "../../../../lib/profile/money-export";
import {
  CURRENT_COLUMNS,
  HISTORY_COLUMNS,
  exportFileName,
  moneyExportRows,
  toCsv,
} from "../../../../lib/profile/money-export";

export async function GET(request: NextRequest): Promise<NextResponse | Response> {
  const access = await resolveAccess();
  if (!access?.session) {
    return NextResponse.json({ error: "sign in to download your figures" }, { status: 401 });
  }
  const requested = request.nextUrl.searchParams.get("part") ?? "current";
  if (requested !== "current" && requested !== "history") {
    return NextResponse.json({ error: "part must be current or history" }, { status: 400 });
  }
  const part: ExportPart = requested;
  try {
    // L-6: headings and labels in the reader's language; every cell stays machine-readable.
    const locale = await requestLocale();
    const words = await wordsFor(locale, "exports.money");
    const rows = await moneyExportRows({
      accountId: access.account_id,
      profileId: access.profile_id,
      part,
      ...(locale !== "en" ? { words: await loadFactWords(locale) } : {}),
    });
    const csv = toCsv(part === "current" ? CURRENT_COLUMNS : HISTORY_COLUMNS, rows, (c) =>
      words.t(c),
    );
    console.log(
      JSON.stringify({
        event: "money_export",
        account_id: access.account_id,
        part,
        rows: rows.length,
      }),
    );
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${exportFileName(part)}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "money_export_error",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
