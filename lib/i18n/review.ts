// Who may see a language still in review — rule 6 of TASKS-LANGUAGES.md.
//
// LANGUAGE_REVIEW_ACCOUNTS is a comma-separated list. An entry with an "@"
// is an email address (any business that address signs in to); anything
// else is an account id (everyone signed in to that business). Empty or
// unset = nobody: every customer sees only the `live` languages. Someone
// not signed in is never a reviewer, so a review language needs a sign-in.

/** Lower case and trimmed, as sign-in stores an address (lib/intake/resume's normaliseEmail). */
const normaliseEmail = (raw: string): string => raw.trim().toLowerCase();

export interface ReviewAllowlist {
  accounts: ReadonlySet<string>;
  emails: ReadonlySet<string>;
}

/** Pure: the env value as two sets. Blank entries are ignored. */
export function parseReviewAllowlist(raw: string | undefined | null): ReviewAllowlist {
  const accounts = new Set<string>();
  const emails = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    if (entry.includes("@")) emails.add(normaliseEmail(entry));
    else accounts.add(entry.toLowerCase());
  }
  return { accounts, emails };
}

/** Pure: whether a signed-in person is a named reviewer. Null (nobody signed in) never is. */
export function isLanguageReviewer(
  who: { account_id: string; email: string } | null | undefined,
  raw: string | undefined | null = process.env.LANGUAGE_REVIEW_ACCOUNTS,
): boolean {
  if (!who) return false;
  const list = parseReviewAllowlist(raw);
  return (
    list.accounts.has(who.account_id.toLowerCase()) || list.emails.has(normaliseEmail(who.email))
  );
}
