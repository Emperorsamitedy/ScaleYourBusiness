import { describe, expect, it } from "vitest";
import { localDatabaseHost } from "./seed-demo-guard";

describe("localDatabaseHost — the demo seed only writes to this machine", () => {
  it("accepts localhost, 127.0.0.1 and ::1", () => {
    expect(localDatabaseHost("postgresql://syb:pw@127.0.0.1:5433/syb")).toEqual({
      ok: true,
      host: "127.0.0.1",
    });
    expect(localDatabaseHost("postgres://syb@localhost/syb")).toEqual({
      ok: true,
      host: "localhost",
    });
    expect(localDatabaseHost("postgresql://syb@[::1]:5432/syb")).toEqual({
      ok: true,
      host: "::1",
    });
    expect(localDatabaseHost("postgresql://syb@LOCALHOST/syb").ok).toBe(true);
  });

  it("refuses a remote host", () => {
    const verdict = localDatabaseHost(
      "postgresql://u:p@ep-cool-name.eu-central-1.aws.neon.tech/neondb?sslmode=require",
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("neon.tech");
  });

  it("refuses look-alikes of a local name", () => {
    expect(localDatabaseHost("postgresql://u@localhost.evil.example/db").ok).toBe(false);
    expect(localDatabaseHost("postgresql://u@127.0.0.2/db").ok).toBe(false);
  });

  it("refuses a host= override that leaves the machine", () => {
    expect(localDatabaseHost("postgresql://u@localhost/db?host=db.example.com").ok).toBe(false);
    expect(localDatabaseHost("postgresql://u@localhost/db?host=127.0.0.1").ok).toBe(true);
  });

  it("refuses a missing, empty, unparseable or non-postgres URL", () => {
    expect(localDatabaseHost(undefined).ok).toBe(false);
    expect(localDatabaseHost("   ").ok).toBe(false);
    expect(localDatabaseHost("not a url").ok).toBe(false);
    expect(localDatabaseHost("mysql://u@localhost/db").ok).toBe(false);
  });
});
