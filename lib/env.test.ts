import { afterEach, describe, expect, it } from "vitest";
import { env } from "./env";

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
