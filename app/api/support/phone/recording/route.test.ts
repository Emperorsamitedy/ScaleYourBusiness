// P6-08: a call recording plays for the OWNER only. No session, a manager
// and a viewer are each refused, and the refusal carries no audio; another
// business's call is not found; the owner gets the audio, no-store, and
// never its storage address. The session lookup is stubbed (it reads
// request cookies); the business, the call and the recording are real.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../../../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  intakeEvents,
  phoneCalls,
  phoneRecordings,
  phoneSettings,
  supportSettings,
} from "../../../../../db/schema";
import type { Access } from "../../../../../lib/auth/access";
import type { Role } from "../../../../../lib/auth/role-actions";
import type { AuthedSession } from "../../../../../lib/auth/service";
import { memoryMediaStore } from "../../../../../lib/content/media";
import { ensureSupportSettings } from "../../../../../lib/crm/support-settings";
import { bootstrapIntake } from "../../../../../lib/intake/service";
import {
  recordingCallback,
  setRecordingDepsForTests,
} from "../../../../../lib/phone-recording/recordings";
import {
  FAKE_ACCOUNT_SID,
  FAKE_AUTH_TOKEN,
  callParams,
  fakeCallSid,
  fakeNumber,
  fakeRecordingSid,
  fakeTwilioApi,
  recordingParams,
} from "../../../../../lib/phone/fake-twilio";
import { handleVoice } from "../../../../../lib/phone/line";
import { inPhoneCountry, switchPhoneCountryOn } from "../../../../../lib/phone/test-country";

// Hard rule 6 (architecture-v2 D6): these businesses are in a switched-on country.
let restoreCountries: () => Promise<void> | void = () => undefined;
beforeAll(async () => {
  restoreCountries = await switchPhoneCountryOn();
});
afterAll(() => restoreCountries());

const resolveAccess = vi.fn<() => Promise<Access | null>>(async () => null);
const matchingSession = vi.fn<() => Promise<AuthedSession | null>>(async () => null);
vi.mock("../../../../../lib/auth/access", () => ({ resolveAccess, matchingSession }));

const { GET } = await import("./route");

const created: { account_id: string; profile_id: string }[] = [];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  setRecordingDepsForTests(null);
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
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, profileIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

/** A business with one recorded call, stored in a memory store. */
async function recorded() {
  const s = await bootstrapIntake();
  await inPhoneCountry(s.profile_id);
  created.push(s);
  await ensureSupportSettings(s.profile_id);
  const number = fakeNumber();
  await db.insert(phoneSettings).values({
    profile_id: s.profile_id,
    account_id: s.account_id,
    phone_number: number,
    record_calls: true,
  });
  const api = fakeTwilioApi();
  const store = memoryMediaStore();
  setRecordingDepsForTests({
    fetch: api.fetch,
    store,
    twilio: { accountSid: FAKE_ACCOUNT_SID, authToken: FAKE_AUTH_TOKEN },
    key: () => Buffer.alloc(32, 9),
  });
  const callSid = fakeCallSid();
  await handleVoice("start", callParams({ callSid, to: number }));
  await handleVoice("consent", callParams({ callSid, to: number, Digits: "1" })); // §9.2: the caller agreed
  const recordingSid = fakeRecordingSid();
  const audio = api.add(recordingSid);
  expect(await recordingCallback(recordingParams({ callSid, recordingSid }))).toBe("stored");
  const [call] = await db.select().from(phoneCalls).where(eq(phoneCalls.call_sid, callSid));
  return { ...s, call: call!, audio, store };
}

function as(b: { account_id: string; profile_id: string }, role: Role) {
  const session = {
    account_id: b.account_id,
    profile_id: b.profile_id,
    user_id: "00000000-0000-4000-8000-000000000002",
    email: "someone@example.test",
    role,
  } as AuthedSession;
  resolveAccess.mockResolvedValueOnce({ ...b, owned: true, session } as Access);
  matchingSession.mockResolvedValueOnce(session);
}

const get = (callId: string) =>
  GET(new NextRequest(`http://localhost/api/support/phone/recording?call=${callId}`));

describe("GET /api/support/phone/recording — the owner's ears only", () => {
  it("plays the recording to the owner, no-store, without its storage address", async () => {
    const b = await recorded();
    as(b, "owner");
    const res = await get(b.call.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(Buffer.from(b.audio));
    for (const url of b.store.urls()) {
      expect(JSON.stringify([...res.headers])).not.toContain(url);
    }
  });

  for (const role of ["manager", "viewer"] as const) {
    it(`refuses a ${role}, with no audio in the refusal`, async () => {
      const b = await recorded();
      as(b, role);
      const res = await get(b.call.id);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toMatch(/json/);
      const json = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(json).sort()).toEqual(["error", "needs", "role"]);
      expect(json.needs).toBe("owner");
    });
  }

  it("refuses without an intake session, and without a signed-in person", async () => {
    const b = await recorded();
    resolveAccess.mockResolvedValueOnce(null);
    expect((await get(b.call.id)).status).toBe(401);
    resolveAccess.mockResolvedValueOnce({ ...b, owned: true, session: null } as Access);
    matchingSession.mockResolvedValueOnce(null);
    expect((await get(b.call.id)).status).toBe(401);
  });

  it("finds no recording for another business's call, or a malformed id", async () => {
    const mine = await recorded();
    const theirs = await recorded();
    as(mine, "owner");
    expect((await get(theirs.call.id)).status).toBe(404);
    as(mine, "owner");
    expect((await get("not-a-uuid")).status).toBe(404);
  });
});
