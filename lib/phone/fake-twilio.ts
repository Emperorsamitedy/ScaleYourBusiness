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

/* ── P6-08: recordings ── */

/** A fresh Twilio-shaped recording id: "RE" and 32 hex. */
export function fakeRecordingSid(): string {
  return `RE${randomBytes(16).toString("hex")}`;
}

/** What Twilio posts to recordingStatusCallback when a recording is finished. */
export function recordingParams(args: {
  callSid: string;
  recordingSid: string;
  status?: "completed" | "absent" | "in-progress";
  duration?: number;
}): Record<string, string> {
  const params: Record<string, string> = {
    AccountSid: FAKE_ACCOUNT_SID,
    CallSid: args.callSid,
    RecordingSid: args.recordingSid,
    RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${FAKE_ACCOUNT_SID}/Recordings/${args.recordingSid}`,
    RecordingStatus: args.status ?? "completed",
    RecordingChannels: "1",
    RecordingSource: "StartCallRecordingTwiML",
    RecordingStartTime: new Date().toUTCString(),
    RecordingTrack: "both",
  };
  if ((args.status ?? "completed") === "completed") {
    params.RecordingDuration = String(args.duration ?? 42);
  }
  return params;
}

export interface FakeTwilioApi {
  /** A fetch that answers as Twilio's Recordings resource does — and refuses any other host. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Put a finished recording "at Twilio". */
  add(recordingSid: string, audio?: Uint8Array): Uint8Array;
  /** Is Twilio still holding it? */
  has(recordingSid: string): boolean;
  /** Every request made, method and path. */
  requests: { method: string; url: string; authorized: boolean }[];
  /** Make the next n requests of this method fail with this status. */
  failNext(method: "GET" | "DELETE", status: number, n?: number): void;
}

/**
 * Twilio's Recordings REST resource, in memory: GET <sid>.mp3 answers the
 * audio, DELETE <sid>.json answers 204 and forgets it (404 after), and a
 * request without the account's Basic credentials gets 401 — as Twilio
 * answers when media URLs require HTTP auth.
 */
export function fakeTwilioApi(authToken = FAKE_AUTH_TOKEN): FakeTwilioApi {
  const held = new Map<string, Uint8Array>();
  const failures: { method: string; status: number; n: number }[] = [];
  const requests: FakeTwilioApi["requests"] = [];
  const expectedAuth = `Basic ${Buffer.from(`${FAKE_ACCOUNT_SID}:${authToken}`).toString("base64")}`;
  const base = `https://api.twilio.com/2010-04-01/Accounts/${FAKE_ACCOUNT_SID}/Recordings/`;
  return {
    requests,
    add(sid, audio) {
      const body = audio ?? new Uint8Array(randomBytes(4096));
      held.set(sid, body);
      return body;
    },
    has: (sid) => held.has(sid),
    failNext(method, status, n = 1) {
      failures.push({ method, status, n });
    },
    async fetch(input, init) {
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const authorized = headers.get("authorization") === expectedAuth;
      requests.push({ method, url: input, authorized });
      if (!input.startsWith(base)) throw new Error(`fake Twilio: no such host or path ${input}`);
      const fail = failures.find((f) => f.method === method && f.n > 0);
      if (fail) {
        fail.n -= 1;
        return new Response(JSON.stringify({ status: fail.status }), { status: fail.status });
      }
      if (!authorized) return new Response("unauthorized", { status: 401 });
      const rest = input.slice(base.length);
      const m = /^(RE[0-9a-f]{32})\.(mp3|json)$/i.exec(rest);
      if (!m) return new Response("not found", { status: 404 });
      const sid = m[1]!;
      if (method === "GET" && m[2] === "mp3") {
        const audio = held.get(sid);
        if (!audio) return new Response("not found", { status: 404 });
        return new Response(Buffer.from(audio), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg", "Content-Length": String(audio.byteLength) },
        });
      }
      if (method === "DELETE" && m[2] === "json") {
        if (!held.delete(sid)) return new Response("not found", { status: 404 });
        return new Response(null, { status: 204 });
      }
      return new Response("method not allowed", { status: 405 });
    },
  };
}
