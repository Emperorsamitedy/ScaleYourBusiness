// Review notification emails in the shapes the 2026-10-29 research
// expected — fixtures for idea 45's tests and the local demo. INVENTED:
// no platform publishes its notification email and no real one has passed
// through SYB yet (specs/review-notifications-v1.json, every platform
// `verified: false`). Each is wrapped in a recorded-shape Resend payload
// (lib/support/resend-fixtures.ts) and goes through the real inbound path.
// Nothing here touches the network.

import type { ReceivedFixture } from "../support/resend-fixtures";

export interface NotificationFixture {
  from: string;
  subject: string;
  text: string;
}

/** Google, auto-forwarded: the platform's own From line survives. */
export function googleNotification(args: {
  business: string;
  reviewer: string;
  stars: number;
  words: string | null;
  reviewId: string;
}): NotificationFixture {
  const glyphs = "★".repeat(args.stars) + "☆".repeat(5 - args.stars);
  return {
    from: "Google Business Profile <businessprofile-noreply@google.com>",
    subject: `${args.reviewer} left a review for ${args.business}`,
    text: [
      args.business,
      "",
      `${args.reviewer} left a review`,
      "",
      glyphs,
      "",
      ...(args.words ? [args.words, ""] : []),
      "Reply to review",
      `https://business.google.com/reviews/l/${args.reviewId}?hl=en`,
      "",
      "Manage notifications",
      `You received this email because you manage ${args.business} on Google.`,
      "Google LLC, 1600 Amphitheatre Parkway, Mountain View, CA 94043",
    ].join("\n"),
  };
}

/** Trustpilot, forwarded by hand from the owner's Gmail: the platform is in the forwarded block. */
export function trustpilotForwarded(args: {
  owner: string;
  business: string;
  reviewer: string;
  stars: number;
  title: string;
  words: string;
  reviewId: string;
  date: string;
}): NotificationFixture {
  const subject = `New ${args.stars}-star review for ${args.business}`;
  return {
    from: args.owner,
    subject: `Fwd: ${subject}`,
    text: [
      "",
      "---------- Forwarded message ---------",
      "From: Trustpilot <noreply@trustpilot.com>",
      `Date: ${args.date}`,
      `Subject: ${subject}`,
      `To: ${args.owner}`,
      "",
      "",
      "You've got a new review!",
      "",
      `Rated ${args.stars} out of 5 stars`,
      "",
      `Written by ${args.reviewer}`,
      "",
      `"${args.title}"`,
      "",
      args.words,
      "",
      "Reply to review",
      `https://businessapp.b2b.trustpilot.com/reviews/${args.reviewId}`,
      "",
      "You're receiving this because you're a user of Trustpilot Business.",
      "Unsubscribe",
    ].join("\n"),
  };
}

export function booksyNotification(args: {
  business: string;
  reviewer: string;
  stars: number;
  words: string;
  reviewId: string;
}): NotificationFixture {
  return {
    from: "Booksy <no-reply@booksy.com>",
    subject: "You have a new review",
    text: [
      `Hi ${args.business},`,
      "",
      `${args.reviewer} left you a review:`,
      "",
      `Rating: ${args.stars}/5`,
      "",
      `"${args.words}"`,
      "",
      "See the review in Booksy Biz",
      `https://booksy.com/biz/reviews/${args.reviewId}`,
    ].join("\n"),
  };
}

export function freshaNotification(args: {
  reviewer: string;
  stars: number;
  service: string;
  words: string;
  reviewId: string;
}): NotificationFixture {
  return {
    from: "Fresha <notifications@fresha.com>",
    subject: `New review from ${args.reviewer}`,
    text: [
      `New review from ${args.reviewer}`,
      "",
      `${args.reviewer} rated you ${args.stars} stars`,
      `Service: ${args.service}`,
      "",
      `"${args.words}"`,
      "",
      "View review",
      `https://partners.fresha.com/reviews/${args.reviewId}`,
      "",
      "Manage your notifications in Fresha.",
    ].join("\n"),
  };
}

/** A recognised sender whose format the parser can't read: no rating it knows. */
export function googleUnreadable(business: string): NotificationFixture {
  return {
    from: "Google Business Profile <businessprofile-noreply@google.com>",
    subject: `New review for ${business}`,
    text: [
      "Someone shared their experience with your business.",
      "",
      "Open your Business Profile to see what they said.",
      "https://business.google.com/reviews/l/00000000000000000000",
    ].join("\n"),
  };
}

/** The Resend fixture for a notification sent (or forwarded) to `to`. */
export function reviewEmailFixture(
  n: NotificationFixture,
  to: string,
  over: Partial<ReceivedFixture> = {},
): ReceivedFixture {
  return {
    email_id: crypto.randomUUID(),
    from: n.from,
    to: ["hello@business.example"],
    received_for: [to],
    subject: n.subject,
    text: n.text,
    message_id: `<${crypto.randomUUID()}@mail.example.com>`,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}
