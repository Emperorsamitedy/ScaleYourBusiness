// P6-08, the pure half: TwiML that can't start a recording before its
// notice (rule 32), the opening a caller hears in each setting and
// language, the keep-days setting, the seal on stored audio, and Twilio's
// Recordings resource addressed by id only. Each with a passing and a
// failing case.

import { describe, expect, it } from "vitest";
import { PHONE_RECORDING_KEEP_DAYS_DEFAULT, phoneRecordingKeepDays } from "../env";
import { LOCALES } from "../i18n/locales";
import { trFor } from "../i18n/server-tr";
import {
  FAKE_ACCOUNT_SID,
  FAKE_AUTH_TOKEN,
  fakeRecordingSid,
  fakeTwilioApi,
} from "../phone/fake-twilio";
import { RECORDING_PATH, openingVerbs } from "../phone/line";
import { RecordingBeforeNoticeError, TWILIO_VOICES, twiml } from "../phone/twilio";
import { SealError, openAudio, recordingKey, sealAudio } from "./seal";
import {
  TwilioRecordingError,
  basicAuth,
  deleteRecordingAtTwilio,
  downloadRecording,
  recordingResourceUrl,
} from "./twilio-api";

const voice = TWILIO_VOICES.en;
const env = { accountSid: FAKE_ACCOUNT_SID, authToken: FAKE_AUTH_TOKEN };

describe("rule 32 in the TwiML itself: no recording before its notice", () => {
  it("writes <Start><Recording> after a recording notice", () => {
    const xml = twiml(voice, [
      { verb: "say", text: "This call is recorded.", recordingNotice: true },
      { verb: "record", callback: RECORDING_PATH },
      { verb: "hangup" },
    ]);
    expect(xml.indexOf("This call is recorded.")).toBeLessThan(xml.indexOf("<Start><Recording"));
    expect(xml).toContain('recordingStatusCallback="/api/phone/recording"');
    expect(xml).toContain('recordingStatusCallbackEvent="completed absent"');
  });

  it("refuses a recording with no notice, or with the notice after it", () => {
    expect(() => twiml(voice, [{ verb: "record", callback: RECORDING_PATH }])).toThrow(
      RecordingBeforeNoticeError,
    );
    expect(() =>
      twiml(voice, [
        { verb: "say", text: "Hello." }, // a <Say> that isn't the recording notice
        { verb: "record", callback: RECORDING_PATH },
      ]),
    ).toThrow(RecordingBeforeNoticeError);
    expect(() =>
      twiml(voice, [
        { verb: "record", callback: RECORDING_PATH },
        { verb: "say", text: "This call is recorded.", recordingNotice: true },
      ]),
    ).toThrow(RecordingBeforeNoticeError);
  });

  it("a caller's words can't become a recording: they are escaped text", () => {
    const xml = twiml(voice, [
      {
        verb: "say",
        text: '<Start><Recording recordingStatusCallback="https://evil.test"/></Start>',
      },
    ]);
    expect(xml).not.toMatch(/<Start>|<Recording/);
  });
});

describe("the opening a caller hears", () => {
  for (const locale of LOCALES) {
    it(`${locale}: recorded — greeting, the recording notice with the days, then recording, then listening`, () => {
      const t = trFor(locale, "phoneLine");
      const verbs = openingVerbs({ t }, "Rosa's Bakery", true, 30);
      expect(verbs.map((v) => v.verb)).toEqual(["say", "say", "record", "gather"]);
      const notice = verbs[1];
      expect(notice?.verb === "say" && notice.recordingNotice).toBe(true);
      expect(notice?.verb === "say" && notice.text).toContain("30");
      expect(() => twiml(TWILIO_VOICES[locale], verbs)).not.toThrow();
    });

    it(`${locale}: not recorded — the transcription notice, and no recording at all`, () => {
      const t = trFor(locale, "phoneLine");
      const verbs = openingVerbs({ t }, "Rosa's Bakery", false, 30);
      expect(verbs.map((v) => v.verb)).toEqual(["say", "say", "gather"]);
      expect(twiml(TWILIO_VOICES[locale], verbs)).not.toMatch(/<Start>|<Recording/);
    });
  }

  it("says one day in the singular", () => {
    const t = trFor("en", "phoneLine");
    const one = openingVerbs({ t }, "Rosa's Bakery", true, 1)[1];
    expect(one?.verb === "say" && one.text).toMatch(/kept for 1 day,/);
  });
});

