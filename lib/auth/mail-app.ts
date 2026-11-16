// Which webmail to offer on the "check your email" screen (2026-11-16).
//
// Pure: an email address in, at most one inbox link out. Only the big
// consumer domains are known for sure; a business domain could be hosted
// anywhere, so it gets no button rather than a guess.

export interface MailApp {
  /** The brand's own name — never translated. */
  name: "Gmail" | "Outlook";
  url: string;
}

const GMAIL = new Set(["gmail.com", "googlemail.com"]);
const OUTLOOK = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);

export function mailAppFor(email: string): MailApp | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (GMAIL.has(domain)) return { name: "Gmail", url: "https://mail.google.com/mail/u/0/#inbox" };
  if (OUTLOOK.has(domain) || /^(outlook|hotmail|live)\.[a-z.]+$/.test(domain)) {
    return { name: "Outlook", url: "https://outlook.live.com/mail/0/inbox" };
  }
  return null;
}
