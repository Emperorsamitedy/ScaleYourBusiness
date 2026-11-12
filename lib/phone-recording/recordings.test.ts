// P6-08's done-when, as tests, against this machine's database, a fake
// Twilio REST API (lib/phone/fake-twilio) and an in-memory media store —
// no phone call, no network. Every rule with a passing and a failing case:
//
//   off by default — a line records nothing until the owner switches it on,
//                    and the switch is a recorded fact (who, when).
//   rule 32        — the recording notice is spoken BEFORE <Start><Recording>;
//                    a recording for a call that never heard it is deleted
//                    at Twilio, never fetched.
//   one copy       — once stored (sealed), Twilio's copy is deleted; a
//                    failed delete is retried by the daily upkeep.
//   keep N days    — the upkeep deletes both copies after the keep date.
//   rule 22        — erasing a call or a contact deletes the recording in
//                    SYB storage and at Twilio; the log keeps ids only.
//   rule 34        — each stored recording is a cost line with its duration
//                    and Twilio's per-minute price stated as unknown.

import "dotenv/config";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  contacts,
  decisionLog,
  intakeEvents,
  phoneCalls,
  phoneRecordings,
  phoneSettings,
  supportSettings,
} from "../../db/schema";
import type { MemoryMediaStore } from "../content/media";
import { memoryMediaStore } from "../content/media";
import { addContact, eraseContact } from "../crm/contacts";
import { ensureSupportSettings } from "../crm/support-settings";
import { bootstrapIntake } from "../intake/service";
import { PhoneDeskError, eraseCall, listCalls, setCallRecording } from "../phone-desk/desk";
import type { FakeTwilioApi } from "../phone/fake-twilio";
import {
  FAKE_ACCOUNT_SID,
  FAKE_AUTH_TOKEN,
  callParams,
  fakeCallSid,
  fakeNumber,
  fakeRecordingSid,
  fakeTwilioApi,
  recordingParams,
} from "../phone/fake-twilio";
import { RECORDING_PATH, handleVoice } from "../phone/line";
import type { RecordingDeps } from "./recordings";
import {
  TWILIO_PRICE_UNKNOWN,
  openRecording,
  recordingCallback,
  recordingsHeld,
  runRecordingUpkeep,
  setRecordingDepsForTests,
} from "./recordings";
import { openAudio } from "./seal";
import { inPhoneCountry, switchPhoneCountryOn } from "../phone/test-country";

// Hard rule 6 (architecture-v2 D6): these businesses are in a switched-on country.
let restoreCountries: () => Promise<void> | void = () => undefined;
beforeAll(async () => {
  restoreCountries = await switchPhoneCountryOn();
});
afterAll(() => restoreCountries());

const KEY = Buffer.alloc(32, 7);
const created: { account_id: string; profile_id: string }[] = [];
const OWNER = { user_id: "00000000-0000-4000-8000-0000000000aa" };

let api: FakeTwilioApi;
let store: MemoryMediaStore;
let deps: Partial<RecordingDeps>;

const TWILIO_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"] as const;
const saved: Partial<Record<string, string | undefined>> = {};

