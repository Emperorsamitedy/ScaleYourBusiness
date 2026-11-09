// The files the owner takes to their own bank — P6-05 (rule 26 amended),
// kept as export batches by the owner's decision of 2026-11-09 so a repeated
// download can never pay a payment twice (lib/payments/exports).
//
//   POST /api/payments/file  { format: "sepa" | "steps", ids?: [<id>, …] }
//        a NEW file of the ready payments (approved, not marked paid) that
//        are in no file yet: a SEPA credit-transfer file (pain.001.001.03) of
//        those in euros between SEPA IBANs, debited from the "pay from"
//        details the owner stated, or plain step-by-step instructions for
//        any currency. It is recorded as a batch (id, moment, who, MsgId),
//        and its payments go in no later new file.
//   GET  /api/payments/file?batch=<id>
//        that batch again, byte for byte, with the SAME MsgId: a bank refuses
//        a pain.001 whose MsgId it has already seen. A copy of the steps says
//        it is a copy, first.
//
// Owner only, both ways (least privilege, the owner's decision of
// 2026-11-09): the files carry full IBANs. Every download is logged with the
// account id, the batch, the MsgId and the count — the IBANs never. Only
// approved payments are ever read for a file (readyPayments), and the
// renderer refuses anything else (rule 12). A download, never a send.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import { isAppLocale } from "../../../../lib/i18n/locales";
import { requestWords } from "../../../../lib/i18n/request-words";
import type { ExportedFile } from "../../../../lib/payments/exports";
import { ExportError, exportAgain, exportNewFile } from "../../../../lib/payments/exports";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STEPS = "payments.steps";

function fileResponse(file: ExportedFile): NextResponse {
  return new NextResponse(file.body, {
    headers: {
      "content-type": file.content_type,
      "content-disposition": `attachment; filename="${file.filename}"`,
      "cache-control": "private, no-store",
      "x-syb-export": file.export_id,
      "x-syb-msg-id": file.msg_id,
    },
  });
}

function refusal(error: unknown, accountId: string, event: string): NextResponse {
  if (error instanceof ExportError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  console.error(JSON.stringify({ event, account_id: accountId, ...logSafeError(error) }));
  return NextResponse.json({ error: "something went wrong on my side" }, { status: 500 });
}

/** Download a file made before, again: the same bytes, the same MsgId. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "payments.read");
  if (denied) return denied;
  const batch = request.nextUrl.searchParams.get("batch");
  if (batch === null) {
    return NextResponse.json(
      {
        error: "a new file is made with POST; GET downloads a file made before (?batch=<id>)",
        code: "use_post",
      },
      { status: 405, headers: { allow: "GET, POST" } },
    );
  }
  if (!UUID_RE.test(batch)) {
    return NextResponse.json({ error: "no such file", code: "no_such_file" }, { status: 404 });
  }
  try {
    const file = await exportAgain({
      profileId: access.profile_id,
      accountId: access.account_id,
      exportId: batch,
      wordsFor: (locale) => requestWords(STEPS, isAppLocale(locale) ? locale : "en"),
    });
    return fileResponse(file);
  } catch (error) {
    return refusal(error, access.account_id, "payments_file_again_failed");
  }
}

/** A new file of the ready payments that are in no file yet. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Security review 2026-11-09: same-origin, defense-in-depth beyond
  // SameSite=Lax, matching the pattern every other mutating route in the
  // codebase follows — this produces the SEPA/steps file.
  const origin = appOriginOf(request.url);
  if (!isSameOriginPost(request.headers, origin)) {
    return NextResponse.json({ error: "build the file from our own page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "payments.prepare");
  if (denied) return denied;
  let body: { format?: unknown; ids?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "the request isn't JSON" }, { status: 400 });
  }
  const format = body?.format;
  if (format !== "sepa" && format !== "steps") {
    return NextResponse.json({ error: 'format must be "sepa" or "steps"' }, { status: 422 });
  }
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((s): s is string => typeof s === "string" && UUID_RE.test(s))
    : [];
  try {
    const file = await exportNewFile({
      profileId: access.profile_id,
      accountId: access.account_id,
      format,
      ids,
      userId: access.session?.user_id ?? null,
      words: await requestWords(STEPS),
    });
    return fileResponse(file);
  } catch (error) {
    return refusal(error, access.account_id, "payments_file_failed");
  }
}
