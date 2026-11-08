// The files the owner takes to their own bank — P6-05 (rule 26 amended).
//
//   GET /api/payments/file?format=sepa[&ids=<id>,<id>]
//       a SEPA credit-transfer file (pain.001.001.03) of the READY payments
//       (approved, not marked paid) that are in euros between SEPA IBANs,
//       debited from the "pay from" details the owner stated
//   GET /api/payments/file?format=steps[&ids=…]
//       plain step-by-step instructions for every ready payment, any currency
//
// GET only: a download, never a send. The owner's own (the files carry full
// IBANs), and every download is logged with the account id and the count —
// the IBANs never. Only approved payments are ever read for a file
// (readyPayments), and the renderer refuses anything else (rule 12).

import { randomBytes } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { logSafeError } from "../../../../lib/core/log-safe";
import { requestWords } from "../../../../lib/i18n/request-words";
import { handInstructions } from "../../../../lib/payments/instructions";
import { renderPain001, sepaBar } from "../../../../lib/payments/sepa";
import { currentPayer, readyPayments } from "../../../../lib/payments/store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A message id unique per file: SYB, the moment, and a random tail (35 characters at most). */
function fileMessageId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `SYB${stamp}${randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "payments.prepare");
  if (denied) return denied;
  const format = request.nextUrl.searchParams.get("format");
  if (format !== "sepa" && format !== "steps") {
    return NextResponse.json({ error: 'format must be "sepa" or "steps"' }, { status: 422 });
  }
  const ids = (request.nextUrl.searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s));
  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const [payer, ready] = await Promise.all([
      currentPayer(access.profile_id),
      readyPayments(access.profile_id, ids),
    ]);
    if (ready.length === 0) {
      return NextResponse.json(
        {
          error: "nothing is ready for your bank: a payment needs approving first",
          code: "none_ready",
        },
        { status: 409 },
      );
    }
    if (format === "steps") {
      const words = await requestWords("payments.steps");
      const bars = new Map(ready.map((p) => [p.id, sepaBar(p, payer)]));
      const text = handInstructions(ready, payer, words, bars);
      log(access.account_id, "steps", ready.length, null);
      return new NextResponse(text, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="syb-payments-${today}.txt"`,
          "cache-control": "no-store",
        },
      });
    }
    if (payer === null) {
      return NextResponse.json(
        { error: "a SEPA file needs the bank details you pay from, stated once", code: "no_payer" },
        { status: 409 },
      );
    }
    const inFile = ready.filter((p) => sepaBar(p, payer) === null);
    if (inFile.length === 0) {
      return NextResponse.json(
        {
          error: "none of the ready payments can go in a SEPA file (euros between SEPA IBANs only)",
          code: "none_for_file",
        },
        { status: 409 },
      );
    }
    const file = renderPain001({
      debtor: payer,
      payments: inFile,
      msg_id: fileMessageId(now),
      created_at: now.toISOString(),
      today,
    });
    log(access.account_id, "sepa", file.nb_of_txs, file.ctrl_sum_minor, file.msg_id);
    return new NextResponse(file.xml, {
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "content-disposition": `attachment; filename="syb-sepa-${today}.xml"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "payments_file_failed",
        account_id: access.account_id,
        format,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on my side" }, { status: 500 });
  }
}

function log(
  accountId: string,
  format: "sepa" | "steps",
  count: number,
  ctrlSumMinor: number | null,
  msgId?: string,
) {
  console.log(
    JSON.stringify({
      event: "payments_file",
      account_id: accountId,
      format,
      count,
      ...(ctrlSumMinor !== null ? { ctrl_sum_minor: ctrlSumMinor, currency: "EUR" } : {}),
      ...(msgId ? { msg_id: msgId } : {}),
    }),
  );
}
