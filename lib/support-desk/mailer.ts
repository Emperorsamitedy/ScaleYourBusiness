// The support reply's one way out — Phase 4 Session C (P4-10).
//
// POST https://api.resend.com/emails on SYB's own Resend account (the
// key that sends login links). Never a connected account's credentials,
// never a write to anything the business owns. Called from exactly one
// place — sendApprovedReply in ./replies.ts — and a build gate in
// replies.test.ts holds that by scanning the source.
//
// At-most-once is the caller's claim (approved → sending, before this is
// called); this function adds Resend's Idempotency-Key so a duplicate
// request inside its 24-hour window cannot send twice either, and it
// sorts every answer into three outcomes honestly:
//   sent     — 2xx with an id: Resend accepted it;
//   refused  — a 4xx that means Resend did nothing (bad request, auth,
//              validation, rate limit): nothing went out;
//   unknown  — a 5xx, a timeout, a dropped connection, an unreadable
//              2xx or a 409 idempotency conflict: it may have gone out.

export type MailOutcome =
  | { kind: "sent"; provider_id: string }
  | { kind: "refused"; status: number; message: string }
  | { kind: "unknown"; why: string };

export interface SupportMail {
  from: string;
  to: string;
  reply_to: string;
  subject: string;
  text: string;
  /** The customer's Message-ID and the thread's chain, for their mail client to thread it. */
  in_reply_to: string | null;
  references: string | null;
  idempotency_key: string;
}

export type MailFetch = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 20_000;

export async function sendSupportEmail(
  mail: SupportMail,
  apiKey: string,
  fetchImpl: MailFetch = fetch,
): Promise<MailOutcome> {
  const headers: Record<string, string> = {};
  if (mail.in_reply_to) headers["In-Reply-To"] = mail.in_reply_to;
  if (mail.references) headers.References = mail.references;
  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": mail.idempotency_key,
      },
      body: JSON.stringify({
        from: mail.from,
        to: [mail.to],
        reply_to: mail.reply_to,
        subject: mail.subject,
        text: mail.text,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "unknown", why: error instanceof Error ? error.name : "network" };
  }
  if (res.ok) {
    try {
      const body = (await res.json()) as { id?: unknown };
      if (typeof body.id === "string" && body.id !== "")
        return { kind: "sent", provider_id: body.id };
    } catch {
      /* fall through */
    }
    return { kind: "unknown", why: `Resend answered ${res.status} without an id` };
  }
  if (res.status >= 500 || res.status === 409) {
    return { kind: "unknown", why: `Resend answered ${res.status}` };
  }
  let message = "";
  try {
    const body = (await res.json()) as { message?: unknown; name?: unknown };
    message = typeof body.message === "string" ? body.message.slice(0, 200) : "";
  } catch {
    /* no body */
  }
  return { kind: "refused", status: res.status, message };
}
