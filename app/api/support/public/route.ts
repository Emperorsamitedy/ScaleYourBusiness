// The PUBLIC support endpoint — Phase 4 Session B (P4-07).
//
//   POST /api/support/public {action:"start", site_key}          open a conversation
//   POST /api/support/public {action:"message", token, text}     one customer turn
//   POST /api/support/public {action:"transcript", token}        the thread, for a reload
//   OPTIONS                                                      CORS preflight
//
// This route is called from the OWNER'S website by strangers, so it
// sets no cookies, reads no cookies, and knows nothing about the app's
// sessions: the site key scopes, the conversation token identifies one
// conversation, and that is the whole of its identity model (rule 21).
// It imports lib/support only — the structural test holds it to that.

import { type NextRequest, NextResponse } from "next/server";
import {
  SupportError,
  postCustomerMessage,
  readConversation,
  startConversation,
} from "../../../../lib/support/chat";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store",
} as const;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: CORS });
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { action?: unknown; site_key?: unknown; token?: unknown; text?: unknown } | null;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "a JSON body is required" }, 422);
  }
  try {
    if (body?.action === "start") {
      if (typeof body.site_key !== "string") return json({ error: "site_key is required" }, 422);
      const started = await startConversation(body.site_key);
      return json(started, 201);
    }
    if (body?.action === "message") {
      if (typeof body.token !== "string" || typeof body.text !== "string") {
        return json({ error: "token and text are required" }, 422);
      }
      const outcome = await postCustomerMessage(body.token, body.text);
      return json({
        reply: outcome.reply,
        escalated: outcome.escalated,
        reason: outcome.reason,
      });
    }
    if (body?.action === "transcript") {
      if (typeof body.token !== "string") return json({ error: "token is required" }, 422);
      return json({ messages: await readConversation(body.token) });
    }
    return json({ error: 'action must be "start", "message" or "transcript"' }, 422);
  } catch (error) {
    if (error instanceof SupportError) return json({ error: error.message }, error.status);
    // The name only: a customer's text could be in the message.
    console.error(
      JSON.stringify({
        event: "support_public_error",
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return json({ error: "something went wrong on our side" }, 500);
  }
}