beforeEach(() => {
  api = fakeTwilioApi();
  store = memoryMediaStore();
  deps = {
    fetch: api.fetch,
    store,
    twilio: { accountSid: FAKE_ACCOUNT_SID, authToken: FAKE_AUTH_TOKEN },
    key: () => KEY,
    keepDays: 30,
  };
  // Every path that doesn't take deps (erasure from lib/crm, the desk) uses these.
  setRecordingDepsForTests(deps);
  for (const k of TWILIO_KEYS) saved[k] = process.env[k];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  setRecordingDepsForTests(null);
  for (const k of TWILIO_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

afterAll(async () => {
  const profileIds = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (profileIds.length > 0) {
    await db.delete(phoneRecordings).where(inArray(phoneRecordings.profile_id, profileIds));
    await db.delete(phoneCalls).where(inArray(phoneCalls.profile_id, profileIds));
    await db.delete(phoneSettings).where(inArray(phoneSettings.profile_id, profileIds));
    await db.delete(supportSettings).where(inArray(supportSettings.profile_id, profileIds));
    await db.delete(contacts).where(inArray(contacts.account_id, accountIds));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, profileIds));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, profileIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

/** A business with a phone line on a number of its own; recording as asked (default: off). */
async function business(opts: { record?: boolean; handover?: string } = {}) {
  const s = await bootstrapIntake();
  await inPhoneCountry(s.profile_id);
  created.push(s);
  await ensureSupportSettings(s.profile_id);
  await db
    .update(supportSettings)
    .set({ business_name: "Rosa's Bakery" })
    .where(eq(supportSettings.profile_id, s.profile_id));
  const number = fakeNumber();
  await db.insert(phoneSettings).values({
    profile_id: s.profile_id,
    account_id: s.account_id,
    phone_number: number,
    ...(opts.record !== undefined ? { record_calls: opts.record } : {}),
    ...(opts.handover !== undefined ? { handover_number: opts.handover } : {}),
  });
  return { ...s, number };
}

async function start(b: { number: string }, from = "+447700900001") {
  const sid = fakeCallSid();
  // The v1 spec §9.2: the disclosure and the consent question first; the caller presses 1.
  const first = await handleVoice("start", callParams({ callSid: sid, to: b.number, from }));
  const consented = await handleVoice(
    "consent",
    callParams({ callSid: sid, to: b.number, from, Digits: "1" }),
  );
  return { sid, xml: first + consented, first };
}

async function callRow(sid: string) {
  const [row] = await db.select().from(phoneCalls).where(eq(phoneCalls.call_sid, sid));
  return row!;
}

async function recordingRows(callSidOrProfile: { profile_id: string }) {
  return db
    .select()
    .from(phoneRecordings)
    .where(eq(phoneRecordings.profile_id, callSidOrProfile.profile_id));
}

/** A recorded call, its finished recording at Twilio, and Twilio's callback delivered. */
async function recordedCall(b: { number: string; profile_id: string }, from?: string) {
  const { sid } = await start(b, from);
  const recordingSid = fakeRecordingSid();
  const audio = api.add(recordingSid);
  const outcome = await recordingCallback(
    recordingParams({ callSid: sid, recordingSid, duration: 37 }),
    deps,
  );
  return { sid, recordingSid, audio, outcome, call: await callRow(sid) };
}

const logged = () =>
  vi
    .mocked(console.log)
    .mock.calls.map((c) => String(c[0]))
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("off by default: no audio until the owner switches recording on", () => {
  it("a new line records nothing: the transcription notice only, no <Start>, no stamp", async () => {
    const b = await business();
    const [settings] = await db
      .select()
      .from(phoneSettings)
      .where(eq(phoneSettings.profile_id, b.profile_id));
    expect(settings?.record_calls).toBe(false);
    const { sid, xml } = await start(b);
    expect(xml).toMatch(/no audio is kept/);
    expect(xml).not.toMatch(/<Start>|<Recording|<Record/);
    expect((await callRow(sid)).recording_notice_at).toBeNull();
  });

  it("switched on, the caller hears it is recorded, and only then does recording start", async () => {
    const b = await business({ record: true });
    const { sid, xml } = await start(b);
    const notice = xml.indexOf("This call is recorded and transcribed");
    const recording = xml.indexOf("<Start><Recording");
    const listening = xml.indexOf('<Gather input="speech"');
    expect(notice).toBeGreaterThan(xml.indexOf("automated assistant")); // rule 31 first
    expect(recording).toBeGreaterThan(notice); // rule 32: the notice before the recording
    expect(listening).toBeGreaterThan(recording);
    expect(xml).toMatch(/kept for 30 days/);
    expect(xml).toContain(`recordingStatusCallback="${RECORDING_PATH}"`);
    expect(xml).toContain('channels="mono"');
    expect((await callRow(sid)).recording_notice_at).not.toBeNull();
  });

  it("a call answered before the switch keeps what it was told, even on a retried webhook", async () => {
    const b = await business();
    const { sid } = await start(b);
    await db
      .update(phoneSettings)
      .set({ record_calls: true })
      .where(eq(phoneSettings.profile_id, b.profile_id));
    const again = await handleVoice("start", callParams({ callSid: sid, to: b.number }));
    expect(again).not.toMatch(/<Start>/);
    expect((await callRow(sid)).recording_notice_at).toBeNull();
  });
});

describe("decision 5 (owner, 2026-11-09): nobody who picks up a put-through is recorded", () => {
  const askForPerson = (b: { number: string }, sid: string) =>
    handleVoice(
      "turn",
      callParams({ callSid: sid, to: b.number, SpeechResult: "Can I speak to a real person?" }),
      {
        llm: async () => {
          throw new Error("the model must not be called");
        },
      },
    );

  it("a transferred recorded call stops its recording, by name, before it dials", async () => {
    const b = await business({ record: true, handover: "+447700900999" });
    const { sid, xml: opening } = await start(b);
    expect(opening).toContain('<Start><Recording name="syb-call"');
    const xml = await askForPerson(b, sid);
    const said = xml.indexOf("Putting you through");
    const stop = xml.indexOf('<Stop><Recording name="syb-call"/></Stop>');
    const dial = xml.indexOf("<Dial");
    expect(said).toBeGreaterThan(-1); // the caller, who heard the notice, is still told
    expect(stop).toBeGreaterThan(said);
    expect(dial).toBeGreaterThan(stop);
    expect(xml).toContain("<Number>+447700900999</Number>");
    // Not started again when nobody picks up: the message is transcribed, not recorded.
    const missed = await handleVoice(
      "dial",
      callParams({ callSid: sid, to: b.number, DialCallStatus: "no-answer" }),
    );
    expect(missed).not.toMatch(/<Start>|<Recording/);
  });

  it("a call that isn't recorded dials with nothing to stop", async () => {
    const b = await business({ handover: "+447700900998" });
    const { sid } = await start(b);
    const xml = await askForPerson(b, sid);
    expect(xml).toContain("<Dial");
    expect(xml).not.toMatch(/<Stop>|<Recording/);
  });
});

describe("the owner's switch is a recorded fact", () => {
  it("on and off, each on the decision log with who and when; the same setting twice logs once", async () => {
    process.env.TWILIO_ACCOUNT_SID = FAKE_ACCOUNT_SID;
    process.env.TWILIO_AUTH_TOKEN = FAKE_AUTH_TOKEN;
    process.env.TWILIO_PHONE_NUMBER = "+447700900123";
    const b = await business();
    const on = await setCallRecording(b.profile_id, true, OWNER);
    expect(on.record_calls).toBe(true);
    expect(on.record_changed_at).not.toBeNull();
    await setCallRecording(b.profile_id, true, OWNER);
    await setCallRecording(b.profile_id, false, OWNER);
    const entries = await db
      .select()
      .from(decisionLog)
      .where(
        and(eq(decisionLog.profile_id, b.profile_id), eq(decisionLog.kind, "recording_consent")),
      );
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.user_id === OWNER.user_id && e.actor === "owner")).toBe(true);
    const [settings] = await db
      .select()
      .from(phoneSettings)
      .where(eq(phoneSettings.profile_id, b.profile_id));
    expect(settings?.record_calls).toBe(false);
    expect(settings?.record_changed_by).toBe(OWNER.user_id);
  });

  it("refuses to switch on where audio couldn't be fetched, sealed and kept — and without a line", async () => {
    for (const k of TWILIO_KEYS) delete process.env[k];
    const b = await business();
    await expect(setCallRecording(b.profile_id, true, OWNER)).rejects.toThrow(
      /not set up on this server/,
    );
    const s = await bootstrapIntake();
    await inPhoneCountry(s.profile_id);
    created.push(s);
    await expect(setCallRecording(s.profile_id, true, OWNER)).rejects.toBeInstanceOf(
      PhoneDeskError,
    );
    const [settings] = await db
      .select()
      .from(phoneSettings)
      .where(eq(phoneSettings.profile_id, b.profile_id));
    expect(settings?.record_calls).toBe(false);
  });
});

describe("one copy: stored sealed in SYB, then deleted at Twilio", () => {
  it("fetches the finished recording by its id, seals it, stores it, and deletes Twilio's copy", async () => {
    const b = await business({ record: true });
    const { recordingSid, audio, outcome, call } = await recordedCall(b);
    expect(outcome).toBe("stored");
    const [row] = await recordingRows(b);
    expect(row).toMatchObject({ status: "stored", at_twilio: false, duration_seconds: 37 });
    expect(api.has(recordingSid)).toBe(false);
    // Every request authenticated, to Twilio's own Recordings resource by id.
    expect(api.requests.map((r) => [r.method, r.authorized])).toEqual([
      ["GET", true],
      ["DELETE", true],
    ]);
    expect(api.requests[0]?.url).toMatch(new RegExp(`/Recordings/${recordingSid}\\.mp3$`));
    // At rest it is sealed: the stored bytes are not the audio, and open to it.
    const sealed = store.read(row!.storage_url!)!;
    expect(Buffer.from(sealed).includes(Buffer.from(audio.subarray(0, 64)))).toBe(false);
    expect(Buffer.from(openAudio(sealed, KEY))).toEqual(Buffer.from(audio));
    // The owner's player gets the audio back; the call lists it without an address.
    const opened = await openRecording(b.profile_id, call.id, deps);
    expect(Buffer.from(opened.body)).toEqual(Buffer.from(audio));
    expect(opened.content_type).toBe("audio/mpeg");
    const [listed] = await listCalls(b.profile_id);
    expect(listed?.recorded).toBe(true);
    expect(listed?.recording?.id).toBe(row!.id);
    expect(JSON.stringify(listed)).not.toContain(row!.storage_url!);
    // Expires keepDays after it was stored.
    const keptMs = Date.parse(row!.expires_at!) - Date.parse(row!.stored_at!);
    expect(Math.round(keptMs / 86_400_000)).toBe(30);
  });

  it("rule 34: a cost line with the duration, and Twilio's per-minute price stated as unknown", async () => {
    const b = await business({ record: true });
    const { call } = await recordedCall(b);
    const line = logged().find((l) => l.event === "phone_recording");
    expect(line).toMatchObject({
      workload: "phone_recording",
      account_id: b.account_id,
      call_id: call.id,
      duration_seconds: 37,
      cost_eur: null,
      cost_note: TWILIO_PRICE_UNKNOWN,
    });
  });

  it("a duplicate callback stores nothing twice", async () => {
    const b = await business({ record: true });
    const { sid, recordingSid } = await recordedCall(b);
    const again = await recordingCallback(recordingParams({ callSid: sid, recordingSid }), deps);
    expect(again).toBe("duplicate");
    expect(await recordingRows(b)).toHaveLength(1);
    expect(store.urls()).toHaveLength(1);
  });

  it("a failed delete at Twilio leaves it marked, and the upkeep deletes it there", async () => {
    const b = await business({ record: true });
    api.failNext("DELETE", 503);
    const { recordingSid } = await recordedCall(b);
    expect(api.has(recordingSid)).toBe(true);
    expect((await recordingRows(b))[0]?.at_twilio).toBe(true);
    const result = await runRecordingUpkeep(deps);
    expect(result.released).toBeGreaterThanOrEqual(1);
    expect(api.has(recordingSid)).toBe(false);
    expect((await recordingRows(b))[0]).toMatchObject({ status: "stored", at_twilio: false });
  });

  it("a failed fetch keeps it pending at Twilio, and the upkeep stores it later", async () => {
    const b = await business({ record: true });
    api.failNext("GET", 500);
    const { outcome, recordingSid } = await recordedCall(b);
    expect(outcome).toBe("not_stored");
    expect((await recordingRows(b))[0]).toMatchObject({ status: "pending", storage_url: null });
    expect(store.urls()).toEqual([]);
    await runRecordingUpkeep(deps);
    expect((await recordingRows(b))[0]?.status).toBe("stored");
    expect(api.has(recordingSid)).toBe(false);
  });

  it("never fetches from the address a callback names — only Twilio's, by id", async () => {
    const b = await business({ record: true });
    const { sid } = await start(b);
    const recordingSid = fakeRecordingSid();
    api.add(recordingSid);
    await recordingCallback(
      { ...recordingParams({ callSid: sid, recordingSid }), RecordingUrl: "https://evil.test/x" },
      deps,
    );
    expect(api.requests.every((r) => r.url.startsWith("https://api.twilio.com/"))).toBe(true);
  });
});

describe("rule 32 at the callback: a recording nobody was told about is never kept", () => {
  it("deletes it at Twilio unfetched for a call that never heard the recording notice", async () => {
    const b = await business(); // recording off: the caller heard only the transcription notice
    const { sid } = await start(b);
    const recordingSid = fakeRecordingSid();
    api.add(recordingSid);
    const outcome = await recordingCallback(recordingParams({ callSid: sid, recordingSid }), deps);
    expect(outcome).toBe("refused");
    expect(api.requests.map((r) => r.method)).toEqual(["DELETE"]); // never a GET
    expect(api.has(recordingSid)).toBe(false);
    expect(store.urls()).toEqual([]);
    expect(await recordingRows(b)).toEqual([]);
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.some((l) => l.includes("phone_recording_without_notice"))).toBe(true);
  });

  it("a refused recording whose delete fails stays marked until the upkeep deletes it", async () => {
    const b = await business();
    const { sid } = await start(b);
    const recordingSid = fakeRecordingSid();
    api.add(recordingSid);
    api.failNext("DELETE", 500);
    await recordingCallback(recordingParams({ callSid: sid, recordingSid }), deps);
    expect((await recordingRows(b))[0]).toMatchObject({ status: "refused", storage_url: null });
    await runRecordingUpkeep(deps);
    expect(api.has(recordingSid)).toBe(false);
    expect(await recordingRows(b)).toEqual([]);
  });

  it("a recording for no call of ours is deleted at Twilio, and nothing is kept", async () => {
    const recordingSid = fakeRecordingSid();
    api.add(recordingSid);
    const outcome = await recordingCallback(
      recordingParams({ callSid: fakeCallSid(), recordingSid }),
      deps,
    );
    expect(outcome).toBe("no_call");
    expect(api.has(recordingSid)).toBe(false);
    expect(store.urls()).toEqual([]);
  });

  it("ignores events it doesn't act on, and ids that aren't Twilio's shape", async () => {
    const b = await business({ record: true });
    const { sid } = await start(b);
    const recordingSid = fakeRecordingSid();
    expect(
      await recordingCallback(
        recordingParams({ callSid: sid, recordingSid, status: "in-progress" }),
        deps,
      ),
    ).toBe("ignored");
    expect(
      await recordingCallback(
        { ...recordingParams({ callSid: sid, recordingSid }), RecordingSid: "../../etc" },
        deps,
      ),
    ).toBe("ignored");
    expect(
      await recordingCallback(
        recordingParams({ callSid: sid, recordingSid, status: "absent" }),
        deps,
      ),
    ).toBe("absent");
    expect(api.requests).toEqual([]);
  });
});

describe("rule 22: erasure removes both copies; the log keeps ids", () => {
  it("erasing a call deletes its recording in SYB storage and the row; the log holds ids only", async () => {
    const b = await business({ record: true });
    const { call } = await recordedCall(b);
    const [row] = await recordingRows(b);
    expect(store.urls()).toHaveLength(1);
    const result = await eraseCall(b.account_id, call.id, deps);
    expect(result.recordings_pending).toBe(0);
    expect(store.urls()).toEqual([]);
    expect(await recordingRows(b)).toEqual([]);
    expect(await recordingsHeld(b.profile_id)).toBe(0);
    const [entry] = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.ref_id, call.id), eq(decisionLog.kind, "erasure")));
    expect(entry?.payload_hash).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            account_id: b.account_id,
            call_id: call.id,
            recording_ids: [row!.id],
          }),
        )
        .digest("hex"),
    );
  });

  it("erasing a call whose recording is still at Twilio deletes it there too", async () => {
    const b = await business({ record: true });
    api.failNext("DELETE", 503); // the copy at Twilio survives the store
    const { call, recordingSid } = await recordedCall(b);
    expect(api.has(recordingSid)).toBe(true);
    await eraseCall(b.account_id, call.id, deps);
    expect(api.has(recordingSid)).toBe(false);
    expect(store.urls()).toEqual([]);
    expect(await recordingRows(b)).toEqual([]);
  });

  it("an erasure whose deletes fail leaves it unplayable and marked, and the upkeep finishes it", async () => {
    const b = await business({ record: true });
    const { call } = await recordedCall(b);
    const failing: MemoryMediaStore = {
      ...store,
      del: async () => {
        throw new Error("store down");
      },
    };
    const result = await eraseCall(b.account_id, call.id, { ...deps, store: failing });
    expect(result.recordings_pending).toBe(1);
    const [marked] = await recordingRows(b);
    expect(marked?.purge_requested_at).not.toBeNull();
    expect(marked?.call_id).toBeNull();
    await expect(openRecording(b.profile_id, call.id, deps)).rejects.toThrow(/no such recording/);
    await runRecordingUpkeep(deps);
    expect(store.urls()).toEqual([]);
    expect(await recordingRows(b)).toEqual([]);
  });

  it("erasing a contact deletes the recordings of the calls their number made, both copies", async () => {
    const b = await business({ record: true });
    const contact = await addContact(b.account_id, {
      name: "Ana",
      phone: "+44 7700 900777",
      consent: { status: "unsure", source: "phoned in" },
    });
    api.failNext("DELETE", 503); // one copy still at Twilio when the erasure comes
    const mine = await recordedCall(b, "+447700900777");
    const other = await recordedCall(b, "+447700900778");
    expect(api.has(mine.recordingSid)).toBe(true);
    await eraseContact(b.account_id, contact.id);
    expect(api.has(mine.recordingSid)).toBe(false);
    const left = await recordingRows(b);
    expect(left.map((r) => r.call_id)).toEqual([other.call.id]);
    expect(store.urls()).toHaveLength(1);
  });
});

describe("kept PHONE_RECORDING_KEEP_DAYS, then deleted", () => {
  it("the upkeep deletes a recording past its keep date — and keeps one that isn't", async () => {
    const b = await business({ record: true });
    const { call } = await recordedCall(b);
    await runRecordingUpkeep(deps);
    expect(await recordingRows(b)).toHaveLength(1);
    const later = new Date(Date.now() + 31 * 86_400_000);
    await expect(
      openRecording(b.profile_id, call.id, { ...deps, now: () => later }),
    ).rejects.toThrow(/no such recording/);
    await runRecordingUpkeep({ ...deps, now: () => later });
    expect(await recordingRows(b)).toEqual([]);
    expect(store.urls()).toEqual([]);
  });
});

describe("the owner's ears only", () => {
  it("opens a recording only for its own business", async () => {
    const b = await business({ record: true });
    const other = await business({ record: true });
    const { call } = await recordedCall(b);
    await expect(openRecording(other.profile_id, call.id, deps)).rejects.toThrow(
      /no such recording/,
    );
    expect((await openRecording(b.profile_id, call.id, deps)).body.byteLength).toBeGreaterThan(0);
  });
});
