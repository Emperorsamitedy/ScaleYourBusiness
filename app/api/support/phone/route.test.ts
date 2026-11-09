// Decision 2 (owner, 2026-11-09): least privilege on calls. GET
// /api/support/phone serves what callers said — transcripts, messages and
// full numbers — only to a role that may "phone.transcripts" (owners and
// managers, who answer support). A viewer gets the calls list with the
// number masked to its last three digits and no message, and a transcript
// is refused. The anonymous interview is its business's only person, so it
// reads as the owner. The session lookup is stubbed (it reads request
// cookies); the business, the call and its transcript are real rows.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../../../db";
import {
  accounts,
  businessProfiles,
  intakeEvents,
  phoneCallTurns,
  phoneCalls,
  phoneSettings,
  supportSettings,
} from "../../../../db/schema";
import type { Access } from "../../../../lib/auth/access";
import type { Role } from "../../../../lib/auth/role-actions";
import type { AuthedSession } from "../../../../lib/auth/service";
import { ensureSupportSettings } from "../../../../lib/crm/support-settings";
import { bootstrapIntake } from "../../../../lib/intake/service";
import { callsForViewer, maskCallerNumber } from "../../../../lib/phone-desk/desk";
import { fakeCallSid, fakeNumber } from "../../../../lib/phone/fake-twilio";

const resolveAccess = vi.fn<() => Promise<Access | null>>(async () => null);
const matchingSession = vi.fn<() => Promise<AuthedSession | null>>(async () => null);
vi.mock("../../../../lib/auth/access", () => ({ resolveAccess, matchingSession }));

const { GET } = await import("./route");

const created: { account_id: string; profile_id: string }[] = [];
const CALLER = "+447700900123";
const MESSAGE = "This is Rosa, please call me back about the cake order.";
const SAID = "Do you have gluten-free bread?";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
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

/** A business with one call that left a message and said something. */
async function withCall() {
  const s = await bootstrapIntake();
  created.push(s);
  await ensureSupportSettings(s.profile_id);
  await db.insert(phoneSettings).values({
    profile_id: s.profile_id,
    account_id: s.account_id,
    phone_number: fakeNumber(),
  });
  const now = new Date().toISOString();
  const [call] = await db
    .insert(phoneCalls)
    .values({
      profile_id: s.profile_id,
      account_id: s.account_id,
      call_sid: fakeCallSid(),
      caller_number: CALLER,
      language: "en",
      notice_at: now,
      outcome: "message",
      message: MESSAGE,
      turns: 1,
      ended_at: now,
    })
    .returning();
  await db.insert(phoneCallTurns).values({ call_id: call!.id, role: "caller", text: SAID });
  return { ...s, call: call! };
}

function as(b: { account_id: string; profile_id: string }, role: Role) {
  const session = {
    account_id: b.account_id,
    profile_id: b.profile_id,
    user_id: "00000000-0000-4000-8000-000000000003",
    email: "someone@example.test",
    role,
  } as AuthedSession;
  resolveAccess.mockResolvedValueOnce({ ...b, owned: true, session } as Access);
  matchingSession.mockResolvedValueOnce(session);
}

const list = () => GET(new NextRequest("http://localhost/api/support/phone"));
const transcript = (callId: string) =>
  GET(new NextRequest(`http://localhost/api/support/phone?call=${callId}`));

interface Listed {
  can_read: boolean;
  recording: { can_play: boolean };
  calls: { id: string; caller_number: string | null; message: string | null; outcome: string }[];
}

describe("GET /api/support/phone — what callers said, for owners and managers only", () => {
  for (const role of ["owner", "manager"] as const) {
    it(`a ${role} reads the full number, the message and the transcript`, async () => {
      const b = await withCall();
      as(b, role);
      const res = await list();
      expect(res.status).toBe(200);
      const json = (await res.json()) as Listed;
      expect(json.can_read).toBe(true);
      expect(json.calls).toHaveLength(1);
      expect(json.calls[0]).toMatchObject({ caller_number: CALLER, message: MESSAGE });
      // Recordings stay the owner's alone.
      expect(json.recording.can_play).toBe(role === "owner");

      as(b, role);
      const read = await transcript(b.call.id);
      expect(read.status).toBe(200);
      const turns = (await read.json()) as { turns: { text: string }[] };
      expect(turns.turns.map((t) => t.text)).toEqual([SAID]);
    });
  }

  it("a viewer sees the calls list with the number masked, and no message", async () => {
    const b = await withCall();
    as(b, "viewer");
    const res = await list();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Listed;
    expect(json.can_read).toBe(false);
    expect(json.recording.can_play).toBe(false);
    expect(json.calls).toHaveLength(1);
    expect(json.calls[0]).toMatchObject({
      id: b.call.id,
      outcome: "message",
      caller_number: "•••123",
      message: null,
    });
    const body = JSON.stringify(json);
    expect(body).not.toContain(CALLER);
    expect(body).not.toContain("7700900");
    expect(body).not.toContain(MESSAGE);
  });

  it("a viewer is refused the transcript, with nothing said in the refusal", async () => {
    const b = await withCall();
    as(b, "viewer");
    const res = await transcript(b.call.id);
    expect(res.status).toBe(403);
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["error", "needs", "role"]);
    expect(json.needs).toBe("manager");
    expect(JSON.stringify(json)).not.toContain(SAID);
  });

  it("the anonymous interview is its business's only person: it reads as the owner, but can't play", async () => {
    const b = await withCall();
    resolveAccess.mockResolvedValueOnce({ ...b, owned: false, session: null } as Access);
    const json = (await (await list()).json()) as Listed;
    expect(json.can_read).toBe(true);
    expect(json.calls[0]?.message).toBe(MESSAGE);
    expect(json.recording.can_play).toBe(false);
  });

  it("refuses without an intake session", async () => {
    const b = await withCall();
    resolveAccess.mockResolvedValueOnce(null);
    expect((await list()).status).toBe(401);
    resolveAccess.mockResolvedValueOnce(null);
    expect((await transcript(b.call.id)).status).toBe(401);
  });
});

describe("the mask a viewer reads", () => {
  it("keeps the last three digits only, and a withheld number withheld", () => {
    expect(maskCallerNumber("+447700900123")).toBe("•••123");
    expect(maskCallerNumber("+44 7700 900 456")).toBe("•••456");
    expect(maskCallerNumber(null)).toBeNull();
    // Three digits or fewer: none of them shown (the failing case for a leak).
    expect(maskCallerNumber("123")).toBe("•••");
  });

  it("drops the message and masks the number, leaving the rest as it was", () => {
    const call = {
      id: "c",
      caller_number: "+447700900789",
      outcome: "message" as const,
      live: false,
      message: "call me",
      turns: 2,
      duration_seconds: 40,
      cost_eur: "0.001",
      started_at: "2026-11-09T10:00:00Z",
      recorded: false,
      recording: null,
    };
    expect(callsForViewer([call])).toEqual([{ ...call, caller_number: "•••789", message: null }]);
  });
});
