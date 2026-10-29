// Idea 53 (I-53.3): one alert is one request — encrypted, signed, sent
// once with a 10-second timeout. The network is a stub; nothing leaves.

import { createDecipheriv, createECDH, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PushFetch, PushPayload } from "./send";
import { PUSH_TIMEOUT_MS, fakePushService, pushConfig, webPushService } from "./send";
import type { PushTarget } from "./endpoints";
import { b64url, deriveKeys, fromB64url, generateVapidKeys, verifyVapidJwt } from "./webpush";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.useRealTimers();
});

function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const target: PushTarget = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc:def",
    p256dh: b64url(ecdh.getPublicKey()),
    auth: b64url(auth),
  };
  const read = (body: Buffer) => {
    const asPublic = body.subarray(21, 86);
    const keys = deriveKeys({
      ecdhSecret: ecdh.computeSecret(asPublic),
      authSecret: auth,
      uaPublic: ecdh.getPublicKey(),
      asPublic,
      salt: body.subarray(0, 16),
    });
    const ct = body.subarray(86);
    const d = createDecipheriv("aes-128-gcm", keys.cek, keys.nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    return JSON.parse(plain.subarray(0, -1).toString()) as PushPayload;
  };
  return { target, read };
}

const PAYLOAD: PushPayload = {
  title: "SYB",
  body: "1 thing waits for your yes: a post",
  url: "/proposals/0f8fad5b-d9cb-469f-a165-70867728950e",
  tag: "syb-waiting",
};

const vapid = () => ({ ...generateVapidKeys(), subject: "mailto:ops@syb.example" });

function stub(status: number) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: PushFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status });
  };
  return { calls, fetchImpl };
}

describe("webPushService", () => {
  it("POSTs once to the endpoint, encrypted for the browser and signed with VAPID", async () => {
    const keys = vapid();
    const { target, read } = browser();
    const { calls, fetchImpl } = stub(201);
    const out = await webPushService({ vapid: keys, fetchImpl }).deliver(target, PAYLOAD);
    expect(out).toEqual({ kind: "sent", status: 201 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(target.endpoint);
    const h = call?.init.headers as Record<string, string>;
    expect(call?.init.method).toBe("POST");
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(Number(h.TTL)).toBeGreaterThan(0);
    expect(h.Urgency).toBe("normal");
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(h.Authorization ?? "");
    expect(m?.[2]).toBe(keys.publicKey);
    expect(verifyVapidJwt(m?.[1] ?? "", keys.publicKey)).toBe(true);
    const claims = JSON.parse(fromB64url((m?.[1] ?? "").split(".")[1] ?? "").toString());
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:ops@syb.example");
    expect(claims.exp - Date.now() / 1000).toBeLessThanOrEqual(24 * 3600);
    // The push service sees ciphertext; the browser reads the payload.
    const body = Buffer.from(call?.init.body as Uint8Array);
    expect(body.toString("latin1")).not.toContain("waits for your yes");
    expect(read(body)).toEqual(PAYLOAD);
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reuses one JWT per push service rather than signing every send", async () => {
    const { target } = browser();
    const { calls, fetchImpl } = stub(201);
    const svc = webPushService({ vapid: vapid(), fetchImpl });
    await svc.deliver(target, PAYLOAD);
    await svc.deliver(target, PAYLOAD);
    const auth = calls.map((c) => (c.init.headers as Record<string, string>).Authorization);
    expect(auth[0]).toBe(auth[1]);
  });

  it("reads 404 and 410 as a subscription that is gone", async () => {
    for (const status of [404, 410] as const) {
      const { fetchImpl } = stub(status);
      const out = await webPushService({ vapid: vapid(), fetchImpl }).deliver(
        browser().target,
        PAYLOAD,
      );
      expect(out).toEqual({ kind: "gone", status });
    }
  });

  it("reads any other refusal as failed, once, with no retry", async () => {
    for (const status of [400, 403, 413, 429, 500, 503]) {
      const { calls, fetchImpl } = stub(status);
      const out = await webPushService({ vapid: vapid(), fetchImpl }).deliver(
        browser().target,
        PAYLOAD,
      );
      expect(out).toMatchObject({ kind: "failed", status });
      expect(calls).toHaveLength(1);
    }
  });

  it("gives up after 10 seconds without an answer", async () => {
    expect(PUSH_TIMEOUT_MS).toBe(10_000);
    let attempts = 0;
    const fetchImpl: PushFetch = (_url, init) => {
      attempts += 1;
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
        );
      });
    };
    vi.useFakeTimers();
    const pending = webPushService({ vapid: vapid(), fetchImpl }).deliver(
      browser().target,
      PAYLOAD,
    );
    await vi.advanceTimersByTimeAsync(PUSH_TIMEOUT_MS + 1);
    expect(await pending).toEqual({
      kind: "failed",
      status: null,
      why: "no answer in 10 seconds",
    });
    expect(attempts).toBe(1);
  });

  it("never sends to an address that isn't a push service, even from a stored row", async () => {
    const { calls, fetchImpl } = stub(201);
    const svc = webPushService({ vapid: vapid(), fetchImpl });
    for (const endpoint of [
      "https://169.254.169.254/latest",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://push.syb.invalid/demo",
      "https://evil.example/push.apple.com",
    ]) {
      const out = await svc.deliver({ ...browser().target, endpoint }, PAYLOAD);
      expect(out).toEqual({ kind: "failed", status: null, why: "not a push service" });
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a subscription whose key isn't a P-256 point, without a request", async () => {
    const { calls, fetchImpl } = stub(201);
    const out = await webPushService({ vapid: vapid(), fetchImpl }).deliver(
      { ...browser().target, p256dh: b64url(Buffer.alloc(65, 4)) },
      PAYLOAD,
    );
    expect(out.kind).toBe("failed");
    expect(calls).toHaveLength(0);
  });
});

