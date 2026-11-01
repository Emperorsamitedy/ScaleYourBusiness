// I-54a — a bank statement's balance, imported. What must hold:
//   · only the date and the running balance are read; each day's closing
//     balance is the latest row of that day, whichever way the file is
//     sorted, and a quiet day keeps the balance before it, up to the day
//     the statement runs to — never past it, and never past today;
//   · money is integer minor units in the named currency, overdrafts
//     included; a decimal style or date order the file can't prove is
//     asked, never guessed; a file without a balance column, or sorted
//     both ways, is refused; an unreadable row is counted, not guessed;
//   · the import writes `cash.balance` under one balance-import connection
//     and one decision-log entry, and a re-import replaces its days.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  decisionLog,
  fieldRecords,
  intakeEvents,
  metricObservations,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import {
  BALANCE_IMPORT_PROVIDER,
  BalanceImportError,
  importBankStatement,
  mapBalanceHeader,
  statementBalances,
} from "./import";

const TODAY = "2026-11-01";
const read = (csv: string, extra: Partial<Parameters<typeof statementBalances>[1]> = {}) =>
  statementBalances(csv, { currency: "EUR", today: TODAY, ...extra });

describe("the columns", () => {
  it("finds the date and the balance by their usual names, and nothing else", () => {
    expect(mapBalanceHeader(["Completed Date", "Description", "Amount", "Balance"])).toEqual({
      date: 0,
      balance: 3,
    });
    expect(mapBalanceHeader(["Buchungsdatum", "Verwendungszweck", "Betrag", "Saldo"])).toEqual({
      date: 0,
      balance: 3,
    });
    expect(mapBalanceHeader(["Date", "Running Balance"]).balance).toBe(1);
  });
});

describe("reading a statement", () => {
  it("oldest first: the day's last row closes it, and quiet days keep the balance", () => {
    const r = read(
      [
        "Date,Description,Amount,Balance",
        "2026-10-27,Card sale,100.00,1000.00",
        "2026-10-27,Rent,-400.00,600.00",
        "2026-10-29,Card sale,50.50,650.50",
      ].join("\n"),
    );
    expect(r.from).toBe("2026-10-27");
    expect(r.through).toBe("2026-10-29");
    expect([...r.closing.entries()]).toEqual([
      ["2026-10-27", 60_000],
      ["2026-10-28", 60_000],
      ["2026-10-29", 65_050],
    ]);
    expect(r.latest).toEqual({ day: "2026-10-29", amount_minor: 65_050, currency: "EUR" });
    expect(r.rows_read).toBe(3);
  });

  it("newest first: the day's first row closes it", () => {
    const r = read(
      [
        "Date,Amount,Balance",
        "2026-10-29,50.50,650.50",
        "2026-10-27,-400.00,600.00",
        "2026-10-27,100.00,1000.00",
      ].join("\n"),
    );
    expect(r.closing.get("2026-10-27")).toBe(60_000);
    expect(r.closing.get("2026-10-29")).toBe(65_050);
  });

  it("runs to the day the owner says, never past it, and never past today", () => {
    const csv = "Date,Balance\n2026-10-25,10.00\n2026-10-26,12.00";
    const r = read(csv, { through: "2026-10-31" });
    expect(r.days).toBe(7);
    expect(r.closing.get("2026-10-31")).toBe(1_200);
    expect(() => read(csv, { through: "2026-10-25" })).toThrow(/rows after the day/);
    expect(() => read(csv, { through: "2026-11-05" })).toThrow(/past today/);
    expect(() => read("Date,Balance\n2026-11-03,1.00")).toThrow(/past today/);
  });

  it("reads a European statement: semicolons, day-first dates, comma decimals, an overdraft", () => {
    const r = read(
      [
        "Datum;Verwendungszweck;Betrag;Saldo",
        "28.10.2026;Miete;-1.200,00;-350,25",
        "30.10.2026;Umsatz;800,00;449,75",
      ].join("\n"),
    );
    expect(r.closing.get("2026-10-28")).toBe(-35_025);
    expect(r.closing.get("2026-10-30")).toBe(44_975);
  });

  it("asks rather than guesses: an ambiguous date order, an ambiguous amount", () => {
    expect(() => read("Date,Balance\n03/04/2026,10.00\n05/06/2026,11.00")).toThrow(
      /day or the month comes first/,
    );
    const r = read("Date,Balance\n03/04/2026,10.00\n05/06/2026,11.00", { date_order: "dmy" });
    expect(r.from).toBe("2026-04-03");
    expect(() => read("Date,Balance\n2026-10-01,1.200\n2026-10-02,1.300")).toThrow(/1\.200/);
    expect(
      read("Date,Balance\n2026-10-01,1.200\n2026-10-02,1.300", { decimal_style: "comma_decimal" })
        .latest.amount_minor,
    ).toBe(130_000);
  });

  it("refuses what it can't read: no balance column, rows sorted both ways, no currency", () => {
    expect(() => read("Date,Description,Amount\n2026-10-01,x,10.00")).toThrow(BalanceImportError);
    expect(() => read("Date,Description,Amount\n2026-10-01,x,10.00")).toThrow(/amounts alone/);
    expect(() => read("Date,Balance\n2026-10-01,1.00\n2026-10-03,2.00\n2026-10-02,3.00")).toThrow(
      /aren't in date order/,
    );
    expect(() =>
      statementBalances("Date,Balance\n2026-10-01,1.00", { currency: "", today: TODAY }),
    ).toThrow(/currency/);
  });

  it("counts what it leaves out: an unreadable row, a one-day file whose rows disagree", () => {
    const r = read(
      "Date,Balance\n2026-10-01,10.00\nnot a date,11.00\n2026-10-02,abc\n2026-10-03,12.00",
    );
    expect(r.skipped).toEqual({ date_unreadable: 1, balance_unreadable: 1, day_unclear: 0 });
    expect(() => read("Date,Balance\n2026-10-01,10.00\n2026-10-01,11.00")).toThrow(
      /can't say which came last/,
    );
    expect(read("Date,Balance\n2026-10-01,10.00\n2026-10-01,10.00").latest.amount_minor).toBe(
      1_000,
    );
  });

  it("reads only the two columns: nothing of a description or payee reaches the result", () => {
    const r = read("Date,Payee,Balance\n2026-10-01,Anna Kovacs,10.00");
    expect(JSON.stringify({ ...r, closing: [...r.closing] })).not.toMatch(/Anna|Kovacs/);
  });
});

