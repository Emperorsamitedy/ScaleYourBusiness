// Pure read-model for a campaign's send on /customers — P4-15.
//
// The owner reads, per campaign: where it stands in one sentence, which
// gate is holding it (in words, first in the engine's order), the counts —
// sent, refused by reason, outcome unknown, failed, still to send,
// unsubscribed since — and, plainly, that a sent email can't be recalled.
// Counted from the API's figures; nothing is estimated.

import { num } from "../sheet/num";

export type SendPhase = "awaiting_draft" | "awaiting_approval" | "held" | "sending" | "sent";

export interface SendCounts {
  pending: number;
  refused: number;
  sending: number;
  sent: number;
  failed: number;
  unknown: number;
  unsubscribed: number;
  total: number;
  refused_by_reason: Record<string, number>;
}

export interface SendView {
  phase: SendPhase;
  gates: { code: string; words: string }[];
  counts: SendCounts;
  approved_at: string | null;
  subject: string | null;
  body_sha256: string | null;
  execution: {
    status: string;
    held_for: string | null;
    error: string | null;
    finished_at: string | null;
  } | null;
}

/** The owner's words for each refusal code — never an address, never a name. */
export const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  consent_implied: "consent only implied",
  consent_unsure: "consent unsure",
  consent_none: "no consent",
  suppressed: "unsubscribed, marked as spam, or erased",
  consent_unproven: "consent not recorded with how and when",
  no_regime: "in a country I have no email rules for",
  message_incomplete: "the email lacked something their law requires",
  no_email: "no email address",
  contact_gone: "no longer in your customers",
  duplicate_address: "same address as another recipient",
};

/** Pure: the phase as a worded flag; cobalt only while the machine is genuinely sending. */
export function phaseFlag(phase: SendPhase): {
  word: string;
  tone: "ok" | "low" | "drift" | "live";
} {
  switch (phase) {
    case "sent":
      return { word: "sent", tone: "ok" };
    case "sending":
      return { word: "sending", tone: "live" };
    case "held":
      return { word: "held", tone: "drift" };
    case "awaiting_approval":
      return { word: "awaiting your approval", tone: "low" };
    default:
      return { word: "not drafted", tone: "low" };
  }
}

const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;

/** Pure: where the send stands, in one first-person sentence. */
export function sendSentence(v: SendView, recipients: number): string {
  switch (v.phase) {
    case "awaiting_draft":
      return "Approved. Draft the email next; nothing sends until you approve the email itself.";
    case "awaiting_approval":
      return `Drafted for ${plural(recipients, "customer", "customers")}. Read it, then approve the email itself to send it.`;
    case "held":
      return v.gates[0]
        ? `Approved, not sent. ${v.gates[0].words}`
        : "Approved, not sent yet. It goes out on the next run.";
    case "sending":
      return `Sending: ${num(v.counts.sent)} of ${num(v.counts.total)} sent so far. The rest go out on the next run, each checked again as it goes.`;
    case "sent":
      return `Sent to ${plural(v.counts.sent, "customer", "customers")}${v.execution?.finished_at ? ` on ${v.execution.finished_at.slice(0, 10)}` : ""}. A sent email can't be recalled.`;
  }
}

/** Pure: the counts table, in order, leaving out what is zero (except sent). */
export function countRows(c: SendCounts): { label: string; n: number }[] {
  const rows: { label: string; n: number }[] = [
    { label: "sent", n: c.sent },
    { label: "refused at send", n: c.refused },
    { label: "outcome unknown", n: c.unknown + c.sending },
    { label: "refused by the email service", n: c.failed },
    { label: "still to send", n: c.pending },
    { label: "unsubscribed since", n: c.unsubscribed },
  ];
  return rows.filter((r, i) => i === 0 || r.n > 0);
}

/** Pure: refused recipients by reason, most first, in words. */
export function refusalLines(c: SendCounts): string[] {
  return Object.entries(c.refused_by_reason)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `${REFUSAL_WORDS[code] ?? code} · ${num(n)}`);
}

/** Pure: the honest line about unconfirmed sends, or null. */
export function unknownLine(c: SendCounts): string | null {
  const n = c.unknown + c.sending;
  if (n === 0) return null;
  return `${plural(n, "email", "emails")} may have gone out: the email service didn't confirm either way. I won't send to ${n === 1 ? "that customer" : "those customers"} again for this campaign.`;
}

/* ── P4-17: the readback, once a campaign has gone out ── */

export type ReadbackVerdict = "helped" | "did_nothing" | "backfired" | "too_early" | "unmeasured";

