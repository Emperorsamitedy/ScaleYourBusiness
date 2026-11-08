// P6-08: Twilio's recording status callback is verified exactly as the
// voice webhook is — no Twilio settings, no signature, a bad one, another
// account's are each refused before a parameter is acted on — and a signed
// callback for a recorded call stores the audio and deletes Twilio's copy.
// Fake Twilio REST API and an in-memory store: no network.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../../../db";
import {
  accounts,
  businessProfiles,
  intakeEvents,
  phoneCalls,
  phoneRecordings,
  phoneSettings,
  supportSettings,
} from "../../../../db/schema";
import { memoryMediaStore } from "../../../../lib/content/media";
import { ensureSupportSettings } from "../../../../lib/crm/support-settings";
import { bootstrapIntake } from "../../../../lib/intake/service";
import { setRecordingDepsForTests } from "../../../../lib/phone-recording/recordings";
import type { FakeTwilioApi } from "../../../../lib/phone/fake-twilio";
import {
  FAKE_ACCOUNT_SID,
  FAKE_AUTH_TOKEN,
  callParams,
  fakeCallSid,
  fakeNumber,
  fakeRecordingSid,
  fakeTwilioApi,
  recordingParams,
  twilioRequest,
} from "../../../../lib/phone/fake-twilio";
import { handleVoice } from "../../../../lib/phone/line";
import { POST } from "./route";

const URL_ = "https://syb.example/api/phone/recording";
const created: { account_id: string; profile_id: string }[] = [];
const KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "APP_URL"] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

let api: FakeTwilioApi;
let number = "";
let profileId = "";

beforeEach(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  number = fakeNumber();
  process.env.TWILIO_ACCOUNT_SID = FAKE_ACCOUNT_SID;
  process.env.TWILIO_AUTH_TOKEN = FAKE_AUTH_TOKEN;
  process.env.TWILIO_PHONE_NUMBER = number;
  process.env.APP_URL = "https://syb.example";
  api = fakeTwilioApi();
  setRecordingDepsForTests({
    fetch: api.fetch,
    store: memoryMediaStore(),
    key: () => Buffer.alloc(32, 3),
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const s = await bootstrapIntake();
  created.push(s);
  profileId = s.profile_id;
  await ensureSupportSettings(s.profile_id);
  await db.insert(phoneSettings).values({
    profile_id: s.profile_id,
    account_id: s.account_id,
    phone_number: number,
    record_calls: true,
  });
});

afterEach(() => {
  setRecordingDepsForTests(null);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

afterAll(async () => {
  const profileIds = created.map((s) => s.profile_id);
  if (profileIds.length > 0) {
    await db.delete(phoneRecordings).where(inArray(phoneRecordings.profile_id, profileIds));
    await db.delete(phoneCalls).where(inArray(phoneCalls.profile_id, profileIds));
    await db.delete(phoneSettings).where(inArray(phoneSettings.profile_id, profileIds));
    await db.delete(supportSettings).where(inArray(supportSettings.profile_id, profileIds));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, profileIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

const post = (req: Request) => POST(new NextRequest(req));

async function recordedCall() {
  const callSid = fakeCallSid();
  await handleVoice("start", callParams({ callSid, to: number }));
  const recordingSid = fakeRecordingSid();
  api.add(recordingSid);
  return { params: recordingParams({ callSid, recordingSid }), recordingSid };
}

const rows = () =>
  db.select().from(phoneRecordings).where(eq(phoneRecordings.profile_id, profileId));

describe("POST /api/phone/recording", () => {
  it("a signed callback stores the recording and deletes Twilio's copy", async () => {
    const { params, recordingSid } = await recordedCall();
    const res = await post(twilioRequest({ url: URL_, params }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "stored" });
    expect((await rows())[0]).toMatchObject({ status: "stored", at_twilio: false });
    expect(api.has(recordingSid)).toBe(false);
  });

  it("refuses an unsigned callback, and acts on nothing", async () => {
    const { params, recordingSid } = await recordedCall();
    const res = await post(twilioRequest({ url: URL_, params, signature: null }));
    expect(res.status).toBe(403);
    expect(await rows()).toEqual([]);
    expect(api.requests).toEqual([]);
    expect(api.has(recordingSid)).toBe(true);
  });

  it("refuses one signed with another token, tampered, or signed for another address", async () => {
    const { params } = await recordedCall();
    expect((await post(twilioRequest({ url: URL_, params, authToken: "x" }))).status).toBe(403);
    const signed = twilioRequest({ url: URL_, params });
    const tampered = new Request(URL_, {
      method: "POST",
      headers: signed.headers,
      body: new URLSearchParams({ ...params, RecordingDuration: "9999" }).toString(),
    });
    expect((await post(tampered)).status).toBe(403);
    const voice = twilioRequest({ url: "https://syb.example/api/phone/voice", params });
    const moved = new Request(URL_, {
      method: "POST",
      headers: voice.headers,
      body: await voice.text(),
    });
    expect((await post(moved)).status).toBe(403);
    expect(await rows()).toEqual([]);
    expect(api.requests).toEqual([]);
  });

  it("refuses a signed callback naming another Twilio account", async () => {
    const { params } = await recordedCall();
    const other = { ...params, AccountSid: `AC${"b2".repeat(16)}` };
    expect((await post(twilioRequest({ url: URL_, params: other }))).status).toBe(403);
    expect(api.requests).toEqual([]);
  });

  it("refuses everything when the server has no Twilio settings", async () => {
    const { params } = await recordedCall();
    delete process.env.TWILIO_AUTH_TOKEN;
    expect((await post(twilioRequest({ url: URL_, params }))).status).toBe(503);
    expect(api.requests).toEqual([]);
  });
});
