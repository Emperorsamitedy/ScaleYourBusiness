// A fake Twilio for the tests — P6-02. Builds the requests Twilio sends a
// voice webhook (form-encoded, signed with X-Twilio-Signature exactly as
// Twilio signs them), so the line is proven end to end without a phone
// call, a Twilio account or the network. Nothing here is reached from the
// app: only tests import it.

import { randomBytes } from "node:crypto";
import { twilioSignature } from "./twilio";

export const FAKE_ACCOUNT_SID = `AC${"a1".repeat(16)}`;
export const FAKE_AUTH_TOKEN = "fake-twilio-auth-token";

/** A fresh Twilio-shaped call id: "CA" and 32 hex. */
export function fakeCallSid(): string {
  return `CA${randomBytes(16).toString("hex")}`;
}

/** A random E.164 number, so parallel tests never claim the same line. */
export function fakeNumber(): string {
  return `+4477009${String(Math.floor(Math.random() * 100_000)).padStart(5, "0")}`;
}

/** What Twilio posts when a call comes in, plus anything a later step adds. */
export function callParams(
  args: { callSid: string; to: string; from?: string | null } & Record<
    string,
    string | null | undefined
  >,
): Record<string, string> {
  const { callSid, to, from, ...rest } = args;
  const params: Record<string, string> = {
    AccountSid: FAKE_ACCOUNT_SID,
    ApiVersion: "2010-04-01",
    CallSid: callSid,
    CallStatus: "in-progress",
    Direction: "inbound",
    To: to,
    From: from === undefined ? "+447700900001" : (from ?? ""),
  };
  for (const [k, v] of Object.entries(rest)) if (typeof v === "string") params[k] = v;
  return params;
}

/**
 * A POST as Twilio sends it. `signature: undefined` signs it with `authToken`
 * (Twilio's way); a string sends that header as is; null sends none.
 */
export function twilioRequest(args: {
  url: string;
  params: Record<string, string>;
  authToken?: string;
  signature?: string | null;
}): Request {
  const signature =
    args.signature === undefined
      ? twilioSignature(args.authToken ?? FAKE_AUTH_TOKEN, args.url, args.params)
      : args.signature;
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (signature !== null) headers["X-Twilio-Signature"] = signature;
  return new Request(args.url, {
    method: "POST",
    headers,
    body: new URLSearchParams(args.params).toString(),
  });
}
