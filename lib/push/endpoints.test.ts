// Idea 53 (I-53.2): the device label, the push-service allowlist and the
// shape of a browser's subscription. Pure.

import { describe, expect, it } from "vitest";
import { deviceLabel, isPushEndpoint, parseSubscription } from "./endpoints";

const P256DH =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const sub = (endpoint: string, keys: Record<string, string> = { p256dh: P256DH, auth: AUTH }) => ({
  endpoint,
  expirationTime: null,
  keys,
});

describe("deviceLabel", () => {
  it("names the device coarsely, never the agent string", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("iPhone");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129.0 Mobile")).toBe(
      "Android",
    );
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Safari/605.1.15")).toBe("Mac");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/129.0")).toBe("Windows");
    expect(deviceLabel("Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X)")).toBe("iPad");
  });

  it("falls back to 'Browser' for anything it can't place", () => {
    expect(deviceLabel(null)).toBe("Browser");
    expect(deviceLabel("curl/8.0")).toBe("Browser");
  });
});

describe("isPushEndpoint", () => {
  it("takes the browsers' own push services", () => {
    for (const url of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://web.push.apple.com/QOk-xyz",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
    ]) {
      expect(isPushEndpoint(url)).toBe(true);
    }
  });

  it("refuses anything else: other hosts, http, ports, credentials, lookalikes", () => {
    for (const url of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://push.apple.com.evil.example/x",
      "https://evilpush.apple.com.example/x",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "not a url",
    ]) {
      expect(isPushEndpoint(url)).toBe(false);
    }
  });

  it("takes the demo's fake host only when asked", () => {
    expect(isPushEndpoint("https://push.syb.invalid/demo-1")).toBe(false);
    expect(isPushEndpoint("https://push.syb.invalid/demo-1", { allowFake: true })).toBe(true);
  });
});

describe("parseSubscription", () => {
  it("accepts a browser's PushSubscription.toJSON()", () => {
    expect(parseSubscription(sub("https://web.push.apple.com/QOk-x"))).toEqual({
      endpoint: "https://web.push.apple.com/QOk-x",
      p256dh: P256DH,
      auth: AUTH,
    });
  });

  it("refuses a missing or foreign endpoint and keys of the wrong size", () => {
    expect(parseSubscription(null)).toMatch(/missing/);
    expect(parseSubscription({ keys: {} })).toMatch(/endpoint/);
    expect(parseSubscription(sub("https://evil.example/x"))).toMatch(/push service/);
    expect(
      parseSubscription(sub("https://web.push.apple.com/x", { p256dh: P256DH, auth: "AAAA" })),
    ).toMatch(/size/);
    expect(parseSubscription(sub("https://web.push.apple.com/x", { auth: AUTH }))).toMatch(/keys/);
    expect(
      parseSubscription(sub("https://web.push.apple.com/x", { p256dh: "<script>", auth: AUTH })),
    ).toMatch(/keys/);
  });
});