describe("PHONE_RECORDING_KEEP_DAYS", () => {
  it("reads whole days from 1 to 365, and anything else as the default", () => {
    const saved = process.env.PHONE_RECORDING_KEEP_DAYS;
    try {
      delete process.env.PHONE_RECORDING_KEEP_DAYS;
      expect(phoneRecordingKeepDays()).toBe(PHONE_RECORDING_KEEP_DAYS_DEFAULT);
      process.env.PHONE_RECORDING_KEEP_DAYS = "7";
      expect(phoneRecordingKeepDays()).toBe(7);
      process.env.PHONE_RECORDING_KEEP_DAYS = "365";
      expect(phoneRecordingKeepDays()).toBe(365);
      for (const bad of ["0", "366", "-3", "7.5", "forever", "1e3"]) {
        process.env.PHONE_RECORDING_KEEP_DAYS = bad;
        expect(phoneRecordingKeepDays(), bad).toBe(30);
      }
    } finally {
      if (saved === undefined) delete process.env.PHONE_RECORDING_KEEP_DAYS;
      else process.env.PHONE_RECORDING_KEEP_DAYS = saved;
    }
  });
});

describe("the seal on stored audio", () => {
  const key = recordingKey(Buffer.alloc(32, 1).toString("base64"));
  const audio = new Uint8Array(Buffer.from("ID3 fake mp3 bytes, long enough to matter"));

  it("opens to the same audio, and two seals of it differ", () => {
    const a = sealAudio(audio, key);
    const b = sealAudio(audio, key);
    expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
    expect(Buffer.from(openAudio(a, key))).toEqual(Buffer.from(audio));
  });

  it("refuses the wrong key, a flipped byte, a truncated file, or plain audio", () => {
    const sealed = sealAudio(audio, key);
    const other = recordingKey(Buffer.alloc(32, 2).toString("base64"));
    expect(() => openAudio(sealed, other)).toThrow(SealError);
    const flipped = new Uint8Array(sealed);
    flipped[flipped.length - 1]! ^= 1;
    expect(() => openAudio(flipped, key)).toThrow(SealError);
    expect(() => openAudio(sealed.subarray(0, 20), key)).toThrow(SealError);
    expect(() => openAudio(audio, key)).toThrow(SealError);
  });

  it("is not the connection-secrets key itself, and refuses a short key", () => {
    const raw = Buffer.alloc(32, 1);
    expect(recordingKey(raw.toString("base64")).equals(raw)).toBe(false);
    expect(() => recordingKey("too-short")).toThrow();
  });
});

describe("Twilio's Recordings resource, by id only", () => {
  it("builds Twilio's own address from the ids, and refuses anything else", () => {
    const sid = fakeRecordingSid();
    expect(recordingResourceUrl(FAKE_ACCOUNT_SID, sid, ".mp3")).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${FAKE_ACCOUNT_SID}/Recordings/${sid}.mp3`,
    );
    expect(() => recordingResourceUrl(FAKE_ACCOUNT_SID, "RE../../x", ".mp3")).toThrow(
      TwilioRecordingError,
    );
    expect(() => recordingResourceUrl("ACnope", sid, ".json")).toThrow(TwilioRecordingError);
  });

  it("authenticates with the account's Basic credentials", () => {
    expect(basicAuth(env)).toBe(
      `Basic ${Buffer.from(`${FAKE_ACCOUNT_SID}:${FAKE_AUTH_TOKEN}`).toString("base64")}`,
    );
  });

  it("downloads the audio; a 401, a 404 or an oversized file throws", async () => {
    const api = fakeTwilioApi();
    const sid = fakeRecordingSid();
    const audio = api.add(sid);
    const got = await downloadRecording(env, sid, { fetch: api.fetch });
    expect(Buffer.from(got.body)).toEqual(Buffer.from(audio));
    await expect(
      downloadRecording({ ...env, authToken: "wrong" }, sid, { fetch: api.fetch }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      downloadRecording(env, fakeRecordingSid(), { fetch: api.fetch }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      downloadRecording(env, sid, { fetch: api.fetch, maxBytes: 100 }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("deletes Twilio's copy (204), takes 404 as already gone, and throws on anything else", async () => {
    const api = fakeTwilioApi();
    const sid = fakeRecordingSid();
    api.add(sid);
    expect(await deleteRecordingAtTwilio(env, sid, { fetch: api.fetch })).toBe("deleted");
    expect(api.has(sid)).toBe(false);
    expect(await deleteRecordingAtTwilio(env, sid, { fetch: api.fetch })).toBe("already_gone");
    api.failNext("DELETE", 500);
    await expect(deleteRecordingAtTwilio(env, sid, { fetch: api.fetch })).rejects.toMatchObject({
      status: 500,
    });
  });
});
