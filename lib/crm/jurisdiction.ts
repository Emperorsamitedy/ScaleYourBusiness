// Jurisdiction rules for marketing email — P4-16 (Phase 4 Session F), rule 23.
//
// Session F's gate puts these first: no send executor exists until the
// compliance checks are code with tests. What lives here is deterministic
// — which regime a business sends under, and what a marketing message
// must carry there — and it can only ever ADD requirements to SYB's own
// floor, never remove one:
//
//   THE FLOOR (rules 19 and 23), everywhere: explicit consent per
//   contact, recorded with how and when; no suppressed address, ever; an
//   unsubscribe honoured immediately and permanently. Where the law is
//   looser — US opt-out, the EU's and UK's soft opt-in for existing
//   customers — SYB still demands explicit consent. `law_is_looser`
//   records that honestly; it never relaxes the gate.
//
//   WHAT DIVERGES, per regime: what each message must carry (who sent
//   it, a postal address, a working unsubscribe), how soon an
//   unsubscribe must take effect, and how long the link must keep
//   working after the send.
//
//   UNKNOWN MEANS NO. A country with no regime here sends no marketing:
//   SYB doesn't guess another country's law. Coverage follows the bank's
//   market scope (Europe) plus the four largest English-language markets.
//
// Not legal advice, and written from the statutes' widely documented
// requirements: before Session F sends to anyone, a person reviews this
// table against current law (recorded in TASKS-PHASE4.md, P4-16).

import type { ContactRow, EmailPermission } from "./contacts";
import { canEmailForMarketing } from "./contacts";
import { countryCode } from "../hours/timezone";

export type RegimeId = "eu_gdpr" | "uk_pecr" | "us_can_spam" | "ca_casl" | "au_spam_act";

export type MessageRequirement = "sender_identity" | "postal_address" | "unsubscribe";

export interface Regime {
  id: RegimeId;
  label: string;
  /** ISO alpha-2 codes this regime covers. */
  countries: readonly string[];
  /** What every marketing message must carry under this regime. */
  requires: readonly MessageRequirement[];
  /** The legal deadline for honouring an unsubscribe; null = "without undue delay". SYB honours it at once. */
  honour_unsubscribe_business_days: number | null;
  /** How long an unsubscribe link must keep working after the send; null = no stated minimum. */
  unsubscribe_link_min_days: number | null;
  /** True where the law alone would allow marketing without explicit consent. SYB doesn't. */
  law_is_looser: boolean;
  /** Where the rule comes from, for the person who reviews it. */
  source: string;
}

/** The EU's 27 plus Iceland, Liechtenstein and Norway. */
const EEA = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
] as const;

export const REGIMES: Readonly<Record<RegimeId, Regime>> = {
  eu_gdpr: {
    id: "eu_gdpr",
    label: "EU/EEA — GDPR and the ePrivacy Directive",
    countries: EEA,
    requires: ["sender_identity", "unsubscribe"],
    honour_unsubscribe_business_days: null,
    unsubscribe_link_min_days: null,
    law_is_looser: true, // ePrivacy Art. 13(2): soft opt-in for existing customers
    source:
      "ePrivacy Directive 2002/58/EC Art. 13; GDPR Art. 4(11), 7(1) (demonstrable consent), 7(3) (withdrawal as easy as giving)",
  },
  uk_pecr: {
    id: "uk_pecr",
    label: "UK — PECR and UK GDPR",
    countries: ["GB"],
    requires: ["sender_identity", "unsubscribe"],
    honour_unsubscribe_business_days: null,
    unsubscribe_link_min_days: null,
    law_is_looser: true, // PECR reg. 22(3): soft opt-in
    source: "Privacy and Electronic Communications Regulations 2003, regs. 22–23; UK GDPR Art. 7",
  },
  us_can_spam: {
    id: "us_can_spam",
    label: "United States — CAN-SPAM",
    countries: ["US"],
    requires: ["sender_identity", "postal_address", "unsubscribe"],
    honour_unsubscribe_business_days: 10,
    unsubscribe_link_min_days: 30,
    law_is_looser: true, // opt-out regime: no prior consent required by law
    source: "CAN-SPAM Act of 2003, 15 U.S.C. §7704; FTC rule 16 CFR Part 316",
  },
  ca_casl: {
    id: "ca_casl",
    label: "Canada — CASL",
    countries: ["CA"],
    requires: ["sender_identity", "postal_address", "unsubscribe"],
    honour_unsubscribe_business_days: 10,
    unsubscribe_link_min_days: 60,
    law_is_looser: true, // implied consent from an existing business relationship
    source: "Canada's Anti-Spam Legislation (S.C. 2010, c. 23), ss. 6, 10, 11",
  },
  au_spam_act: {
    id: "au_spam_act",
    label: "Australia — Spam Act 2003",
    countries: ["AU"],
    requires: ["sender_identity", "unsubscribe"],
    honour_unsubscribe_business_days: 5,
    unsubscribe_link_min_days: 30,
    law_is_looser: true, // inferred consent
    source: "Spam Act 2003 (Cth), ss. 16–18",
  },
};

/** Pure: the regime for a country as the owner typed it, or null when SYB has none. */
export function regimeFor(country: string | null): Regime | null {
  if (country === null) return null;
  const code = countryCode(country) ?? country.trim().toUpperCase();
  return Object.values(REGIMES).find((r) => r.countries.includes(code)) ?? null;
}

