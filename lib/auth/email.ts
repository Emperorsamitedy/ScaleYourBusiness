// Sending the login link — Session I (P1-49).
//
// One adapter, one provider (Resend), one honest fallback. When
// RESEND_API_KEY is absent the link is returned to the caller and shown
// on screen instead — the same pattern the resume links established:
// a shown-on-screen link beats a promised email that never arrives.
// Nothing here blocks on an external account existing.

export interface LoginEmail {
  to: string;
  link: string;
}

export interface SendResult {
  /**
   * "resend" when emailed; "screen" ONLY in local development with no key
   * (the security review of 2026-10-17: a link shown to whoever asked is a
   * sign-in as anybody); "failed" when the send did not happen.
   */
  delivered_via: "resend" | "screen" | "failed";
  /**
   * Resend's answer when a request was made: the HTTP status and the email
   * id it assigned (null when it gave none). Neither is a secret; the smoke
   * test (scripts/smoke-email.ts) reports them, and nothing else does.
   */
  provider?: { status: number; id: string | null };
}

const FROM = () => process.env.EMAIL_FROM ?? "SYB <onboarding@resend.dev>";

export async function sendLoginEmail(mail: LoginEmail): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // Showing the link is only safe where the only person asking is the developer.
    return { delivered_via: process.env.NODE_ENV === "production" ? "failed" : "screen" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM(),
      to: [mail.to],
      subject: "Your sign-in link — SYB",
      text:
        `Click to sign in to SYB:\n\n${mail.link}\n\n` +
        `The link works once and expires in 15 minutes. ` +
        `If you didn't ask for it, ignore this email — nothing happens without the link.`,
    }),
  });
  if (!res.ok) {
    // A failed send is reported as failed, never answered with the link:
    // the screen fallback let anyone who could make a send fail (a burst
    // into the rate limit, an unverified sender) sign in as anyone.
    console.error(
      JSON.stringify({
        event: "login_email_failed",
        status: res.status,
        to_domain: mail.to.split("@")[1],
      }),
    );
    return { delivered_via: "failed", provider: { status: res.status, id: null } };
  }
  const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : null;
  return { delivered_via: "resend", provider: { status: res.status, id } };
}

// ---------------------------------------------------------------------------
// Owner emails — idea 42, the weekly summary. The same provider and key as
// the login link, for mail SYB sends to an account's OWN owner (never a
// customer). With no RESEND_API_KEY nothing is sent, nothing claims it was,
// and the caller is told "not_configured" — in every environment: there is
// no on-screen fallback for a summary. The outcome is sorted honestly, the
// support mailer's way: "sent" only with Resend's id; "refused" for a 4xx
// that means nothing went out; "unknown" when it may have gone out.

export interface OwnerEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
  /** Resend's Idempotency-Key: a duplicate inside its 24 hours sends nothing. */
  idempotency_key: string;
}

export type OwnerEmailOutcome =
  | { kind: "sent"; provider_id: string }
  | { kind: "not_configured" }
  | { kind: "refused"; status: number }
  | { kind: "unknown"; why: string };

export type EmailFetch = (url: string, init: RequestInit) => Promise<Response>;

export const OWNER_EMAIL_TIMEOUT_MS = 20_000;

/** True when an owner email could be sent at all. Read before claiming a send. */
export function ownerEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export async function sendOwnerEmail(
  mail: OwnerEmail,
  fetchImpl: EmailFetch = fetch,
): Promise<OwnerEmailOutcome> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return { kind: "not_configured" };
  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": mail.idempotency_key,
      },
      body: JSON.stringify({
        from: FROM(),
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        ...(mail.headers && Object.keys(mail.headers).length > 0 ? { headers: mail.headers } : {}),
      }),
      signal: AbortSignal.timeout(OWNER_EMAIL_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "unknown", why: error instanceof Error ? error.name : "network" };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    return typeof body?.id === "string" && body.id !== ""
      ? { kind: "sent", provider_id: body.id }
      : { kind: "unknown", why: `Resend answered ${res.status} without an id` };
  }
  if (res.status >= 500 || res.status === 409) {
    return { kind: "unknown", why: `Resend answered ${res.status}` };
  }
  return { kind: "refused", status: res.status };
}

// ---------------------------------------------------------------------------
// Team invites — idea 52. The same provider and key. An invite link is not
// a sign-in: it says WHICH invite, and joining still needs a sign-in proven
// for the invited address. So with no key, in any environment, the owner
// is told email isn't set up and the screen shows the link to copy and
// send themselves — the honest fallback, never a promised email.

export interface InviteEmail {
  to: string;
  link: string;
  /** The business's own name, when it has one. */
  business: string | null;
  role: "owner" | "manager" | "viewer";
}

export interface InviteSendResult {
  /** "resend" when emailed; "not_configured" with no key; "failed" when the send didn't happen. */
  delivered_via: "resend" | "not_configured" | "failed";
}

export async function sendInviteEmail(
  mail: InviteEmail,
  fetchImpl: EmailFetch = fetch,
): Promise<InviteSendResult> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return { delivered_via: "not_configured" };
  const where = mail.business ?? "a business";
  const as = mail.role === "owner" ? "an owner" : `a ${mail.role}`;
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM(),
        to: [mail.to],
        subject: `You're invited to ${where} on SYB`,
        text:
          `You've been invited to join ${where} on SYB as ${as}.\n\n` +
          `Open this link to accept:\n\n${mail.link}\n\n` +
          `It works once and expires in 7 days. You'll sign in with this address, ${mail.to}. ` +
          `If you weren't expecting it, ignore this email — nothing happens without you.`,
      }),
      signal: AbortSignal.timeout(OWNER_EMAIL_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(JSON.stringify({ event: "invite_email_failed", status: res.status }));
      return { delivered_via: "failed" };
    }
    return { delivered_via: "resend" };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "invite_email_failed",
        name: error instanceof Error ? error.name : "network",
      }),
    );
    return { delivered_via: "failed" };
  }
}
