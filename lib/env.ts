// Fail-fast environment access. Import { env } from "@/lib/env" — never
// read process.env directly outside this file. Missing required variables
// throw at first access, not at the point of use three modules later.

type RequiredKey = "DATABASE_URL" | "ANTHROPIC_API_KEY";

function read(key: RequiredKey): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new Error(
      `Missing required environment variable ${key} — copy .env.example to .env and fill it in`,
    );
  }
  return value;
}

// Lazy per-key access so code paths that never touch the Anthropic API
// (everything before Session L) don't demand the key at import time.
export const env: Record<RequiredKey, string> = {
  get DATABASE_URL() {
    return read("DATABASE_URL");
  },
  get ANTHROPIC_API_KEY() {
    return read("ANTHROPIC_API_KEY");
  },
};
