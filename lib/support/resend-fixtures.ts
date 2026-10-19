// Recorded-shape Resend receiving payloads — fixtures for P4-09's tests
// and the local demo. Shapes copied from Resend's docs (read 2026-10-19):
// the `email.received` webhook event ("Create receiving webhook") and the
// response of GET /emails/receiving/{id} ("Retrieve received email").
// Values are invented; field names and nesting are the docs'. Nothing
// here touches the network.

export interface ReceivedFixture {
  email_id: string;
  from: string;
  to: string[];
  received_for?: string[];
  subject: string;
  text: string | null;
  html?: string;
  message_id: string;
  in_reply_to?: string;
  references?: string;
  created_at: string;
}

/** The webhook event body, exactly as Resend posts it: metadata only, no body or headers. */
export function receivedEvent(f: ReceivedFixture) {
  return {
    type: "email.received",
    created_at: f.created_at,
    data: {
      email_id: f.email_id,
      created_at: f.created_at,
      from: f.from,
      to: f.to,
      bcc: [],
      cc: [],
      received_for: f.received_for ?? [],
      message_id: f.message_id,
      subject: f.subject,
      attachments: [],
    },
  };
}

/** The GET /emails/receiving/{id} answer: the body and the headers as a name → value map. */
export function receivedEmail(f: ReceivedFixture) {
  const headers: Record<string, string> = {
    from: f.from,
    to: f.to.join(", "),
    subject: f.subject,
    "message-id": f.message_id,
    "mime-version": "1.0",
    "return-path": `<${f.from.replace(/^.*<|>.*$/g, "")}>`,
  };
  if (f.in_reply_to) headers["in-reply-to"] = f.in_reply_to;
  if (f.references) headers.references = f.references;
  return {
    object: "email",
    id: f.email_id,
    to: f.to,
    from: f.from,
    created_at: f.created_at,
    subject: f.subject,
    html: f.html ?? (f.text ? `<p>${f.text.replace(/\n/g, "<br>")}</p>` : ""),
    html_format: "data_uri",
    text: f.text,
    headers,
    bcc: [],
    cc: [],
    reply_to: [],
    received_for: f.received_for ?? [],
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    message_id: f.message_id,
    raw: null,
    attachments: [],
  };
}

/** A fetch stand-in serving received emails by id; anything else fails loudly. */
export function fakeResendReceiving(emails: readonly ReceivedFixture[]) {
  const byId = new Map(emails.map((e) => [e.email_id, e]));
  const calls: string[] = [];
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    const m = /^https:\/\/api\.resend\.com\/emails\/receiving\/([^/?]+)$/.exec(url);
    if (!m || (init.method ?? "GET") !== "GET") throw new Error(`unexpected request ${url}`);
    const f = byId.get(m[1]!);
    if (!f) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify(receivedEmail(f)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}
