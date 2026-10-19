// The campaign-email sender identity and consent wording — P4-15. Pure: no
// database, so the consent screen renders the lines with exactly the same
// function the consent hash is computed with (lib/execution/email-consent.ts).

import { EXECUTION_SCOPE_REGISTRY } from "./scopes";

/** Pure: '"<name> via Ledgerline", with replies going to <address>' — what the consent names. */
export function senderIdentity(senderName: string, replyTo: string): string {
  return `"${senderName.trim()} via Ledgerline", with replies going to ${replyTo.trim().toLowerCase()}`;
}

/** Pure: the registry's consent lines, verbatim, {sender} filled. */
export function emailConsentLines(sender: string): string[] {
  return EXECUTION_SCOPE_REGISTRY.email_campaign.consent.map((c) =>
    c.why.split("{sender}").join(sender),
  );
}
