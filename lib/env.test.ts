import { afterEach, describe, expect, it } from "vitest";
import {
  env,
  googleAdsMissing,
  higgsfieldEnv,
  mediaProviderSetting,
  pushServiceSetting,
  sessionDRealWritesOn,
  tiktokAdsMissing,
  twilioMissing,
  vapidEnv,
  whatsappMissing,
} from "./env";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe("env", () => {
  it("returns the value when the variable is set", () => {
    process.env.DATABASE_URL = "postgresql://example";
    expect(env.DATABASE_URL).toBe("postgresql://example");
  });

  it("throws on a missing variable, naming it", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => env.ANTHROPIC_API_KEY).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("throws on an empty string — a blank .env line is not a value", () => {
    process.env.ANTHROPIC_API_KEY = "";
    expect(() => env.ANTHROPIC_API_KEY).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("does not demand ANTHROPIC_API_KEY unless accessed", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.DATABASE_URL = "postgresql://example";
    // Touching DATABASE_URL alone must not throw about the Anthropic key:
    // nothing before Session L needs it.
    expect(env.DATABASE_URL).toBe("postgresql://example");
  });
});

describe("idea 53: phone alert settings", () => {
  it("offers VAPID keys only when all three are set", () => {
    process.env.VAPID_PUBLIC_KEY = " pub ";
    process.env.VAPID_PRIVATE_KEY = "priv";
    process.env.VAPID_SUBJECT = "mailto:o@example.com";
    expect(vapidEnv()).toEqual({
      publicKey: "pub",
      privateKey: "priv",
      subject: "mailto:o@example.com",
    });
    process.env.VAPID_SUBJECT = "";
    expect(vapidEnv()).toBeNull();
    delete process.env.VAPID_PRIVATE_KEY;
    expect(vapidEnv()).toBeNull();
  });

  it("uses the fake push service only when asked, and never in production", () => {
    delete process.env.PUSH_SERVICE;
    expect(pushServiceSetting()).toBe("real");
    process.env.PUSH_SERVICE = "FAKE";
    expect(pushServiceSetting()).toBe("fake");
    Object.assign(process.env, { NODE_ENV: "production" });
    expect(pushServiceSetting()).toBe("real");
  });
});

describe("an env handed in, as /ops hands one (lib/ops/readiness.ts)", () => {
  it("reads the env it is handed, not process.env", () => {
    process.env.TWILIO_PHONE_NUMBER = "+447700900123";
    process.env.SESSION_D_REAL_WRITES = "on";
    process.env.MEDIA_PROVIDER = "higgsfield";
    const handed = {
      TWILIO_ACCOUNT_SID: `AC${"ab".repeat(16)}`,
      TWILIO_AUTH_TOKEN: "t",
    };
    expect(twilioMissing(handed)).toEqual(["TWILIO_PHONE_NUMBER"]);
    expect(whatsappMissing(handed)).toEqual([
      "TWILIO_WHATSAPP_FROM",
      "TWILIO_WHATSAPP_SUMMARY_TEMPLATES",
    ]);
    expect(sessionDRealWritesOn({})).toBe(false);
    expect(sessionDRealWritesOn()).toBe(true);
    expect(mediaProviderSetting({})).toBe("off");
    expect(mediaProviderSetting({ MEDIA_PROVIDER: "fake", NODE_ENV: "production" })).toBe("off");
    expect(mediaProviderSetting({ MEDIA_PROVIDER: "fake", NODE_ENV: "test" })).toBe("fake");
    expect(higgsfieldEnv({ HIGGSFIELD_API_KEY: "id:secret" }).key).toEqual({
      id: "id",
      secret: "secret",
    });
    expect(googleAdsMissing({ GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" })).toEqual([
      "GOOGLE_ADS_ACCESS_LEVEL",
    ]);
    expect(tiktokAdsMissing({ TIKTOK_ADS_APP_ID: "a" })).toEqual([
      "TIKTOK_ADS_SECRET",
      "TIKTOK_ADS_REDIRECT_URI",
    ]);
  });
});
