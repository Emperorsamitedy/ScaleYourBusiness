// Twilio's side of the phone line — P6-02. Pure: no database, no network.
//
//   · The request signature. Twilio signs every webhook with the account's
//     auth token: HMAC-SHA1 over the full URL it requested followed by each
//     POST parameter's name and value, sorted by name, base64 — sent as
//     X-Twilio-Signature. An unsigned or badly signed request is refused
//     before anything is read (app/api/phone/voice).
//   · TwiML, the XML a voice webhook answers with. Every spoken word goes
//     through `escapeXml`, so nothing a model or a caller produced can
//     become a verb: a caller can't talk the line into <Dial>ing anyone or
//     <Record>ing anything (rule 24). There is no <Record> verb at all. The
//     one way audio is kept is <Start><Recording> (P6-08), which only the
//     line's own code asks for, when the owner switched recording on — and
//     `twiml` refuses to write it unless a recording notice was spoken
//     earlier in the same document (rule 32). Decision 5 (owner,
//     2026-11-09): a recording is stopped with <Stop><Recording> before
//     any <Dial>, so the person who picks up a put-through — who heard no
//     notice — is never recorded; `twiml` refuses a <Dial> while a
//     recording may be running.
//   · The voices: each of the seven languages SYB writes has a Twilio
//     text-to-speech voice and a speech-recognition language, so the line
//     speaks the business's own language.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppLocale } from "../i18n/locales";

/* ── the signature ── */

/** Pure: Twilio's signature for one request — base64 HMAC-SHA1 of the URL and the sorted parameters. */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/**
 * True when `signature` is Twilio's for any of `urls` (the URL as this
 * server saw it, and as APP_URL names it — a proxy can change one but not
 * what Twilio signed). Constant-time; an empty or missing header is false.
 */
