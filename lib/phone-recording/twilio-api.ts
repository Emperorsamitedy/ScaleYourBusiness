// Twilio's Recordings REST resource — P6-08. Two calls, both on SYB's own
// Twilio account, both by the recording's id (never by a URL a request
// handed us, so a forged or replayed callback can't point SYB at another
// host):
//
//   GET    /2010-04-01/Accounts/{AC}/Recordings/{RE}.mp3   the audio
//   DELETE /2010-04-01/Accounts/{AC}/Recordings/{RE}.json  Twilio's copy, gone
//
// HTTP Basic auth with the Account SID and Auth Token the line already has
// (Twilio accepts it; an API key would be its preferred form — see
// specs/twilio-recording-v1.md for what its docs confirmed and didn't).
// The DELETE is the one call here that changes anything at Twilio, and all
// it changes is to remove a caller's audio once SYB holds the only copy, or
// when it was never let in (rules 22, 32). Every call has a timeout; none
// is retried here — the daily upkeep is the retry.

import type { TwilioEnv } from "../env";

export const TWILIO_API = "https://api.twilio.com/2010-04-01";

/** Twilio's recording ids: "RE" and 32 hex. Checked before any URL is built. */
export const RECORDING_SID_RE = /^RE[0-9a-f]{32}$/i;

/** The largest recording fetched: 25 MB is about 100 minutes of Twilio's 32 kbps MP3. */
export const RECORDING_MAX_BYTES = 25 * 1024 * 1024;
export const RECORDING_DOWNLOAD_TIMEOUT_MS = 60_000;
export const RECORDING_DELETE_TIMEOUT_MS = 15_000;

export class TwilioRecordingError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "TwilioRecordingError";
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Pure: the recording's REST address. Throws on an id that isn't Twilio's shape. */
export function recordingResourceUrl(
  accountSid: string,
  recordingSid: string,
  ext: ".mp3" | ".json",
): string {
  if (!RECORDING_SID_RE.test(recordingSid)) {
    throw new TwilioRecordingError("not a Twilio recording id");
  }
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) {
    throw new TwilioRecordingError("not a Twilio account id");
  }
  return `${TWILIO_API}/Accounts/${accountSid}/Recordings/${recordingSid}${ext}`;
}

/** Pure: HTTP Basic credentials — never logged. */
export function basicAuth(env: Pick<TwilioEnv, "accountSid" | "authToken">): string {
  return `Basic ${Buffer.from(`${env.accountSid}:${env.authToken}`, "utf8").toString("base64")}`;
}

/** The finished recording's audio, as MP3. Over the cap or anything but 200 throws. */
export async function downloadRecording(
  env: Pick<TwilioEnv, "accountSid" | "authToken">,
  recordingSid: string,
  opts: { fetch?: FetchLike; maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ body: Uint8Array; content_type: string }> {
  const doFetch = opts.fetch ?? fetch;
  const max = opts.maxBytes ?? RECORDING_MAX_BYTES;
  const res = await doFetch(recordingResourceUrl(env.accountSid, recordingSid, ".mp3"), {
    method: "GET",
    headers: { Authorization: basicAuth(env) },
    signal: AbortSignal.timeout(opts.timeoutMs ?? RECORDING_DOWNLOAD_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    throw new TwilioRecordingError(`Twilio answered ${res.status} for the recording`, res.status);
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) throw new TwilioRecordingError("the recording is over the size cap", 413);
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.byteLength === 0) throw new TwilioRecordingError("the recording is empty", 422);
  if (body.byteLength > max)
    throw new TwilioRecordingError("the recording is over the size cap", 413);
  return { body, content_type: "audio/mpeg" };
}

/**
 * Delete Twilio's copy. 204 is deleted; 404 is already gone (both mean no
 * copy is left there). Anything else throws, and the row keeps at_twilio
 * so the daily upkeep tries again.
 */
export async function deleteRecordingAtTwilio(
  env: Pick<TwilioEnv, "accountSid" | "authToken">,
  recordingSid: string,
  opts: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<"deleted" | "already_gone"> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(recordingResourceUrl(env.accountSid, recordingSid, ".json"), {
    method: "DELETE",
    headers: { Authorization: basicAuth(env) },
    signal: AbortSignal.timeout(opts.timeoutMs ?? RECORDING_DELETE_TIMEOUT_MS),
  });
  if (res.status === 204 || res.status === 200) return "deleted";
  if (res.status === 404) return "already_gone";
  throw new TwilioRecordingError(`Twilio answered ${res.status} to the delete`, res.status);
}
