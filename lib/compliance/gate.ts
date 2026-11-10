// ComplianceGate — architecture-v2 step 2; the v1 build spec §9 (P7-32).
//
// ComplianceGate.check(business, capability, country, payload) returns CLEAR
// or every blocking reason at once. It runs before every external action
// and can veto anything the Trust Ladder authorised: the engine asks the
// ladder first and the gate second, and runs nothing the gate refuses.
//
// §9: "a rules engine with a per-country matrix in configuration, not
// conditionals scattered through the codebase". COMPLIANCE_RULES is that
// engine — a list of named rules, each saying which capabilities it applies
// to and, given the business's matrix row, why it refuses. The matrix
// (./matrix.ts) is a table changed without a deploy and audit-logged on
// every change. A country with no row is blocked for every regulated
// capability.
//
// Per-recipient consent (rule 23) stays in the campaign provider, which
// filters every recipient; AI disclosure (rule 20, Article 50(1)) stays in
// the phone line and the widget, which speak it first — the matrix's
// ai_disclosure_required can never be false.

import type { ExecutionProviderId } from "../execution/scopes";
import { isExecutionProviderId } from "../execution/scopes";
import { activeExecutionConnection } from "../execution/connections";
import { businessCountryIso } from "../phone/countries";
import type { CountryRule } from "./matrix";
import { countryRule, inboundPhoneAllowed, outboundPhoneAllowed } from "./matrix";

export type ComplianceVerdict = { clear: true } | { clear: false; reasons: string[] };

export interface ComplianceCheck {
  profileId: string;
  accountId: string;
  /** An execution provider id, "phone_answering" or "phone_outbound". */
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

/** The capabilities §9.2 regulates country by country. */
export const PHONE_CAPABILITIES: ReadonlySet<string> = new Set([
  "phone_answering",
  "phone_outbound",
]);

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

export interface RuleContext {
  args: ComplianceCheck;
  /** The business's matrix row; null when the country is unknown or has no row. */
  rule: CountryRule | null;
  seams: ComplianceSeams;
}

export interface ComplianceRule {
  id: string;
  applies(args: ComplianceCheck): boolean;
  /** The reason it refuses, in plain words, or null when it doesn't. */
  refuse(ctx: RuleContext): Promise<string | null>;
}

const where = (country: string | null) => country ?? "a business whose country isn't stated";

/** The rules, in the order their reasons are shown. */
export const COMPLIANCE_RULES: readonly ComplianceRule[] = [
  {
    // §9.5: a capability in a blocked country can't execute at any station,
    // even with an owner override — an operator's stop for the whole country.
    id: "country_halted",
    applies: (a) => a.external === true || PHONE_CAPABILITIES.has(a.capability),
    refuse: async ({ args, rule }) =>
      rule?.execution_halted === true
        ? `everything SYB does outside itself is halted for businesses in ${args.country} — the compliance matrix says so`
        : null,
  },
  {
    // §9.2: phone answering, its recording and its transcripts.
    id: "phone_inbound_blocked",
    applies: (a) => a.capability === "phone_answering",
    refuse: async ({ args, rule }) =>
      inboundPhoneAllowed(rule) || rule?.execution_halted === true
        ? null
        : `phone answering isn't unblocked for ${where(args.country)} — the compliance matrix needs counsel's sign-off for that country first`,
  },
  {
    // §9.2: outbound AI calling, behind its own flag, only after inbound.
    id: "phone_outbound_blocked",
    applies: (a) => a.capability === "phone_outbound",
    refuse: async ({ args, rule }) =>
      outboundPhoneAllowed(rule) || rule?.execution_halted === true
        ? null
        : `outbound calling isn't unblocked for ${where(args.country)} — the compliance matrix keeps it blocked until inbound is proven there`,
  },
  {
    // Write access is a separate audited consent (Phase 3 rule 13).
    id: "write_consent",
    applies: (a) =>
      a.external === true &&
      !APPROVAL_IS_THE_CONSENT.has(a.capability) &&
      !PHONE_CAPABILITIES.has(a.capability),
    refuse: async ({ args, seams }) => {
      const consent = seams.writeConsent ?? liveWriteConsent;
      return (await consent(args.accountId, args.capability))
        ? null
        : `${args.capability} has no live write consent for this business — it has to be connected for changes first`;
    },
  },
];

/** ComplianceGate.check — every rule that applies runs, so the owner sees every reason. */
export async function check(
  args: ComplianceCheck,
  seams: ComplianceSeams = {},
): Promise<ComplianceVerdict> {
  const applicable = COMPLIANCE_RULES.filter((r) => r.applies(args));
  if (applicable.length === 0) return { clear: true };
  const ctx: RuleContext = { args, rule: await countryRule(args.country), seams };
  const reasons: string[] = [];
  for (const r of applicable) {
    const reason = await r.refuse(ctx);
    if (reason !== null) reasons.push(reason);
  }
  return reasons.length === 0 ? { clear: true } : { clear: false, reasons };
}

/** The business's country for the gate, read the way the phone line reads it. */
export { businessCountryIso };
