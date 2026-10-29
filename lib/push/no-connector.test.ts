// Idea 53 (I-53.3): push services are SYB's own channel to the owner, like
// Resend, not a business's connected account. Two proofs that sending
// never touches a connector or the execution engine:
//
//   1. The import graph of the send path (the flush, the sender, the route,
//      the cron) reaches nothing under lib/connectors but the shared
//      secrets cipher, and nothing under lib/execution at all. The walker
//      is shown to catch a module that does import a connector.
//   2. A real Web Push send, end to end through the flush, makes exactly
//      one request, to the subscription's push service, and nothing else.

import "dotenv/config";
import { createECDH, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  fieldRecords,
  intakeEvents,
  proposals,
  pushSubscriptions,
  users,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { createProposal } from "../proposals/service";
import { flushPushes } from "./flush";
import type { PushFetch } from "./send";
import { webPushService } from "./send";
import { saveSubscription } from "./subscriptions";
import { b64url, generateVapidKeys } from "./webpush";

const ROOT = process.cwd();

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // packages and node: builtins
  const base = resolve(dirname(from), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(cand) && !cand.endsWith(dirname(from)) && /\.tsx?$/.test(cand)) return cand;
  }
  return null;
}

/** Every repo module reachable by value or type imports from the entry files. */
function importGraph(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = entries.map((e) => resolve(ROOT, e));
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const next = resolveImport(file, m[1] as string);
      if (next && !seen.has(next)) stack.push(next);
    }
  }
  return new Set([...seen].map((f) => relative(ROOT, f).replace(/\\/g, "/")));
}

function forbidden(graph: Set<string>): string[] {
  return [...graph].filter(
    (f) =>
      (f.startsWith("lib/connectors/") && f !== "lib/connectors/secrets.ts") ||
      f.startsWith("lib/execution/"),
  );
}

const SEND_PATH = [
  "lib/push/flush.ts",
  "lib/push/send.ts",
  "lib/push/deliver.ts",
  "lib/push/subscriptions.ts",
  "app/api/push/route.ts",
  "app/api/cron/push-held/route.ts",
];

describe("the send path's imports", () => {
  it("reach no connector and no execution provider", () => {
    const graph = importGraph(SEND_PATH);
    expect(graph.has("lib/push/webpush.ts")).toBe(true);
    expect(forbidden(graph)).toEqual([]);
  });

  it("the check would catch a module that reaches a connector", () => {
    // The intake service reads the provider registry; the walker must see it.
    expect(forbidden(importGraph(["lib/intake/service.ts"]))).toContain(
      "lib/connectors/registry.ts",
    );
  });
});

const created: { account_id: string; profile_id: string }[] = [];
afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.account_id, s.account_id));
    await db.delete(users).where(eq(users.account_id, s.account_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("a real send, end to end", () => {
  it("makes one request, to the push service, and touches no connection", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const [u] = await db
      .insert(users)
      .values({
        account_id: s.account_id,
        email: `i53-nc-${crypto.randomUUID()}@test.local`,
        display_name: "I-53 owner",
        role: "owner",
      })
      .returning({ id: users.id });
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    await saveSubscription({
      accountId: s.account_id,
      userId: u?.id as string,
      sessionId: null,
      userAgent: "Android",
      target: { endpoint, p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)) },
      timeZone: "Europe/Budapest",
    });
    await createProposal({
      profile_id: s.profile_id,
      module: "diagnosis",
      action: { kind: "content_publishing", summary: "Post the autumn menu" },
      scenario: {
        assumptions: [],
        base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
        downside_case: {
          case: "downside",
          statement: "t",
          profit_delta_monthly: null,
          formula: null,
        },
        upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
        breakeven_condition: "none — test fixture",
      },
      reversibility: { level: "easy", if_you_change_your_mind: "delete it" },
      expires_at: "2027-01-31T00:00:00.000Z",
    });

    const calls: string[] = [];
    const fetchImpl: PushFetch = async (url) => {
      calls.push(url);
      return new Response(null, { status: 201 });
    };
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const out = await flushPushes(s.profile_id, {
      service: webPushService({
        vapid: { ...generateVapidKeys(), subject: "mailto:ops@syb.example" },
        fetchImpl,
      }),
      now: new Date("2026-11-10T09:00:00Z"),
    });
    globalFetch.mockRestore();

    expect(out).toMatchObject({ plan: "send", sent: 1 });
    expect(calls).toEqual([endpoint]);
    expect(globalFetch).not.toHaveBeenCalled();
    const conns = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    expect(conns).toEqual([]);
  });
});
