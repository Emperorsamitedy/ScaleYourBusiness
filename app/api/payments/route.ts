// Prepared payments' API — P6-05 (rule 26 amended: money is prepared,
// never moved).
//
//   GET  /api/payments
//        the business's payments, each with its stage ("waiting", "ready"
//        for your bank, "paid" in my bank…), IBANs MASKED; the stated
//        "pay from" details, masked; what a payment can be linked to
//        (suppliers, fixed costs); and, for each ready payment, whether it
//        can go in a SEPA file and why not
//   POST /api/payments  { action: "propose", payment: {...} }
//        a payment PROPOSAL into the approval queue (rule 12) — nothing paid
//   POST /api/payments  { action: "state_payer", holder_name, iban, bic? }
//        the owner states the bank details they pay from (a stated fact)
//   POST /api/payments  { action: "mark_paid", payment_id }
//        the owner says they paid a ready payment in their own bank
//   POST /api/payments  { action: "erase", payment_id | supplier_id }
//        rule 22: the payee's bank details are erased
//
// Every POST is the owner's (role action "payments.prepare"). Nothing here
// talks to a bank or a payment provider: no credential, no initiation
// scope, no transfer call (lib/payments/fence.test.ts fails the build if
// one appears). The files are /api/payments/file's.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../lib/auth/access";
import { requireRole, roleAllows, roleOf } from "../../../lib/auth/roles";
import { logSafeError } from "../../../lib/core/log-safe";
import { maskIban } from "../../../lib/payments/iban";
import type { SepaBar } from "../../../lib/payments/sepa";
import { sepaBar } from "../../../lib/payments/sepa";
import type { PayableThings, PaymentDraftInput, PaymentListing } from "../../../lib/payments/store";
import {
  PaymentDraftError,
  currentPayer,
  draftPaymentProposal,
  eraseBankDetails,
  listPayments,
  markPaidInBank,
  payableThings,
  readyPayments,
  statePayer,
} from "../../../lib/payments/store";

export interface PaymentRow extends PaymentListing {
  /** For a ready payment: null when it can go in a SEPA file, else why not. */
  file_bar: SepaBar | null;
}

export interface PaymentsView {
  payer: { holder_name: string; iban_masked: string; bic: string | null; stated_at: string } | null;
  payments: PaymentRow[];
  things: PayableThings;
  /** Whether this person may prepare payments and download the files (owners). */
  can_prepare: boolean;
  today: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const [payer, list, things, ready] = await Promise.all([
      currentPayer(access.profile_id),
      listPayments(access.profile_id),
      payableThings(access.profile_id),
      readyPayments(access.profile_id),
    ]);
    const bars = new Map(ready.map((p) => [p.id, sepaBar(p, payer)]));
    const role = roleOf(access);
    return NextResponse.json({
      payer: payer
        ? {
            holder_name: payer.holder_name,
            iban_masked: maskIban(payer.iban),
            bic: payer.bic,
            stated_at: payer.stated_at,
          }
        : null,
      payments: list.map((p) => ({ ...p, file_bar: bars.get(p.id) ?? null })),
      things,
      can_prepare: role !== null && roleAllows(role, "payments.prepare"),
      today: new Date().toISOString().slice(0, 10),
    } satisfies PaymentsView);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "payments_view_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on my side" }, { status: 500 });
  }
}

type Body =
  | { action: "propose"; payment: PaymentDraftInput }
  | { action: "state_payer"; holder_name: string; iban: string; bic?: string | null }
  | { action: "mark_paid"; payment_id: string }
  | { action: "erase"; payment_id?: string; supplier_id?: string };

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "payments.prepare");
  if (denied) return denied;
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "the request isn't JSON" }, { status: 400 });
  }
  const userId = access.session?.user_id ?? null;
  try {
    switch (body?.action) {
      case "propose": {
        const out = await draftPaymentProposal({
          profileId: access.profile_id,
          accountId: access.account_id,
          input: body.payment,
        });
        return NextResponse.json(out, { status: 201 });
      }
      case "state_payer": {
        const out = await statePayer({
          profileId: access.profile_id,
          accountId: access.account_id,
          holderName: typeof body.holder_name === "string" ? body.holder_name : "",
          iban: typeof body.iban === "string" ? body.iban : "",
          bic: typeof body.bic === "string" ? body.bic : null,
          userId,
        });
        return NextResponse.json(out);
      }
      case "mark_paid": {
        if (userId === null) {
          return NextResponse.json(
            { error: "saying a payment was made needs you signed in", code: "no_session" },
            { status: 401 },
          );
        }
        if (typeof body.payment_id !== "string" || !UUID_RE.test(body.payment_id)) {
          return NextResponse.json(
            { error: "no such payment", code: "not_found" },
            { status: 404 },
          );
        }
        await markPaidInBank({
          profileId: access.profile_id,
          accountId: access.account_id,
          paymentId: body.payment_id,
          userId,
        });
        return NextResponse.json({ ok: true });
      }
      case "erase": {
        const supplierId = typeof body.supplier_id === "string" ? body.supplier_id : undefined;
        const paymentId = typeof body.payment_id === "string" ? body.payment_id : undefined;
        if ((supplierId && !UUID_RE.test(supplierId)) || (paymentId && !UUID_RE.test(paymentId))) {
          return NextResponse.json(
            { error: "no such payment", code: "not_found" },
            { status: 404 },
          );
        }
        const erased = await eraseBankDetails({
          profileId: access.profile_id,
          accountId: access.account_id,
          userId,
          ...(supplierId ? { supplierId } : {}),
          ...(paymentId ? { paymentId } : {}),
        });
        return NextResponse.json({ erased });
      }
      default:
        return NextResponse.json(
          { error: 'action must be "propose", "state_payer", "mark_paid" or "erase"' },
          { status: 422 },
        );
    }
  } catch (error) {
    if (error instanceof PaymentDraftError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error(
      JSON.stringify({
        event: "payments_action_failed",
        account_id: access.account_id,
        action: body?.action ?? null,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on my side" }, { status: 500 });
  }
}
