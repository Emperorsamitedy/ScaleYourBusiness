// The smoke tests' shared rules (scripts/smoke/common.ts), each with a
// passing and a failing case: the command line, the database named
// without its password, secrets scrubbed from every line, numbered PASS /
// FAIL with honest exit codes, and the reserved-domain test for addresses.

import { describe, expect, it } from "vitest";
import {
  EXIT_FAIL,
  EXIT_PASS,
  EXIT_REFUSED,
  Report,
  databaseLine,
  databaseTarget,
  domainOf,
  fromAddress,
  httpsOrigin,
  isReservedTestAddress,
  missingKeys,
  ownSenderAddresses,
  parseArgs,
  scrub,
  secretValues,
} from "./common";

describe("parseArgs", () => {
  it("reads --name value, --name=value and bare flags", () => {
    const a = parseArgs(["--to", "a@b.example", "--profile=123", "--yes"]);
    expect(a.values.get("to")).toBe("a@b.example");
    expect(a.values.get("profile")).toBe("123");
    expect(a.flags.has("yes")).toBe(true);
  });

  it("a flag followed by another flag takes no value, and stray words are ignored", () => {
    const a = parseArgs(["stray", "--to", "--yes"]);
    expect(a.values.has("to")).toBe(false);
    expect(a.flags.has("to")).toBe(true);
    expect(a.flags.has("yes")).toBe(true);
  });
});

describe("missingKeys", () => {
  it("names absent and blank keys only", () => {
    expect(missingKeys({ A: "x", B: " ", C: undefined }, ["A", "B", "C", "D"])).toEqual([
      "B",
      "C",
      "D",
    ]);
    expect(missingKeys({ A: "x" }, ["A"])).toEqual([]);
  });
});

describe("the database line — host shown, password never", () => {
  const url = "postgresql://syb:hunter2-very-secret@127.0.0.1:5433/syb_ready";

  it("names host, port, database and user, and masks the password", () => {
    const line = databaseLine(url);
    expect(line).toContain("127.0.0.1:5433/syb_ready as syb");
    expect(line).toContain("password ***");
    expect(line).toContain("this machine");
    expect(line).not.toContain("hunter2");
  });

  it("says plainly when the database isn't this machine", () => {
    const line = databaseLine(
      "postgres://u:pw-secret-123@ep-cool.eu.aws.neon.tech/neondb?sslmode=require",
    );
    expect(line).toContain("ep-cool.eu.aws.neon.tech");
    expect(line).toContain("NOT this machine");
    expect(line).not.toContain("pw-secret-123");
  });

  it("a ?host= override is the real target", () => {
    const t = databaseTarget("postgresql://u@localhost/db?host=db.remote.example");
    expect(t.ok && t.host).toBe("db.remote.example");
    expect(t.ok && t.local).toBe(false);
  });

  it("refuses to describe a missing or non-postgres URL", () => {
    expect(databaseTarget(undefined).ok).toBe(false);
    expect(databaseTarget("mysql://x@y/z").ok).toBe(false);
    expect(databaseLine("nonsense")).toContain("isn't a URL");
  });
});

describe("secrets are scrubbed from every line", () => {
  const env = {
    RESEND_API_KEY: "re_live_abcdefgh12345",
    DATABASE_URL: "postgresql://syb:pa55word-x@db.example/syb",
    CONNECTOR_KEY: "Y29ubmVjdG9yLWtleS1zZW50aW5lbA==",
    EMAIL_FROM: "ScaleX <hello@syb.example>",
    SESSION_D_REAL_WRITES: "on",
  };

  it("collects key-, secret-, token- and DSN-named values and the database password", () => {
    const secrets = secretValues(env);
    expect(secrets).toContain(env.RESEND_API_KEY);
    expect(secrets).toContain(env.CONNECTOR_KEY);
    expect(secrets).toContain("pa55word-x");
    expect(secrets).not.toContain(env.EMAIL_FROM);
    expect(secrets).not.toContain("on");
  });

  it("scrub hides each one wherever it appears", () => {
    const line = scrub(`key ${env.RESEND_API_KEY} and pw pa55word-x`, secretValues(env));
    expect(line).toBe("key [hidden] and pw [hidden]");
    expect(scrub("nothing secret here", secretValues(env))).toBe("nothing secret here");
  });

  it("the Report scrubs before printing", () => {
    const lines: string[] = [];
    const r = new Report((l) => lines.push(l), env);
    r.pass(`leaked ${env.RESEND_API_KEY}`);
    expect(lines.join("\n")).not.toContain(env.RESEND_API_KEY);
  });
});

describe("Report — numbered PASS / FAIL and the exit code they mean", () => {
  it("numbers each check and exits 0 when all pass", () => {
    const lines: string[] = [];
    const r = new Report((l) => lines.push(l), {});
    r.pass("one");
    r.check(true, "two", "not two");
    expect(r.finish()).toBe(EXIT_PASS);
    expect(lines).toEqual(["1. PASS  one", "2. PASS  two", "All 2 checks passed."]);
  });

  it("exits 1 when any fails, and 2 when it refused", () => {
    const lines: string[] = [];
    const r = new Report((l) => lines.push(l), {});
    r.pass("one");
    r.check(false, "two", "two broke");
    expect(r.finish()).toBe(EXIT_FAIL);
    expect(lines).toContain("2. FAIL  two broke");
    expect(lines).toContain("1 of 2 checks failed.");
    expect(new Report(() => undefined, {}).refuse("no")).toBe(EXIT_REFUSED);
  });
});

describe("isReservedTestAddress — only names no real mailbox can have", () => {
  it("accepts the reserved TLDs and example.com/.net/.org", () => {
    for (const a of [
      "x@example.test",
      "x@shop.example",
      "x@nowhere.invalid",
      "x@dev.localhost",
      "x@example.com",
      "x@mail.example.org",
      "X@EXAMPLE.NET",
    ]) {
      expect(isReservedTestAddress(a), a).toBe(true);
    }
  });

  it("refuses real domains, look-alikes and junk", () => {
    for (const a of [
      "x@gmail.com",
      "x@example.co",
      "x@myexample.com",
      "x@example.com.evil.io",
      "x@test.com",
      "not an address",
      undefined,
    ]) {
      expect(isReservedTestAddress(a), String(a)).toBe(false);
    }
  });
});

describe("addresses and origins", () => {
  it("fromAddress and domainOf read a From value", () => {
    expect(fromAddress("ScaleX <Hello@Syb.Example>")).toBe("hello@syb.example");
    expect(domainOf("hello@campaigns.syb.example")).toBe("campaigns.syb.example");
    expect(fromAddress("ScaleX")).toBeNull();
  });

  it("httpsOrigin accepts https only", () => {
    expect(httpsOrigin("https://app.example/x")).toBe("https://app.example");
    expect(httpsOrigin("http://app.example")).toBeNull();
    expect(httpsOrigin(undefined)).toBeNull();
  });

  it("ownSenderAddresses: EMAIL_FROM (or the Resend default) and CAMPAIGN_EMAIL_FROM", () => {
    expect(
      ownSenderAddresses({
        EMAIL_FROM: "L <a@syb.example>",
        CAMPAIGN_EMAIL_FROM: "L <b@campaigns.syb.example>",
      }),
    ).toEqual(["a@syb.example", "b@campaigns.syb.example"]);
    expect(ownSenderAddresses({})).toEqual(["onboarding@resend.dev"]);
  });
});
