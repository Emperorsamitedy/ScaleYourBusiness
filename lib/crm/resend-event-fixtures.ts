// Recorded-shape Resend delivery events — fixtures for P4-17's tests.
// Shapes copied from Resend's docs (read 2026-10-19): "Webhooks → Emails →
// delivered / bounced / complained / suppressed / opened". Values are
// invented; field names and nesting are the docs'. Nothing here touches
// the network.

export type FixtureEventType =
  | "email.delivered"
  | "email.bounced"
  | "email.complained"
  | "email.suppressed"
  | "email.opened"
  | "email.clicked";

/** One webhook body, exactly as Resend posts it. */
export function deliveryEvent(
  type: FixtureEventType,
  emailId: string,
  opts: { to?: string; at?: string; bounceType?: string; sendId?: string } = {},
) {
  const at = opts.at ?? new Date().toISOString();
  const data: Record<string, unknown> = {
    broadcast_id: "8b146471-e88e-4322-86af-016cd36fd216",
    created_at: at,
    email_id: emailId,
    message_id: "<111-222-333@email.example.com>",
    from: '"Emberworks via Ledgerline" <hello@send.syb.test>',
    to: [opts.to ?? "someone@customers.test"],
    subject: "A note from Emberworks",
    // Resend echoes the send's tags; SYB tags each send with its row id (review #14).
    tags: { category: "campaign", ...(opts.sendId ? { syb_send: opts.sendId } : {}) },
  };
  if (type === "email.bounced") {
    data.bounce = {
      // The server's message quotes the address in real bounces; SYB never keeps it.
      message: `The recipient's mailbox ${opts.to ?? "someone@customers.test"} does not exist.`,
      subType: "General",
      type: opts.bounceType ?? "Permanent",
    };
  }
  if (type === "email.suppressed") {
    data.suppressed = {
      message:
        "Resend has suppressed sending to this address because it is on the account-level suppression list.",
      type: "OnAccountSuppressionList",
    };
  }
  if (type === "email.clicked") {
    data.click = { ipAddress: "203.0.113.7", link: "https://example.com", timestamp: at };
  }
  return { type, created_at: at, data };
}
