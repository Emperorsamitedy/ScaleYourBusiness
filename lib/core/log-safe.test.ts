// The security review of 2026-10-17: a logged query error must never carry
// its bound values (emails, chat text) — rule 22, logs hold ids only.

import { describe, expect, it } from "vitest";
import { logSafeError } from "./log-safe";

describe("logSafeError", () => {
  it("THE LEAK: a Drizzle query error's params never reach the log, and the driver's own message does", () => {
    const cause = Object.assign(
      new Error('duplicate key value violates unique constraint "contacts_account_email_idx"'),
      {
        code: "23505",
      },
    );
    const error = Object.assign(
      new Error(
        'Failed query: insert into "contacts" ("email","name") values ($1, $2)\nparams: erin@example.com,Erin Erasable',
      ),
      { name: "DrizzleQueryError", cause },
    );
    const facts = logSafeError(error);
    expect(JSON.stringify(facts)).not.toContain("erin@example.com");
    expect(JSON.stringify(facts)).not.toContain("Erasable");
    expect(facts).toEqual({
      error_name: "DrizzleQueryError",
      error_message: 'duplicate key value violates unique constraint "contacts_account_email_idx"',
      error_code: "23505",
    });
  });

  it("cuts a bare 'params:' section and caps the length of anything else", () => {
    expect(logSafeError(new Error("boom\nparams: secret")).error_message).toBe("boom");
    expect(logSafeError(new Error("x".repeat(1000))).error_message.length).toBeLessThanOrEqual(301);
    expect(logSafeError("plain string").error_name).toBe("unknown");
  });
});