export type RegimeLookup = { ok: true; regimes: Regime[] } | { ok: false; reason: string };

/**
 * Pure: every regime a send falls under — the business's own country, and
 * the recipient's when it is known. Both apply; requirements are the union.
 * An unknown country on either side refuses the send rather than guessing.
 */
export function applicableRegimes(args: {
  businessCountry: string | null;
  recipientCountry?: string | null;
}): RegimeLookup {
  if (args.businessCountry === null || args.businessCountry.trim() === "") {
    return {
      ok: false,
      reason: "the business's country isn't known, so its email rules aren't either",
    };
  }
  const own = regimeFor(args.businessCountry);
  if (own === null) {
    return {
      ok: false,
      reason: `SYB doesn't yet know the email marketing rules for ${args.businessCountry.trim()} — nothing is sent there`,
    };
  }
  const regimes = [own];
  const theirs = args.recipientCountry ?? null;
  if (theirs !== null && theirs.trim() !== "") {
    const other = regimeFor(theirs);
    if (other === null) {
      return {
        ok: false,
        reason: `SYB doesn't yet know the email marketing rules for the recipient's country (${theirs.trim()})`,
      };
    }
    if (other.id !== own.id) regimes.push(other);
  }
  return { ok: true, regimes };
}

/** What a marketing message is checked for, before any send (P4-15 calls this). */
export interface MarketingMessage {
  sender_name: string;
  sender_email: string;
  postal_address: string | null;
  unsubscribe_url: string | null;
  /** The disclosure line rule 17 puts on every drafted word. */
  disclosure: string;
}

const REQUIREMENT_WORDS: Record<MessageRequirement, string> = {
  sender_identity: "who sent it (the business's name and email)",
  postal_address: "the business's postal address",
  unsubscribe: "a working unsubscribe link",
};

/** Pure: what the message is missing under these regimes, in the owner's words. Empty = complete. */
export function messageGaps(message: MarketingMessage, regimes: readonly Regime[]): string[] {
  const required = new Set<MessageRequirement>(regimes.flatMap((r) => r.requires));
  const has: Record<MessageRequirement, boolean> = {
    sender_identity:
      message.sender_name.trim() !== "" && /^[^@\s]+@[^@\s]+$/.test(message.sender_email.trim()),
    postal_address: (message.postal_address ?? "").trim() !== "",
    unsubscribe: /^https:\/\/\S+$/.test((message.unsubscribe_url ?? "").trim()),
  };
  const gaps = (["sender_identity", "postal_address", "unsubscribe"] as const)
    .filter((r) => required.has(r) && !has[r])
    .map((r) => {
      const why = regimes.filter((g) => g.requires.includes(r)).map((g) => g.label.split(" — ")[0]);
      return `${REQUIREMENT_WORDS[r]} (${why.join(", ")})`;
    });
  // Rule 17 holds everywhere, whatever the regime says.
  if (message.disclosure.trim() === "") gaps.push("the AI disclosure line (SYB, everywhere)");
  return gaps;
}

/** How long SYB's unsubscribe links must stay working: the longest any regime that applies asks. */
export function unsubscribeLinkDays(regimes: readonly Regime[]): number {
  return Math.max(0, ...regimes.map((r) => r.unsubscribe_link_min_days ?? 0));
}

/**
 * Pure: consent that can be demonstrated — GDPR Art. 7(1) and CASL put
 * the proof on the sender — names how it was obtained and when.
 */
export function consentEvidenceGap(
  contact: Pick<ContactRow, "consent_source" | "consent_captured_at">,
): string | null {
  if (contact.consent_source.trim() === "") return "how the consent was obtained isn't recorded";
  if (!contact.consent_captured_at) return "when the consent was given isn't recorded";
  return null;
}

/**
 * The whole pre-send check for one recipient: SYB's consent gate
 * (explicit, unsuppressed), demonstrable consent, a known regime on both
 * sides, and a message complete for every regime that applies. Every
 * failing reason is returned, not just the first.
 */
export async function canSendMarketing(args: {
  contact: ContactRow;
  businessCountry: string | null;
  recipientCountry?: string | null;
  message: MarketingMessage;
}): Promise<EmailPermission & { regimes: RegimeId[] }> {
  const reasons: string[] = [];
  const gate = await canEmailForMarketing(args.contact);
  if (!gate.allowed) reasons.push(gate.reason);
  const evidence = consentEvidenceGap(args.contact);
  if (evidence) reasons.push(evidence);
  const lookup = applicableRegimes({
    businessCountry: args.businessCountry,
    recipientCountry: args.recipientCountry ?? null,
  });
  if (!lookup.ok) reasons.push(lookup.reason);
  else {
    const gaps = messageGaps(args.message, lookup.regimes);
    if (gaps.length > 0) reasons.push(`the message is missing ${gaps.join("; ")}`);
  }
  const regimes = lookup.ok ? lookup.regimes.map((r) => r.id) : [];
  return reasons.length === 0
    ? {
        allowed: true,
        reason: `explicit consent on record; complete under ${regimes.join(", ")}`,
        regimes,
      }
    : { allowed: false, reason: reasons.join("; "), regimes };
}
