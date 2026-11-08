// P6-02, the pure half: Twilio's request signature, TwiML that can't be
// talked into a verb, the seven voices, and numbers. Each rule with a
// passing and a failing case.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n/locales";
import { FAKE_AUTH_TOKEN, twilioRequest } from "./fake-twilio";
import {
  TWILIO_VOICES,
  escapeXml,
  formParams,
  signedUrls,
  toE164,
  twilioSignature,
  twiml,
  verifyTwilioSignature,
} from "./twilio";

const URL_ = "https://syb.example/api/phone/voice?step=turn";
const PARAMS = { CallSid: "CA1", To: "+447700900123", From: "+447700900001", SpeechResult: "hi" };

describe("the request signature (Twilio's scheme)", () => {
  it("is base64 HMAC-SHA1 of the URL and the parameters sorted by name, each name then value", () => {
    // Written out by hand, independent of the implementation's sort.
    const data =
      URL_ +
      "CallSid" +
      "CA1" +
      "From" +
      "+447700900001" +
      "SpeechResult" +
      "hi" +
      "To" +
      "+447700900123";
    const expected = createHmac("sha1", FAKE_AUTH_TOKEN).update(data).digest("base64");
    expect(twilioSignature(FAKE_AUTH_TOKEN, URL_, PARAMS)).toBe(expected);
  });

  it("passes for the signed request, whatever order the parameters arrive in", () => {
    const sig = twilioSignature(FAKE_AUTH_TOKEN, URL_, PARAMS);
    const reordered = {
      SpeechResult: "hi",
      To: "+447700900123",
      From: "+447700900001",
      CallSid: "CA1",
    };
    expect(verifyTwilioSignature(FAKE_AUTH_TOKEN, [URL_], reordered, sig)).toBe(true);
  });

  it("fails for a changed parameter, another URL, another token, or no signature at all", () => {
    const sig = twilioSignature(FAKE_AUTH_TOKEN, URL_, PARAMS);
    expect(
      verifyTwilioSignature(FAKE_AUTH_TOKEN, [URL_], { ...PARAMS, SpeechResult: "hj" }, sig),
    ).toBe(false);
    expect(verifyTwilioSignature(FAKE_AUTH_TOKEN, [`${URL_}x`], PARAMS, sig)).toBe(false);
    expect(verifyTwilioSignature("another-token", [URL_], PARAMS, sig)).toBe(false);
    expect(verifyTwilioSignature(FAKE_AUTH_TOKEN, [URL_], PARAMS, null)).toBe(false);
    expect(verifyTwilioSignature(FAKE_AUTH_TOKEN, [URL_], PARAMS, "")).toBe(false);
    expect(verifyTwilioSignature("", [URL_], PARAMS, sig)).toBe(false);
  });

  it("accepts the URL as APP_URL names it, when a proxy changed the one the server saw", () => {
    const seen = "http://internal:3000/api/phone/voice?step=turn";
    const urls = signedUrls(seen, "https://syb.example/");
    expect(urls).toEqual([seen, URL_]);
    const sig = twilioSignature(FAKE_AUTH_TOKEN, URL_, PARAMS);
    expect(verifyTwilioSignature(FAKE_AUTH_TOKEN, urls, PARAMS, sig)).toBe(true);
    expect(verifyTwilioSignature(FAKE_AUTH_TOKEN, signedUrls(seen, undefined), PARAMS, sig)).toBe(
      false,
    );
  });

  it("the fake Twilio's request round-trips: its body parses back to what was signed", async () => {
    const req = twilioRequest({ url: URL_, params: PARAMS });
    const params = formParams(await req.text());
    expect(params).toEqual(PARAMS);
    expect(
      verifyTwilioSignature(FAKE_AUTH_TOKEN, [URL_], params, req.headers.get("x-twilio-signature")),
    ).toBe(true);
  });
});

describe("TwiML: every word escaped, so nothing said becomes a verb (rule 24)", () => {
  const voice = TWILIO_VOICES.en;

  it("escapes a model's or caller's attempt to smuggle in a <Dial> or a <Record>", () => {
    const out = twiml(voice, [
      { verb: "say", text: '</Say><Dial>+15550000000</Dial><Record/><Say a="' },
      { verb: "hangup" },
    ]);
    expect(out).not.toMatch(/<Dial>/);
    expect(out).not.toMatch(/<Record/);
    expect(out).toContain("&lt;/Say&gt;&lt;Dial&gt;");
    expect(escapeXml(`a&b<c>"d'`)).toBe("a&amp;b&lt;c&gt;&quot;d&apos;");
  });

  it("says plain words as they are (the passing case)", () => {
    const out = twiml(voice, [{ verb: "say", text: "Open nine to six." }]);
    expect(out).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Google.en-GB-Standard-A" language="en-GB">Open nine to six.</Say></Response>',
    );
  });

  it("gathers speech only — never digits, never a recording — in the line's language", () => {
    const out = twiml(TWILIO_VOICES["de-DE"], [
      {
        verb: "gather",
        action: "/api/phone/voice?step=turn",
        timeout: 6,
        prompt: "Wie kann ich helfen?",
      },
    ]);
    expect(out).toContain('<Gather input="speech"');
    expect(out).toContain('language="de-DE"');
    expect(out).toContain('action="/api/phone/voice?step=turn"');
    expect(out).not.toMatch(/record/i);
  });
});

describe("voices: the line speaks every language SYB writes", () => {
  it("has a voice, a speaking language and a listening language for each of the seven", () => {
    for (const l of LOCALES) {
      const v = TWILIO_VOICES[l];
      expect(v.voice, l).toMatch(/^Google\.[a-z]{2,3}-[A-Z]{2}-Standard-[A-Z]$/);
      expect(v.say, l).toMatch(/^[a-z]{2,3}-[A-Z]{2}$/);
      expect(v.gather, l).toMatch(/^[a-z]{2,3}(-[A-Z][a-z]{3})?-[A-Z]{2}$/);
    }
    expect(TWILIO_VOICES["hu-HU"].gather).toBe("hu-HU");
    expect(TWILIO_VOICES["zh-Hans"].gather).toBe("cmn-Hans-CN");
  });
});

describe("numbers", () => {
  it("reads a typed number as E.164", () => {
    expect(toE164("+44 7700 900123")).toBe("+447700900123");
    expect(toE164("+44 (0) 7700-900123")).toBe("+447700900123"); // the trunk "(0)" goes
    expect(toE164("+1 (555) 010-0000")).toBe("+15550100000");
  });
  it("refuses one without a country code, or that isn't a number", () => {
    expect(toE164("07700 900123")).toBeNull();
    expect(toE164("+0123456789")).toBeNull();
    expect(toE164("call me")).toBeNull();
    expect(toE164("")).toBeNull();
  });
});
