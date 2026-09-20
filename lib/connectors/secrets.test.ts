// P2-03 / rule 10 — "Connection secrets are encrypted at rest."
//
// The requirement in the plan is specific: a row read WITHOUT the key must
// be noise, and secrets must never appear in logs or API responses. The
// first two tests prove the first half directly; the API half is proven in
// service.test.ts, where the public shape is asserted to have no secret.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { REDACTED, SecretError, decryptSecret, encryptSecret, parseKey } from "./secrets";

const KEY_A = parseKey("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const KEY_B = parseKey(randomBytes(32).toString("base64"));
const SECRET = "sk_test_51ABCdefGHIjklMNOpqrsTUVwxyz";

describe("P2-03 — secrets at rest", () => {
  it("round-trips a secret", () => {
    expect(decryptSecret(encryptSecret(SECRET, KEY_A), KEY_A)).toBe(SECRET);
  });

  it("a stored row is noise without the key", () => {
    const blob = encryptSecret(SECRET, KEY_A);
    // Nothing recognisable survives: not the secret, not a prefix of it.
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain("sk_test");
    expect(blob).not.toContain(SECRET.slice(0, 8));
    expect(() => decryptSecret(blob, KEY_B)).toThrow(SecretError);
  });

  it("the same secret encrypts differently every time (fresh IV)", () => {
    const first = encryptSecret(SECRET, KEY_A);
    const second = encryptSecret(SECRET, KEY_A);
    expect(first).not.toBe(second);
    expect(decryptSecret(first, KEY_A)).toBe(decryptSecret(second, KEY_A));
  });

  it("detects tampering with the ciphertext", () => {
    const parts = encryptSecret(SECRET, KEY_A).split(":");
    const ct = Buffer.from(parts[3] as string, "base64");
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    parts[3] = ct.toString("base64");
    expect(() => decryptSecret(parts.join(":"), KEY_A)).toThrow(SecretError);
  });

  it("detects tampering with the auth tag", () => {
    const parts = encryptSecret(SECRET, KEY_A).split(":");
    const tag = Buffer.from(parts[2] as string, "base64");
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    parts[2] = tag.toString("base64");
    expect(() => decryptSecret(parts.join(":"), KEY_A)).toThrow(SecretError);
  });

  it("refuses malformed blobs rather than guessing", () => {
    for (const blob of ["", "nonsense", "v1:only:three", "v2:a:b:c", `v1:${"a"}:${"b"}:${"c"}`]) {
      expect(() => decryptSecret(blob, KEY_A), blob).toThrow(SecretError);
    }
  });

  it("the failure message never reveals which half was wrong", () => {
    // Wrong key and tampered payload must look identical to an attacker.
    const blob = encryptSecret(SECRET, KEY_A);
    let wrongKeyMessage = "";
    try {
      decryptSecret(blob, KEY_B);
    } catch (error) {
      wrongKeyMessage = (error as Error).message;
    }
    expect(wrongKeyMessage).toBe("secret cannot be decrypted with this key");
    expect(wrongKeyMessage).not.toContain(SECRET);
  });

  it("refuses an empty secret", () => {
    expect(() => encryptSecret("", KEY_A)).toThrow(SecretError);
  });
});

describe("P2-03 — key material", () => {
  it("accepts 32 bytes as hex or base64", () => {
    expect(parseKey("ab".repeat(32))).toHaveLength(32);
    expect(parseKey(randomBytes(32).toString("base64"))).toHaveLength(32);
  });

  it("refuses a key that is not 32 bytes — a truncated key is a weaker cipher", () => {
    expect(() => parseKey("tooshort")).toThrow(SecretError);
    expect(() => parseKey(randomBytes(16).toString("base64"))).toThrow(SecretError);
    expect(() => parseKey(randomBytes(64).toString("base64"))).toThrow(SecretError);
  });

  it("the error says how to generate a correct one", () => {
    expect(() => parseKey("nope")).toThrow(/randomBytes\(32\)/);
  });

  it("exports a redaction constant for log sites", () => {
    expect(REDACTED).toBe("[redacted]");
  });
});