describe("the fake push service", () => {
  it("records what would be sent and contacts nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const fake = fakePushService();
    const out = await fake.deliver(
      { ...browser().target, endpoint: "https://push.syb.invalid/demo-1" },
      PAYLOAD,
    );
    expect(out).toEqual({ kind: "sent", status: 201 });
    expect(fake.sent).toEqual([expect.objectContaining({ payload: PAYLOAD })]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("answers 410 for an endpoint told to be gone", async () => {
    const t = browser().target;
    const fake = fakePushService({ gone: new Set([t.endpoint]) });
    expect(await fake.deliver(t, PAYLOAD)).toEqual({ kind: "gone", status: 410 });
    expect(fake.sent).toHaveLength(0);
  });
});

describe("pushConfig", () => {
  it("is off with no VAPID keys, and says so", () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    delete process.env.PUSH_SERVICE;
    expect(pushConfig()).toEqual({ ok: false, why: "the VAPID keys aren't set" });
  });

  it("is off with a pair that doesn't belong together", () => {
    const a = generateVapidKeys();
    process.env.VAPID_PUBLIC_KEY = a.publicKey;
    process.env.VAPID_PRIVATE_KEY = generateVapidKeys().privateKey;
    process.env.VAPID_SUBJECT = "mailto:ops@syb.example";
    delete process.env.PUSH_SERVICE;
    expect(pushConfig()).toEqual({ ok: false, why: "the VAPID keys aren't valid" });
  });

  it("sends for real with a valid pair, and hands the browser only the public key", () => {
    const a = generateVapidKeys();
    process.env.VAPID_PUBLIC_KEY = a.publicKey;
    process.env.VAPID_PRIVATE_KEY = a.privateKey;
    process.env.VAPID_SUBJECT = "mailto:ops@syb.example";
    delete process.env.PUSH_SERVICE;
    const cfg = pushConfig();
    expect(cfg.ok && cfg.service.name).toBe("web-push");
    expect(cfg.ok && cfg.publicKey).toBe(a.publicKey);
  });

  it("uses the fake when PUSH_SERVICE=fake, never in production", () => {
    process.env.PUSH_SERVICE = "fake";
    const dev = pushConfig();
    expect(dev.ok && dev.service.name).toBe("fake");
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.VAPID_PUBLIC_KEY;
    expect(pushConfig()).toEqual({ ok: false, why: "the VAPID keys aren't set" });
  });
});
