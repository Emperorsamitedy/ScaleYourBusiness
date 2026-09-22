// The conversation API — step 46a + P3-36.
//
//   GET  /api/chat   the thread, oldest first
//   POST /api/chat   one owner message, handled end to end
//
// The channel is grounded in ONE profile (the intake cookie's), and a
// request can only ever produce a proposal — the queue and the engine
// hold every gate; this route holds none of its own beyond identity.

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import { ChatError, postMessage, readThread } from "../../../lib/chat/service";

const COOKIE = "syb_intake_profile";

async function resolveProfile(): Promise<{ profile_id: string; account_id: string } | null> {
  const store = await cookies();
  const profileId = store.get(COOKIE)?.value;
  if (!profileId) return null;
  const [row] = await db
    .select({ id: businessProfiles.id, account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return row ? { profile_id: row.id, account_id: row.account_id } : null;
}

export async function GET(): Promise<NextResponse> {
  const who = await resolveProfile();
  if (!who) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const turns = await readThread(who.profile_id);
  return NextResponse.json({
    turns: turns.map((t) => ({
      id: t.id,
      role: t.role,
      text: t.text,
      at: t.at,
      intent: t.intent,
    })),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const who = await resolveProfile();
  if (!who) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const body = (await request.json()) as { text?: unknown };
    if (typeof body.text !== "string") {
      return NextResponse.json({ error: "text is required" }, { status: 422 });
    }
    const outcome = await postMessage(who.profile_id, who.account_id, body.text);
    return NextResponse.json({
      intent: outcome.intent,
      proposal_id: outcome.proposal_id,
      reply: {
        id: outcome.reply.id,
        role: "system",
        text: outcome.reply.text,
        at: outcome.reply.at,
      },
    });
  } catch (error) {
    if (error instanceof ChatError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(JSON.stringify({ event: "chat_error", message: String(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
