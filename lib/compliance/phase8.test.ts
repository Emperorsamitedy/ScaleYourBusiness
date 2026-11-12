// Compliance completion — the v1 build spec §9's remaining acceptance points:
// Article 50 marking through one ContentLabeller (a provenance manifest on
// every labelling record, a machine-readable mark on AI-drafted email), an
// erasure request that takes a business out of every benchmark aggregate at
// once, and no voiceprint code anywhere (§9.4: its own flag, off, and
// nothing may depend on it — there is none to depend on).
//
// The consent gate and the no-record path are proven in lib/phone/line.test.ts;
// the blocked country at any station in lib/compliance/gate.test.ts.

import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessErasureRequests,
  businessProfiles,
  decisionLog,
  intakeEvents,
  labellingRecords,
} from "../../db/schema";
import { DIGITAL_SOURCE_TYPE } from "../content/generate/label";
import { recordLabelling } from "../growth/library";
import { bootstrapIntake } from "../intake/service";
import { optedOutProfiles } from "../peers/consent";
import { sendSupportEmail } from "../support-desk/mailer";
import { erasureOf, requestErasure } from "./erasure";
import type { provenanceManifest } from "./labeller";
import { AI_TEXT_HEADER, aiTextHeaders } from "./labeller";

const ROOT = path.resolve(__dirname, "../..");
const created: { account_id: string; profile_id: string }[] = [];
afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length === 0) return;
  await db.delete(labellingRecords).where(inArray(labellingRecords.profile_id, ids));
  await db.delete(businessErasureRequests).where(inArray(businessErasureRequests.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(
    inArray(
      accounts.id,
      created.map((s) => s.account_id),
    ),
  );
});

describe("§9.1 / §9.3 — ContentLabeller: the marks", () => {
  it("every labelling record carries a C2PA-style manifest naming the generative source and the standard", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const bytes = new Uint8Array([1, 2, 3]);
    const rec = await recordLabelling({
      profileId: s.profile_id,
      mediaUrl: "https://blob.test/x.mp4",
      label: "AI-generated video.",
      media: "video",
      bytes,
    });
    const m = rec.manifest as ReturnType<typeof provenanceManifest>;
    expect(m.claim_generator).toBe("SYB");
    expect(m.assertions[0]).toMatchObject({
      label: "c2pa.actions",
      data: { actions: [{ action: "c2pa.created", digitalSourceType: DIGITAL_SOURCE_TYPE }] },
    });
    expect(m.assertions[1]).toMatchObject({
      label: "syb.disclosure",
      data: { visible_label: "AI-generated video." },
    });
    expect(m.asset_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an AI-drafted email is marked machine-readably, beside its visible line", async () => {
    expect(aiTextHeaders()[AI_TEXT_HEADER]).toMatch(/Art\. 50\(2\)/);
    let sent: { headers?: Record<string, string> } = {};
    await sendSupportEmail(
      {
        from: "a@b.test",
        to: "c@d.test",
        reply_to: "a@b.test",
        subject: "Re: hours",
        text: "We open at nine.\n\nWritten with AI assistance.",
        in_reply_to: null,
        references: null,
        idempotency_key: "k",
      },
      "re_test",
      async (_url, init) => {
        sent = JSON.parse(String(init.body)) as typeof sent;
        return new Response(JSON.stringify({ id: "x" }), { status: 200 });
      },
    );
    expect(sent.headers?.[AI_TEXT_HEADER]).toBeTruthy();
    // The campaign sender carries the same mark (source-checked: its send is behind the engine).
    const campaign = readFileSync(
      path.join(ROOT, "lib/execution/providers/email-campaign.ts"),
      "utf8",
    );
    expect(campaign).toMatch(/\.\.\.aiTextHeaders\(\)/);
  });
});

describe("§9.4 / §9.5 — an erasure request leaves every benchmark aggregate at once", () => {
  it("is recorded once, logged, and the business is out of the pool from the next read", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    expect((await optedOutProfiles()).has(s.profile_id)).toBe(false);
    const first = await requestErasure(s.profile_id, null);
    const again = await requestErasure(s.profile_id, null);
    expect(again?.requested_at).toBe(first?.requested_at);
    expect((await optedOutProfiles()).has(s.profile_id)).toBe(true);
    expect(await erasureOf(s.profile_id)).toMatchObject({ completed_at: null });
    const log = await db.select().from(decisionLog).where(eq(decisionLog.profile_id, s.profile_id));
    expect(log.filter((l) => l.kind === "erasure")).toHaveLength(1);
  });
});

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      out.push(...sources(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("§9.4 — voiceprints are a separate category: none exist", () => {
  it("no code enrols, stores or matches a voiceprint, so no capability can depend on one", () => {
    const hits = [...sources(path.join(ROOT, "lib")), ...sources(path.join(ROOT, "app"))]
      .filter((f) =>
        /voice ?print|speaker[_ -]?(enrol|verif|identif)|voice[_ -]?biometric/i.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => path.relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
