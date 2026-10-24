// The smoke tests' real wiring (scripts/smoke/real-deps.ts) against this
// machine's database: smoke:erasure end to end through the production
// erasure path, leaving nothing behind but its PII-free log entry; and
// smoke:inbound's watcher finding a ticket the real inbound filing made.
// Nothing here calls Resend: the inbound email is handed to the filing
// function directly, as the webhook would after verifying it.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  contactSuppressions,
  contacts,
  decisionLog,
  fieldRecords,
  intakeEvents,
} from "../../db/schema";
import { emailHash } from "../../lib/crm/contacts";
import { ensureSupportSettings } from "../../lib/crm/support-settings";
import { bootstrapIntake } from "../../lib/intake/service";
import { inboundAddress, receiveInboundEmail } from "../../lib/support/email-tickets";
import { EXIT_PASS } from "./common";
import { runSmokeErasure } from "./erasure";
import { runSmokeInbound } from "./inbound";
import { erasureDeps, inboundDeps } from "./real-deps";

const created: { account_id: string; profile_id: string }[] = [];

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  for (const s of created) {
    await db.delete(contacts).where(eq(contacts.account_id, s.account_id));
    await db.delete(contactSuppressions).where(eq(contactSuppressions.account_id, s.account_id));
  }
  if (ids.length > 0) {
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("smoke:erasure against the database, through the real erasure path", () => {
  it("passes every check, and cleans up all but the PII-free log entry", async () => {
    const s = await fresh();
    const email = `smoke-erasure-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const lines: string[] = [];
    const code = await runSmokeErasure({
      env: process.env,
      argv: ["--account", s.account_id, "--email", email, "--yes"],
      print: (l) => lines.push(l),
      deps: erasureDeps,
    });
    expect(lines.filter((l) => l.includes("FAIL"))).toEqual([]);
    expect(code).toBe(EXIT_PASS);

    // Nothing of the address is left: no contact, no suppression.
    expect(await db.select().from(contacts).where(eq(contacts.email, email))).toHaveLength(0);
    expect(
      await db
        .select()
        .from(contactSuppressions)
        .where(
          and(
            eq(contactSuppressions.account_id, s.account_id),
            eq(contactSuppressions.email_hash, emailHash(email)),
          ),
        ),
    ).toHaveLength(0);
    // The log entry stays, append-only, naming an id and a hash.
    const log = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, s.profile_id), eq(decisionLog.kind, "erasure")));
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain(email);
  });
});

describe("smoke:inbound against the database", () => {
  it("finds the ticket a real inbound filing made, and ignores the sender's earlier mail", async () => {
    const s = await fresh();
    const settings = await ensureSupportSettings(s.profile_id);
    const domain = "inbound.syb.test";
    const from = `smoke-inbound-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const mail = (subject: string) => ({
      provider_id: crypto.randomUUID(),
      from: { address: from, name: null },
      to: [inboundAddress(settings.inbound_token, domain)],
      subject,
      text: "Smoke test: inbound.",
      truncated: false,
      message_id: `<${crypto.randomUUID()}@mail.example.test>`,
      in_reply_to: null,
      references: null,
      received_at: new Date().toISOString(),
      sender_auth: "verified" as const,
    });
    // An earlier email from the same sender must not count as the test landing.
    const earlier = await receiveInboundEmail(mail("Earlier"), domain);
    expect(earlier.kind).toBe("filed");
    const seen = await inboundDeps.seenMessageIds(s.profile_id, from);
    expect(seen).toHaveLength(1);
    expect(await inboundDeps.findLanding(s.profile_id, from, seen)).toBeNull();

    // The watcher, with its sleep filing the test email the way the webhook would.
    let filed = false;
    const lines: string[] = [];
    const code = await runSmokeInbound({
      env: { ...process.env, SUPPORT_INBOUND_DOMAIN: domain },
      argv: ["--profile", s.profile_id, "--from", from, "--timeout", "20"],
      print: (l) => lines.push(l),
      deps: {
        ...inboundDeps,
        sleep: async () => {
          if (!filed) {
            filed = true;
            await receiveInboundEmail(mail("Smoke test: inbound"), domain);
          }
        },
      },
    });
    expect(lines.filter((l) => l.includes("FAIL"))).toEqual([]);
    expect(code).toBe(EXIT_PASS);
    expect(lines.join("\n")).toContain(inboundAddress(settings.inbound_token, domain));
  });
});
