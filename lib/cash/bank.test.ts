// P5-06 — the two cash questions, against live Postgres: the bank carries
// them as Money with "I don't know" allowed, and the intake reaches them
// through their stored conditions only (rule 4) — cash today once money is
// coming in, the buffer once cash today has a value.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords } from "../../db/schema";
import { loadBank } from "../bank/loader";
import { enumValue } from "../core/enum-value";
import type { FieldStatus } from "../core/field-status";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { money } from "../core/money";
import { writeField } from "../profile/field-store";
import { applicableQuestions } from "../resolver/applicability";
import { BUFFER_KEY, CASH_KEY } from "./keys";

const BANK_PATH = "specs/question-bank-v1.json";

interface BankQuestion {
  id: string;
  section: string;
  writes_to: string;
  input: { type: string; allow_unknown?: boolean };
  condition: unknown;
  unlocks?: string[];
}

let accountId: string;
let profileId: string;

function fact(key: string, value: unknown, status: FieldStatus = "answered") {
  const at = isoDateTime(new Date().toISOString());
  return createField<unknown>({
    id: fieldId(key),
    value: status === "answered" ? value : null,
    status,
    confidence: status === "answered" ? 0.75 : 0,
    source: { kind: "owner_input" },
    observed_at: at,
    recorded_at: at,
    note: null,
  });
}

async function ids(): Promise<Set<string>> {
  return new Set((await applicableQuestions(profileId)).map((q) => q.id));
}

beforeAll(async () => {
  await loadBank(BANK_PATH);
  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: "EUR", locale: "en-IE" })
    .returning();
  if (!account) throw new Error("account insert failed");
  accountId = account.id;
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: accountId, schema_version: "1.0.0" })
    .returning();
  if (!profile) throw new Error("profile insert failed");
  profileId = profile.id;
});

afterAll(async () => {
  await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profileId));
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

describe("P5-06 — the cash questions in the bank", () => {
  const bank = JSON.parse(readFileSync(BANK_PATH, "utf8")) as {
    bank_version: string;
    questions: BankQuestion[];
  };
  const q = (id: string) => bank.questions.find((x) => x.id === id);

  it("bank 1.8.0 carries 5.3e and 5.3f as Money, I-don't-know allowed, in the costs section", () => {
    expect(bank.bank_version).toBe("1.8.0");
    for (const [id, key] of [
      ["5.3e", CASH_KEY],
      ["5.3f", BUFFER_KEY],
    ] as const) {
      const question = q(id);
      expect(question?.writes_to).toBe(key);
      expect(question?.section).toBe("costs");
      expect(question?.input).toEqual({ type: "money", allow_unknown: true });
    }
    expect(q("5.3e")?.unlocks).toEqual(["5.3f"]);
  });

  it("sits beside 5.3b, the cash-flow question, under the same condition", () => {
    const order = bank.questions.map((x) => x.id);
    expect(order.indexOf("5.3e")).toBe(order.indexOf("5.3d") + 1);
    expect(q("5.3e")?.condition).toEqual(q("5.3b")?.condition);
  });
});

describe("P5-06 — the intake reaches them through data conditions only", () => {
  it("not asked before anything is known, nor of a business with no money coming in", async () => {
    let applicable = await ids();
    expect(applicable.has("5.3e")).toBe(false);
    expect(applicable.has("5.3f")).toBe(false);
    await writeField(profileId, fact("revenue.generates_revenue", enumValue("not_launched")));
    applicable = await ids();
    expect(applicable.has("5.3e")).toBe(false);
    expect(applicable.has("5.3f")).toBe(false);
  });

  it("cash today is asked once money is coming in; the buffer waits for it", async () => {
    await writeField(profileId, fact("revenue.generates_revenue", enumValue("yes")));
    const applicable = await ids();
    expect(applicable.has("5.3e")).toBe(true);
    expect(applicable.has("5.3f")).toBe(false);
  });

  it("'I don't know' to cash today is recorded and doesn't open the buffer", async () => {
    await writeField(profileId, fact(CASH_KEY, null, "unknown"));
    expect((await ids()).has("5.3f")).toBe(false);
  });

  it("a figure for cash today opens the buffer", async () => {
    await writeField(profileId, fact(CASH_KEY, money(640_000, "EUR")));
    const applicable = await applicableQuestions(profileId);
    expect(applicable.find((x) => x.id === "5.3e")?.already_answered).toBe(true);
    expect(applicable.find((x) => x.id === "5.3f")?.already_answered).toBe(false);
  });
});