export function verifyTwilioSignature(
  authToken: string,
  urls: readonly string[],
  params: Readonly<Record<string, string>>,
  signature: string | null | undefined,
): boolean {
  if (!signature || authToken === "") return false;
  const given = Buffer.from(signature, "utf8");
  let ok = false;
  for (const url of new Set(urls)) {
    const expected = Buffer.from(twilioSignature(authToken, url, params), "utf8");
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}

/** The URLs Twilio may have signed: the request's own, and the same path and query on APP_URL. */
export function signedUrls(requestUrl: string, appUrl: string | undefined): string[] {
  const urls = [requestUrl];
  const base = appUrl?.trim().replace(/\/$/, "") ?? "";
  if (base !== "") {
    const u = new URL(requestUrl);
    urls.push(`${base}${u.pathname}${u.search}`);
  }
  return urls;
}

/** A form body as Twilio sends it, to a flat map (a repeated name keeps its last value). */
export function formParams(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

/* ── voices ── */

export interface TwilioVoice {
  /** <Say voice="…"> */
  voice: string;
  /** <Say language="…"> */
  say: string;
  /** <Gather language="…"> — the speech-recognition language. */
  gather: string;
}

/**
 * Twilio's Google voices and speech-recognition languages for SYB's seven.
 * English is British English: SYB's businesses are European.
 */
export const TWILIO_VOICES: Readonly<Record<AppLocale, TwilioVoice>> = {
  en: { voice: "Google.en-GB-Standard-A", say: "en-GB", gather: "en-GB" },
  "es-ES": { voice: "Google.es-ES-Standard-A", say: "es-ES", gather: "es-ES" },
  "de-DE": { voice: "Google.de-DE-Standard-A", say: "de-DE", gather: "de-DE" },
  "fr-FR": { voice: "Google.fr-FR-Standard-A", say: "fr-FR", gather: "fr-FR" },
  "hu-HU": { voice: "Google.hu-HU-Standard-A", say: "hu-HU", gather: "hu-HU" },
  "ru-RU": { voice: "Google.ru-RU-Standard-A", say: "ru-RU", gather: "ru-RU" },
  "zh-Hans": { voice: "Google.cmn-CN-Standard-A", say: "cmn-CN", gather: "cmn-Hans-CN" },
};

/* ── TwiML ── */

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type Verb =
  | {
      verb: "say";
      text: string;
      /** P6-08: this <Say> tells the caller the call is recorded. A recording may start after it. */
      recordingNotice?: true;
    }
  | {
      /**
       * P6-08: <Start><Recording> — Twilio records the call from here on and
       * carries on with the next verb. Mono, both sides, to `callback`.
       */
      verb: "record";
      /** Relative to the webhook ("/api/phone/recording"): Twilio resolves and signs it. */
      callback: string;
    }
  | {
      /**
       * Decision 5 (owner, 2026-11-09): <Stop><Recording name="…"> — ends the
       * call's recording, by the name it was started with, before a <Dial>.
       */
      verb: "stopRecording";
    }
  | {
      verb: "gather";
      /** Relative to the webhook ("/api/phone/voice?step=turn"): Twilio resolves and signs it. */
      action: string;
      /** Seconds of silence before Twilio gives up waiting for speech to start. */
      timeout: number;
      /** Said while listening — the caller can talk over it. */
      prompt?: string;
    }
  | { verb: "dial"; number: string; action: string; timeout: number }
  | { verb: "hangup" };

/** Thrown when a document would start a recording before telling the caller (rule 32). */
export class RecordingBeforeNoticeError extends Error {
  constructor() {
    super("rule 32: a recording starts only after the caller has heard that the call is recorded");
    this.name = "RecordingBeforeNoticeError";
  }
}

/**
 * Thrown when a document would put a call through while it may be recorded
 * (decision 5, owner 2026-11-09): the person who answers heard no notice, so
 * the recording stops first.
 */
export class DialWhileRecordingError extends Error {
  constructor() {
    super(
      "decision 5: a recording stops before a call is put through — the person who answers heard no notice",
    );
    this.name = "DialWhileRecordingError";
  }
}

/**
 * The name SYB gives the one recording a call has. Twilio stops a recording
 * by the `name` it was started with, unique per call (specs/twilio-recording-v1.md).
 */
export const RECORDING_NAME = "syb-call";

export interface TwimlState {
  /**
   * A recording may already be running from an earlier document of this
   * call (it was answered with the recording notice and <Start><Recording>).
   * Then a <Dial> needs a `stopRecording` before it in this document.
   */
  recording?: boolean;
}

/**
 * Pure: one TwiML document, every word escaped, every <Say> in the line's
 * voice. Two orders are refused, read verb by verb as Twilio runs them:
 *
 *   · a `record` with no recording notice before it (rule 32) — a <Say>
 *     plays to its end before the next verb, so a notice placed earlier has
 *     been heard when the recording starts;
 *   · a `dial` while a recording may be running — started earlier in this
 *     document, or in an earlier one (`state.recording`) — with no
 *     `stopRecording` between (decision 5).
 */
export function twiml(voice: TwilioVoice, verbs: readonly Verb[], state: TwimlState = {}): string {
  let noticeHeard = false;
  let recording = state.recording === true;
  for (const v of verbs) {
    if (v.verb === "say" && v.recordingNotice === true) noticeHeard = true;
    if (v.verb === "record") {
      if (!noticeHeard) throw new RecordingBeforeNoticeError();
      recording = true;
    }
    if (v.verb === "stopRecording") recording = false;
    if (v.verb === "dial" && recording) throw new DialWhileRecordingError();
  }
  const say = (text: string) =>
    `<Say voice="${escapeXml(voice.voice)}" language="${escapeXml(voice.say)}">${escapeXml(text)}</Say>`;
  const body = verbs
    .map((v) => {
      switch (v.verb) {
        case "say":
          return say(v.text);
        case "gather":
          return (
            `<Gather input="speech" action="${escapeXml(v.action)}" method="POST" ` +
            `language="${escapeXml(voice.gather)}" speechTimeout="auto" timeout="${v.timeout}" ` +
            `actionOnEmptyResult="true">${v.prompt ? say(v.prompt) : ""}</Gather>`
          );
        case "dial":
          return (
            `<Dial action="${escapeXml(v.action)}" method="POST" timeout="${v.timeout}">` +
            `<Number>${escapeXml(v.number)}</Number></Dial>`
          );
        case "record":
          // Twilio's attributes (specs/twilio-recording-v1.md): one mono file of
          // both sides, silence kept so it matches the transcript's timing,
          // and a callback only when it is finished (or absent).
          return (
            `<Start><Recording name="${RECORDING_NAME}" channels="mono" track="both" trim="do-not-trim" ` +
            `recordingStatusCallback="${escapeXml(v.callback)}" ` +
            `recordingStatusCallbackMethod="POST" ` +
            `recordingStatusCallbackEvent="completed absent"/></Start>`
          );
        case "stopRecording":
          // Twilio's form (specs/twilio-recording-v1.md): stop by the start's name.
          return `<Stop><Recording name="${RECORDING_NAME}"/></Stop>`;
        case "hangup":
          return "<Hangup/>";
      }
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

/** E.164, as Twilio writes numbers: "+" then 7 to 15 digits, no leading zero. */
export const E164_RE = /^\+[1-9][0-9]{6,14}$/;

/**
 * A number the owner typed ("+44 7700 900123", "+44 (0) 7700-900123") as
 * E.164, or null. The "(0)" some countries write is the trunk prefix, not
 * part of the number, so it goes.
 */
export function toE164(raw: string): string | null {
  const compact = raw
    .trim()
    .replace(/\(0\)/g, "")
    .replace(/[\s().-]/g, "");
  return E164_RE.test(compact) ? compact : null;
}
