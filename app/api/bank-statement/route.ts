// /api/bank-statement — a bank statement's balance (I-54a).
//
//   GET   the latest statement balance on record: the day it runs to, the
//         closing balance and its currency; null when none was imported
//   POST  { csv, currency, decimal_style?, date_order?, through? } — read a
//         statement's dates and running balance into a closing balance a
//         day (lib/balance/import.ts)
//
// Reading needs the intake cookie; importing is the owner's (data.import),
// signed in, from SYB's own pages. Nothing here talks to a bank: the owner
// exports the file and gives it to SYB, and only the date and balance
// columns are read. It moves nothing (rule 26).

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../lib/auth/access";
import { requireRole } from "../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { BalanceImportError, importBankStatement } from "../../../lib/balance/import";
import { latestBalance } from "../../../lib/cash/load";
import { logSafeError } from "../../../lib/core/log-safe";
import { isDecimalStyle } from "../../../lib/core/money";

export interface BankStatementView {
  latest: { day: string; amount_minor: number; currency: string } | null;
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const b = await latestBalance(access.account_id, today);
    const body: BankStatementView = {
      latest: b
        ? { day: b.fact.on!, amount_minor: b.fact.amount_minor, currency: b.fact.currency }
        : null,
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "bank_statement_view_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on my side" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "that has to come from SYB itself" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  if (!access.session) {
    return NextResponse.json({ error: "importing needs you signed in" }, { status: 401 });
  }
  const denied = requireRole(access, "data.import");
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => null)) as {
      csv?: unknown;
      currency?: unknown;
      decimal_style?: unknown;
      date_order?: unknown;
      through?: unknown;
    } | null;
    if (typeof body?.csv !== "string" || typeof body.currency !== "string") {
      return NextResponse.json({ error: "the file and its currency are needed" }, { status: 422 });
    }
    const result = await importBankStatement(access.account_id, body.csv, {
      currency: body.currency,
      ...(isDecimalStyle(body.decimal_style) ? { decimal_style: body.decimal_style } : {}),
      ...(body.date_order === "dmy" || body.date_order === "mdy"
        ? { date_order: body.date_order }
        : {}),
      ...(typeof body.through === "string" && body.through.trim() !== ""
        ? { through: body.through }
        : {}),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof BalanceImportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "bank_statement_import_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on my side" }, { status: 500 });
  }
}
