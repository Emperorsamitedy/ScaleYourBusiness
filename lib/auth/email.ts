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
