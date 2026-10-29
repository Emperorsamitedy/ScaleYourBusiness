// Idea 53 (I-53.2): the Phone alerts API — same-origin POSTs, a signed-in
// owner only, and nothing secret in any answer. The door and the store are
// stand-ins, so this pins the route's own rules.

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateVapidKeys } from "../../../lib/push/webpush";

const session: {
  account_id: string;
  user_id: string;
  email: string;
  profile_id: string;
  session_id: string;
  role: "owner" | "manager" | "viewer";
} = {
  account_id: "acc-1",
  user_id: "user-1",
  email: "o@x",
  profile_id: "p-1",
  session_id: "sess-1",
  role: "owner",
};
let signedIn = true;

vi.mock("../../../lib/auth/access", () => ({
  resolveAccess: async () =>
    signedIn ? { profile_id: "p-1", account_id: "acc-1", owned: true, session } : null,
  matchingSession: async () => (signedIn ? session : null),
}));

const saveSubscription = vi.fn(async () => ({ id: "dev-1", device_label: "iPhone" }));
const removeDevice = vi.fn(async () => true);
vi.mock("../../../lib/push/subscriptions", async () => {
  const pure = await import("../../../lib/push/endpoints");
  return {
    ...pure,
    saveSubscription: (...a: unknown[]) => saveSubscription(...(a as [])),
    removeDevice: (...a: unknown[]) => removeDevice(...(a as [])),
    listDevices: async () => [
      {
        id: "dev-1",
        label: "iPhone",
        created_at: "2026-10-29T10:00:00Z",
        last_sent_at: null,
        this_browser: true,
      },
    ],
  };
});
const sendTestPush = vi.fn(async () => [
  { id: "dev-1", label: "iPhone", outcome: { kind: "sent", status: 201 } },
]);
vi.mock("../../../lib/push/deliver", () => ({
  sendTestPush: (...a: unknown[]) => sendTestPush(...(a as [])),
}));

const saved = { ...process.env };
const keys = generateVapidKeys();
beforeEach(() => {
  signedIn = true;
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = "mailto:ops@syb.example";
  delete process.env.PUSH_SERVICE;
  delete process.env.APP_URL;
  saveSubscription.mockClear();
  removeDevice.mockClear();
  sendTestPush.mockClear();
});
afterEach(() => {
  process.env = { ...saved };
});

const SUB = {
  endpoint: "https://web.push.apple.com/QOk-abc",
  keys: {
    p256dh:
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  },
};

function post(body: unknown, site: string = "same-origin") {
  return new NextRequest("http://localhost/api/push", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": site, "user-agent": "iPhone" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/push", () => {
  it("gives a signed-in owner the public key and the devices, never an endpoint", async () => {
    const { GET } = await import("./route");
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ signed_in: true, configured: true, public_key: keys.publicKey });
    expect(JSON.stringify(body)).not.toContain(keys.privateKey);
    expect(JSON.stringify(body)).not.toContain("push.apple.com");
  });

  it("says not configured when the VAPID keys aren't set", async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    const { GET } = await import("./route");
    const body = (await (await GET()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ configured: false, public_key: null });
  });

  it("shows no devices to a browser that isn't signed in", async () => {
    signedIn = false;
    const { GET } = await import("./route");
    const body = (await (await GET()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ signed_in: false, devices: [] });
  });
});

describe("POST /api/push", () => {
  it("switches a device on for the signed-in owner, tied to this sign-in", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      post({ action: "subscribe", subscription: SUB, time_zone: "Europe/Budapest" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ on: true, device_label: "iPhone" });
    expect(saveSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-1", userId: "user-1", sessionId: "sess-1" }),
    );
  });

  it("refuses a request from another site", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ action: "subscribe", subscription: SUB }, "cross-site"));
    expect(res.status).toBe(403);
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it("refuses a browser that isn't signed in", async () => {
    signedIn = false;
    const { POST } = await import("./route");
    const res = await POST(post({ action: "subscribe", subscription: SUB }));
    expect(res.status).toBe(401);
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it("refuses an endpoint that isn't a browser push service", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      post({ action: "subscribe", subscription: { ...SUB, endpoint: "https://169.254.169.254/" } }),
    );
    expect(res.status).toBe(422);
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it("switches nothing on when the server can't send", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const { POST } = await import("./route");
    const res = await POST(post({ action: "subscribe", subscription: SUB }));
    expect(res.status).toBe(409);
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it("removes a device by id, within the owner's account", async () => {
    const { POST } = await import("./route");
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect((await POST(post({ action: "remove", id }))).status).toBe(200);
    // Idea 52: only this person's own device.
    expect(removeDevice).toHaveBeenCalledWith("acc-1", id, "user-1");
    expect((await POST(post({ action: "remove", id: "x" }))).status).toBe(422);
  });

  it("idea 52: a viewer can't switch alerts on or send a test, but can remove their own phone", async () => {
    const { POST } = await import("./route");
    session.role = "viewer";
    try {
      const on = await POST(post({ action: "subscribe", subscription: {} }));
      expect(on.status).toBe(403);
      expect((await on.json()).error).toBe(
        "Only an owner or a manager can get phone alerts for proposals.",
      );
      expect((await POST(post({ action: "test" }))).status).toBe(403);
      const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
      expect((await POST(post({ action: "remove", id }))).status).toBe(200);
    } finally {
      session.role = "owner";
    }
  });

  it("sends a test and says how each device took it", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ action: "test" }));
    expect(await res.json()).toEqual({
      results: [{ label: "iPhone", result: "sent", words: "sent" }],
    });
  });
});
