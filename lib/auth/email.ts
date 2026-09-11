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
  /** "resend" when actually emailed; "screen" when the caller must show it. */
  delivered_via: "resend" | "screen";
}

const FROM = () => process.env.EMAIL_FROM ?? "Ledgerline <onboarding@resend.dev>";

export async function sendLoginEmail(mail: LoginEmail): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { delivered_via: "screen" };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM(),
      to: [mail.to],
      subject: "Your sign-in link — Ledgerline",
      text:
        `Click to sign in to Ledgerline:\n\n${mail.link}\n\n` +
        `The link works once and expires in 15 minutes. ` +
        `If you didn't ask for it, ignore this email — nothing happens without the link.`,
    }),
  });
  if (!res.ok) {
    // A failed send must not strand the owner: fall back to the screen
    // and log loudly. Silence here would look like a broken login.
    console.error(
      JSON.stringify({ event: "login_email_failed", status: res.status, to_domain: mail.to.split("@")[1] }),
    );
    return { delivered_via: "screen" };
  }
  return { delivered_via: "resend" };
}
