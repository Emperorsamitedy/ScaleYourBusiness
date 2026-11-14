// POST /api/partner — the Partner Console's actions (v1 spec §7).
//
//   create_firm  { name, country, type }
//   add_member   { email, role }                  principal
//   white_label  { logo_url?, primary_color?, accent_color?, sender_domain? }   principal
//   import       { csv, scopes[], months?, evidence_ref }   principal or manager
//   commentary   { client, section, body }        read_diagnosis
//   approve      { client, proposal_id }          approve_actions
//   nudge        { client, what }                 manage_connectors
//   nav_connect  { rows: [{ client, login, password, signature_key, tax_number }] }
//                NAV across the book (multi-market §E.4), principal or
//                manager; each row under its own manage_connectors mandate
//   nav_revoke   { client }                       manage_connectors
//
// nav_connect's body holds NAV credentials: nothing here logs the body, and
// its answer is an outcome code per client, never an input.
//
// The caller is the signed-in person (their session). What they may do in a
// client's business is never read from the request: the firm role comes
// from firm_members, and each client action asks the database's
// partner_may for its own scope (lib/partners). `client` names a business
// the partner wants to act on; without a live mandate it is "not found".

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE } from "../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { currentSession } from "../../../lib/auth/service";
import { logSafeError } from "../../../lib/core/log-safe";
import { ProposalError } from "../../../lib/proposals/service";
import { PartnerAccessError } from "../../../lib/partners/access";
import {
  PartnerActionError,
  approveForClient,
  nudgeClient,
  writeCommentary,
} from "../../../lib/partners/actions";
import { FirmError, addMember, createFirm, setWhiteLabel } from "../../../lib/partners/firm";
import { MandateError, importClients } from "../../../lib/partners/mandates";
import { NavBulkError, bulkConnectNav, revokeNavForClient } from "../../../lib/partners/nav";
import { isAppLocale } from "../../../lib/i18n/locales";

const MAX_BODY_BYTES = 512 * 1024;
const str = (v: unknown) => (typeof v === "string" ? v : "");

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = appOriginOf(request.url);
  if (!isSameOriginPost(request.headers, origin)) {
    return NextResponse.json({ error: "use our own page" }, { status: 403 });
  }
  const store = await cookies();
  const session = await currentSession(store.get(AUTH_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES)
    return NextResponse.json({ error: "too large" }, { status: 413 });
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const userId = session.user_id;
  const client = str(b.client);
  try {
    switch (b.action) {
      case "create_firm":
        return NextResponse.json(
          await createFirm({
            userId,
            name: str(b.name),
            country: str(b.country),
            type: str(b.type),
          }),
        );
      case "add_member":
        return NextResponse.json(
          await addMember({
            userId,
            email: str(b.email),
            role: b.role === "manager" ? "manager" : "staff",
          }),
        );
      case "white_label":
        return NextResponse.json(
          await setWhiteLabel(userId, {
            logo_url: str(b.logo_url) || null,
            primary_color: str(b.primary_color) || null,
            accent_color: str(b.accent_color) || null,
            sender_domain: str(b.sender_domain) || null,
          }),
        );
      case "import": {
        const lang = str(b.default_language);
        return NextResponse.json(
          await importClients({
            userId,
            csv: str(b.csv),
            scopes: Array.isArray(b.scopes) ? b.scopes.map(String) : [],
            ...(typeof b.months === "number" ? { months: b.months } : {}),
            evidenceRef: str(b.evidence_ref),
            appUrl: origin,
            ...(isAppLocale(lang) ? { defaultLocale: lang } : {}),
          }),
        );
      }
      case "commentary":
        await writeCommentary({
          userId,
          profileId: client,
          section: str(b.section),
          body: str(b.body),
        });
        return NextResponse.json({ ok: true });
      case "approve":
        await approveForClient({ userId, profileId: client, proposalId: str(b.proposal_id) });
        return NextResponse.json({ ok: true });
      case "nav_connect": {
        const rows = Array.isArray(b.rows) ? (b.rows as Record<string, unknown>[]) : [];
        return NextResponse.json(
          await bulkConnectNav({
            userId,
            rows: rows.map((r) => ({
              client: str(r?.client),
              login: str(r?.login),
              password: str(r?.password),
              signatureKey: str(r?.signature_key),
              taxNumber: str(r?.tax_number),
            })),
          }),
        );
      }
      case "nav_revoke":
        return NextResponse.json(await revokeNavForClient({ userId, profileId: client }));
      case "nudge":
        await nudgeClient({ userId, profileId: client, what: str(b.what) });
        return NextResponse.json({ ok: true });
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (error) {
    for (const E of [
      PartnerAccessError,
      PartnerActionError,
      FirmError,
      MandateError,
      ProposalError,
      NavBulkError,
    ]) {
      if (error instanceof E)
        return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "partner_action_failed",
        account_id: session.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
