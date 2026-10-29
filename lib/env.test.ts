import { afterEach, describe, expect, it } from "vitest";
import { env, pushServiceSetting, vapidEnv } from "./env";

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