export interface ReadbackGroup {
  size: number;
  erased: number;
  measured: number;
  returned: number;
  waiting: number;
  measured_through: string | null;
}

export interface ReadbackView {
  verdict: ReadbackVerdict;
  kind: "winback" | "vip";
  lift_pp: number | null;
  controlled: boolean;
  arithmetic: string;
  sent_on: string | null;
  delivery: {
    sent: number;
    unknown: number;
    delivered: number;
    bounced: number;
    complained: number;
    unsubscribed: number;
    harmed: number;
  };
  recipients: ReadbackGroup;
  comparison: ReadbackGroup;
  /** Whether the email service's delivery webhook is set up at all. */
  delivery_reported: boolean;
  /** Where replies go: the owner's own address, named in their consent. */
  replies_to: string | null;
}

/** Pure: the verdict as a worded flag — the same words as the history ledger. */
export function readbackFlag(v: ReadbackVerdict): { word: string; tone: "ok" | "low" | "alarm" } {
  switch (v) {
    case "helped":
      return { word: "helped", tone: "ok" };
    case "backfired":
      return { word: "backfired", tone: "alarm" };
    case "did_nothing":
      return { word: "did nothing", tone: "low" };
    case "too_early":
      return { word: "too early to say", tone: "low" };
    default:
      return { word: "unmeasured", tone: "low" };
  }
}

const rate = (n: number, d: number): string => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);

/** Pure: the readback table — label, count with its unit, and the rate it is a share of. */
export function readbackRows(r: ReadbackView): { label: string; count: string; rate: string }[] {
  const d = r.delivery;
  const emails = (n: number) => `${num(n)} ${n === 1 ? "email" : "emails"}`;
  const people = (n: number) => `${num(n)} ${n === 1 ? "person" : "people"}`;
  const reported = (n: number, unit: (n: number) => string) =>
    r.delivery_reported
      ? { count: unit(n), rate: rate(n, d.sent) }
      : { count: "not reported", rate: "—" };
  const group = r.kind === "vip" ? "best customers" : "lapsed customers";
  const rows = [
    { label: "sent", count: emails(d.sent), rate: "" },
    { label: "delivered", ...reported(d.delivered, emails) },
    { label: "bounced", ...reported(d.bounced, emails) },
    { label: "unsubscribed", count: people(d.unsubscribed), rate: rate(d.unsubscribed, d.sent) },
    { label: "marked as spam", ...reported(d.complained, people) },
    { label: "replied", count: "not counted", rate: "—" },
    {
      label: "bought again since",
      count: `${num(r.recipients.returned)} of ${num(r.recipients.measured)} measured`,
      rate: rate(r.recipients.returned, r.recipients.measured),
    },
    {
      label: `${group} not emailed, bought again`,
      count: `${num(r.comparison.returned)} of ${num(r.comparison.measured)} measured`,
      rate: rate(r.comparison.returned, r.comparison.measured),
    },
  ];
  if (r.lift_pp !== null) {
    rows.push({
      label: "difference",
      count: `${r.lift_pp >= 0 ? "+" : "−"}${num(Math.abs(r.lift_pp), 1)} points`,
      rate: "",
    });
  }
  return rows;
}

/** Pure: one first-person sentence on what was measured and what wasn't. */
export function measuredSentence(r: ReadbackView): string {
  const through = r.recipients.measured_through ?? r.comparison.measured_through;
  const counted = [
    r.delivery_reported ? "delivery, bounces and spam reports from the email service" : null,
    "unsubscribes from the links in each email",
    through
      ? `purchases from your shop export of ${through.slice(0, 10)}`
      : "purchases from your next shop export, once it comes in",
  ].filter((x): x is string => x !== null);
  const notCounted = [
    r.delivery_reported
      ? null
      : "delivery and spam reports (the email service's webhook isn't set up yet)",
    "opens (that needs a tracking pixel, which is a consent question of its own, and Apple Mail reports opens nobody made)",
    `replies, which go straight to you${r.replies_to ? ` at ${r.replies_to}` : ""}`,
  ].filter((x): x is string => x !== null);
  const last = counted.pop();
  const lastNot = notCounted.pop();
  return (
    `I counted ${counted.length > 0 ? `${counted.join(", ")} and ` : ""}${last}; ` +
    `I don't count ${notCounted.length > 0 ? `${notCounted.join(", ")} or ` : ""}${lastNot}` +
    `${r.controlled ? ", and the customers I compare against never said yes to email, so the comparison isn't a controlled test" : ""}.`
  );
}
