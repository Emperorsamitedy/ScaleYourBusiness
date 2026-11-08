// Approvals that went stale — review 2026-10-23, Session D #1. Pure.
//
// An approval is for something at a time and on a premise. While the
// Session D real-write gate is off, after a long emergency stop, or after a
// paused connection is reconnected, an approved post or ad change can sit
// for weeks; the day it may run, it must not go out as if nothing had
// changed — a "Halloween special" in December, or a pause or a raise whose
// 14- or 28-day ROAS reasoning is a month old. The ±50% and ceiling checks
// re-run at execution; the premise doesn't. So:
//
//   a publish more than PUBLISH_STALE_AFTER_MS past its time is not posted
//     late. The due runner fires once a day (05:00 UTC, ±59 min on Hobby —
//     TASKS-PHASE3.md, P3-20e), so a post's first chance can come up to
//     about 26 hours after its time; 30 hours lets that one run post it and
//     refuses anything that has missed a further day.
//   an ad change approved more than AD_APPROVAL_MAX_AGE_DAYS ago is not
//     made. Fourteen days is the same span an ad proposal lives undecided
//     (ADS.expiry_days, pinned equal in a test): the measured days behind it
//     are that old again by then.
//
// The engine checks this before the real-write gate and before the claim
// (guard 3a), so nothing is sent — not even a read — and the proposal
// becomes `expired`, with the owner told in words.

export const PUBLISH_STALE_AFTER_MS = 30 * 3_600_000;
export const AD_APPROVAL_MAX_AGE_DAYS = 14;

/** What the engine knows of the approval it is about to act on. */
export interface ApprovalView {
  decided_at: string | null;
  execute_not_before: string | null;
  action: unknown;
}

function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** "23 October", in the business's zone when the proposal names one. */
export function dayWord(at: number, zone?: unknown): string {
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" };
  try {
    return new Intl.DateTimeFormat("en-GB", {
      ...options,
      timeZone: typeof zone === "string" && zone !== "" ? zone : "UTC",
    }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(at);
  }
}

/** The owner's sentence for a publish that lapsed, or null while it is still in time. */
export function stalePublish(p: ApprovalView, now: Date): string | null {
  const detail = (p.action as { detail?: { publish_at?: unknown; zone?: unknown } } | null)?.detail;
  const due = instant(p.execute_not_before) ?? instant(detail?.publish_at);
  if (due === null || now.getTime() - due <= PUBLISH_STALE_AFTER_MS) return null;
  return `I didn't post this — it was due on ${dayWord(due, detail?.zone)}; propose it again if it still fits.`;
}

/** The owner's sentence for an ad change approved too long ago, or null while it may run. */
export function staleAdChange(p: ApprovalView, now: Date): string | null {
  const approved = instant(p.decided_at);
  if (approved === null) return null;
  if (now.getTime() - approved <= AD_APPROVAL_MAX_AGE_DAYS * 86_400_000) return null;
  return `I didn't make this change — you approved it on ${dayWord(approved)}, and the numbers behind it are more than ${AD_APPROVAL_MAX_AGE_DAYS} days old now. Nothing was changed; it needs proposing again on fresh numbers.`;
}

/**
 * What the real-write gate's refusal adds for a provider whose approvals can
 * go stale — instead of promising it "goes out on the first run after it is
 * switched on", which was not what happens.
 */
export const STALE_NOTE: Readonly<Record<"meta_publish" | "meta_ads" | "tiktok_publish", string>> =
  {
    meta_publish:
      "Once it's switched on, it goes out on the next run if that is within 30 hours of its time; later than that it isn't posted late — I'll tell you, and it can be proposed again.",
    tiktok_publish:
      "Once it's switched on, it goes out on the next run if that is within 30 hours of its time; later than that it isn't posted late — I'll tell you, and it can be proposed again.",
    meta_ads: `Once it's switched on, it runs on the next run if you approved it within the last ${AD_APPROVAL_MAX_AGE_DAYS} days; an older approval isn't acted on stale numbers — I'll tell you instead.`,
  };