const created: { account_id: string; profile_id: string }[] = [];
afterAll(async () => {
  const accountIds = created.map((s) => s.account_id);
  const ids = created.map((s) => s.profile_id);
  if (accountIds.length === 0) return;
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.account_id, accountIds));
  if (conns.length > 0) {
    await db.delete(metricObservations).where(
      inArray(
        metricObservations.connection_id,
        conns.map((c) => c.id),
      ),
    );
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
  }
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

describe("importing a statement", () => {
  it("writes each day's closing balance under one import connection, and one log entry", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const now = new Date(`${TODAY}T09:00:00Z`);
    const csv = "Date,Balance\n2026-10-28,100.00\n2026-10-30,250.00";
    const out = await importBankStatement(s.account_id, csv, { currency: "eur", now });
    expect(out).toMatchObject({ from: "2026-10-28", through: "2026-10-30", days: 3 });
    const [conn] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.account_id, s.account_id),
          eq(connections.provider, BALANCE_IMPORT_PROVIDER),
        ),
      );
    expect(conn).toMatchObject({ purpose: "import", encrypted_secret: null, granted_scopes: [] });
    const rows = await db
      .select()
      .from(metricObservations)
      .where(eq(metricObservations.connection_id, conn!.id));
    expect(rows.map((r) => [r.period_date, Number(r.value_minor), r.currency]).sort()).toEqual([
      ["2026-10-28", 10_000, "EUR"],
      ["2026-10-29", 10_000, "EUR"],
      ["2026-10-30", 25_000, "EUR"],
    ]);
    const log = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, s.profile_id), eq(decisionLog.ref_id, out.batch_id)));
    expect(log).toHaveLength(1);
    expect(log[0]!.kind).toBe("import");

    // A corrected statement for the same days replaces them, never doubles them.
    await importBankStatement(s.account_id, "Date,Balance\n2026-10-30,240.00", {
      currency: "EUR",
      now,
    });
    const again = await db
      .select()
      .from(metricObservations)
      .where(eq(metricObservations.connection_id, conn!.id));
    expect(again).toHaveLength(3);
    expect(Number(again.find((r) => r.period_date === "2026-10-30")!.value_minor)).toBe(24_000);
  });
});
