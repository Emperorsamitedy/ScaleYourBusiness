// P6-02: the phone webhook refuses what it can't verify — no Twilio
// settings, no signature, a bad one, another account's — before a single
// parameter is acted on, and answers a signed call with TwiML. Built on the
// fake Twilio (lib/phone/fake-twilio): no phone call, no network.

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
  phoneSettings,
  supportSettings,
} from "../../../../db/schema";
import { ensureSupportSettings } from "../../../../lib/crm/support-settings";
import { bootstrapIntake } from "../../../../lib/intake/service";
import {
  FAKE_ACCOUNT_SID,
  FAKE_AUTH_TOKEN,
  callParams,
  fakeCallSid,
  fakeNumber,
  twilioRequest,
} from "../../../../lib/phone/fake-twilio";
import { POST } from "./route";

const BASE = "https://syb.example/api/phone/voice";
const created: { account_id: string; profile_id: string }[] = [];
const KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "APP_URL"] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

let number = "";

beforeEach(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  number = fakeNumber();
  process.env.TWILIO_ACCOUNT_SID = FAKE_ACCOUNT_SID;
  process.env.TWILIO_AUTH_TOKEN = FAKE_AUTH_TOKEN;
  process.env.TWILIO_PHONE_NUMBER = number;
  process.env.APP_URL = "https://syb.example";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const s = await bootstrapIntake();
  created.push(s);
  await ensureSupportSettings(s.profile_id);
  await db.insert(phoneSettings).values({
    profile_id: s.profile_id,
    account_id: s.account_id,
    phone_number: number,
  });
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

afterAll(async () => {
  const profileIds = created.map((s) => s.profile_id);
  if (profileIds.length > 0) {
    await db.delete(phoneCalls).where(inArray(phoneCalls.profile_id, profileIds));
    await db.delete(phoneSettings).where(inArray(phoneSettings.profile_id, profileIds));
    await db.delete(supportSettings).where(inArray(supportSettings.profile_id, profileIds));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, profileIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

function post(req: Request) {
  return POST(new NextRequest(req));
}

async function rowsFor(sid: string) {
  return db.select().from(phoneCalls).where(eq(phoneCalls.call_sid, sid));
}

describe("POST /api/phone/voice", () => {
  it("answers a signed call with TwiML: the disclosure, the notice, then listening", async () => {
    const sid = fakeCallSid();
    const res = await post(
      twilioRequest({ url: BASE, params: callParams({ callSid: sid, to: number }) }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/xml/);
    const xml = await res.text();
    expect(xml).toMatch(/automated assistant, not a person/);
    expect(xml).toContain('<Gather input="speech"');
    expect(await rowsFor(sid)).toHaveLength(1);
  });

  it("follows a step in the query, which the signature covers", async () => {
    const sid = fakeCallSid();
    await post(twilioRequest({ url: BASE, params: callParams({ callSid: sid, to: number }) }));
    const url = `${BASE}?step=status`;
    const params = callParams({
      callSid: sid,
      to: number,
      CallStatus: "completed",
      CallDuration: "12",
    });
    const res = await post(twilioRequest({ url, params }));
    expect(res.status).toBe(200);
    expect((await rowsFor(sid))[0]?.duration_seconds).toBe(12);
    // The same body signed for the bare URL is not a signature for ?step=status.
    const wrong = twilioRequest({ url: BASE, params });
    const moved = new Request(url, {
      method: "POST",
      headers: wrong.headers,
      body: await wrong.text(),
    });
    expect((await post(moved)).status).toBe(403);
  });

  it("refuses an unsigned request, and keeps nothing", async () => {
    const sid = fakeCallSid();
    const res = await post(
      twilioRequest({
        url: BASE,
        params: callParams({ callSid: sid, to: number }),
        signature: null,
      }),
    );
    expect(res.status).toBe(403);
    expect(await rowsFor(sid)).toEqual([]);
  });

  it("refuses a request signed with another token, or tampered after signing", async () => {
    const sid = fakeCallSid();
    const params = callParams({ callSid: sid, to: number });
    expect((await post(twilioRequest({ url: BASE, params, authToken: "not-ours" }))).status).toBe(
      403,
    );
    const signed = twilioRequest({ url: BASE, params });
    const tampered = new Request(BASE, {
      method: "POST",
      headers: signed.headers,
      body: new URLSearchParams({ ...params, From: "+15550000000" }).toString(),
    });
    expect((await post(tampered)).status).toBe(403);
    expect(await rowsFor(sid)).toEqual([]);
  });

  it("refuses a correctly signed request that names another Twilio account", async () => {
    const sid = fakeCallSid();
    const params = {
      ...callParams({ callSid: sid, to: number }),
      AccountSid: `AC${"b2".repeat(16)}`,
    };
    expect((await post(twilioRequest({ url: BASE, params }))).status).toBe(403);
    expect(await rowsFor(sid)).toEqual([]);
  });

  it("refuses everything when the server has no Twilio settings", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const sid = fakeCallSid();
    const res = await post(
      twilioRequest({ url: BASE, params: callParams({ callSid: sid, to: number }) }),
    );
    expect(res.status).toBe(503);
    expect(await rowsFor(sid)).toEqual([]);
  });

  it("refuses a step it doesn't know", async () => {
    const url = `${BASE}?step=record`;
    const res = await post(
      twilioRequest({ url, params: callParams({ callSid: fakeCallSid(), to: number }) }),
    );
    expect(res.status).toBe(404);
  });
});
