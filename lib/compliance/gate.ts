// ComplianceGate — architecture-v2 step 2, D5.
//
// ComplianceGate.check(business, capability, country, payload) returns CLEAR
// or every blocking reason at once. A failure here overrides any Trust
// Ladder authorization: the engine asks the ladder first and the gate
// second, and runs nothing the gate refuses.
//
// v1 holds the business-level rules (D5):
//   · an external capability needs a live write consent for that provider
//   · phone answering needs the business's country switched on (D6)
// Per-recipient consent (rule 23) stays in the campaign provider, which
// filters every recipient; AI disclosure (rule 20) stays in the phone line
// and the widget, which speak it first. Per-country rules join this list
// as the owner supplies them.

import type { ExecutionProviderId } from "../execution/scopes";
import { isExecutionProviderId } from "../execution/scopes";
import { activeExecutionConnection } from "../execution/connections";
import { PHONE_COUNTRIES_KEY, businessCountryIso, phoneAnsweringAllowed } from "../phone/countries";

export type ComplianceVerdict = { clear: true } | { clear: false; reasons: string[] };

export interface ComplianceCheck {
  profileId: string;
  accountId: string;
  /** An execution provider id, or "phone_answering". */
  capability: string;
  /** ISO alpha-2, or null when the business's country can't be read. */
  country: string | null;
  /** What the action would send or change — read by per-country rules as they arrive. */
  payload?: unknown;
  /** True when the capability writes to a platform outside SYB. */
  external?: boolean;
}

export interface ComplianceSeams {
  writeConsent?: (accountId: string, capability: string) => Promise<boolean>;
}

/**
 * Capabilities whose write consent is each approval itself, with no account
 * of the business's to connect: purchase orders go out from SYB's own email
 * service, and the registry's consent for them is "your approval of each
 * order" (lib/execution/scopes). Rule 12's recorded approval is checked by
 * the engine before this gate is reached.
 */
export const APPROVAL_IS_THE_CONSENT: ReadonlySet<string> = new Set(["purchase_order"]);

async function liveWriteConsent(accountId: string, capability: string): Promise<boolean> {
  if (!isExecutionProviderId(capability)) return false;
  return (await activeExecutionConnection(accountId, capability as ExecutionProviderId)) !== null;
}

/** ComplianceGate.check — every rule runs, so the owner sees every reason, not the first. */
export async function check(
  args: ComplianceCheck,
  seams: ComplianceSeams = {},
): Promise<ComplianceVerdict> {
  const reasons: string[] = [];

  if (args.capability === "phone_answering" && !phoneAnsweringAllowed(args.country)) {
    reasons.push(
      `phone answering isn't switched on for ${args.country ?? "a business whose country isn't stated"} — ${PHONE_COUNTRIES_KEY} decides which countries it runs in (architecture-v2 D6)`,
    );
  }

  if (args.external === true && !APPROVAL_IS_THE_CONSENT.has(args.capability)) {
    const consent = seams.writeConsent ?? liveWriteConsent;
    if (!(await consent(args.accountId, args.capability))) {
      reasons.push(
        `${args.capability} has no live write consent for this business — it has to be connected for changes first`,
      );
    }
  }

  return reasons.length === 0 ? { clear: true } : { clear: false, reasons };
}

/** The business's country for the gate, read the way the phone line reads it. */
export { businessCountryIso };
