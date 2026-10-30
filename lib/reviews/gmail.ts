// Gmail's forwarding confirmation — review 2026-10-30 (idea 45).
//
// When an owner adds the reviews address as a Gmail forwarding address,
// Gmail mails a confirmation code (and a link) TO that address, and
// forwarding stays off until the code is entered in Gmail. The address is
// ours, so the owner would never see it: this reads that one email and
// keeps the code and the link, nothing else of it (not the owner's Gmail
// address in it, not its words), for /reviews to show.
//
// Only from forwarding-noreply@google.com with the sender proven by Resend's
// own checks (sender_auth "verified"), and a link only on Google's mail
// settings hosts: a stranger's lookalike can't put a link of theirs on the
// owner's screen. Pure: no database.

export const GMAIL_FORWARDING_SENDER = "forwarding-noreply@google.com";

/** Google's hosts for the confirm link (mail-settings.google.com today; mail.google.com before). */
const LINK_HOSTS = new Set(["mail-settings.google.com", "mail.google.com"]);

const CODE_RES = [
  /confirmation code:\s*(\d{6,12})(?!\d)/i,
  // The subject: "(#123456789) Gmail Forwarding Confirmation - …"
  /\(#(\d{6,12})\)/,
];

export interface GmailConfirmationRead {
  code: string | null;
  link: string | null;
}

/** Whether this mail is Gmail's forwarding confirmation, by its sender. */
export function isGmailForwardingSender(from: string): boolean {
  return from.trim().toLowerCase() === GMAIL_FORWARDING_SENDER;
}

/** The code and link in Gmail's confirmation, or null when neither is there. */
export function readGmailConfirmation(subject: string, text: string): GmailConfirmationRead | null {
  let code: string | null = null;
  for (const re of CODE_RES) {
    const m = re.exec(`${text}\n${subject}`);
    if (m) {
      code = m[1]!;
      break;
    }
  }
  let link: string | null = null;
  for (const raw of text.match(/https:\/\/[^\s<>"')\]]+/g) ?? []) {
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" && LINK_HOSTS.has(url.hostname) && url.href.length <= 600) {
        link = url.href;
        break;
      }
    } catch {
      // Not a URL: skipped.
    }
  }
  return code === null && link === null ? null : { code, link };
}
