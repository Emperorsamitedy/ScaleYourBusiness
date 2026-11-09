// The conversation API — step 46a + P3-36 + feature 33.
//
//   GET  /api/chat                          the thread, oldest first, with
//                                           each reply's change card
//   POST /api/chat { text }                 one owner message, handled end to end
//   POST /api/chat { action: "confirm",     the owner's click on a drafted
//                    change_id }            change — the only write a click makes
//
// The channel is grounded in ONE profile (the intake cookie's). A message
// can only ever DRAFT a change or produce a proposal; the click writes
// through the screen's own path, and a setting whose own route needs a
// signed-in user needs one here too (the catalogue says which).

import { logSafeError } from "../../../lib/core/log-safe";
import { isMissingEnvError } from "../../../lib/env";
import { resolveAccess } from "../../../lib/auth/access";
import { type NextRequest, NextResponse } from "next/server";
import { ChangeError, confirmChange, listChanges } from "../../../lib/assistant/changes";
import { cardView } from "../../../lib/assistant/view";
import { ChatError, postMessage, readThread } from "../../../lib/chat/service";
import { requireRole, roleOf } from "../../../lib/auth/roles";
import { requestLocale } from "../../../lib/i18n/server";

export async function GET(): Promise<NextResponse> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const [turns, changes] = await Promise.all([
    readThread(access.profile_id),
    listChanges(access.profile_id),
  ]);
  return NextResponse.json({
    turns: turns.map((t) => ({
      id: t.id,
      role: t.role,
      text: t.text,
      at: t.at,
      intent: t.intent,
    })),
    changes: changes.map(cardView),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "chat.ask");
  if (denied) return denied;
  try {
    const body = (await request.json()) as {
      text?: unknown;
      action?: unknown;
      change_id?: unknown;
    };
    if (body.action === "confirm") {
      if (typeof body.change_id !== "string") {
        return NextResponse.json({ error: "change_id is required" }, { status: 422 });
      }
      const row = await confirmChange({
        profileId: access.profile_id,
        accountId: access.account_id,
        changeId: body.change_id,
        signedIn: access.session !== null,
        // The drafted change asks for its own screen's role too (lib/assistant/catalogue).
        role: roleOf(access),
        userId: access.session?.user_id ?? null,
      });
      console.log(
        JSON.stringify({
          event: "assistant_change_confirmed",
          account_id: access.account_id,
          kind: row.kind,
          status: row.status,
        }),
      );
      return NextResponse.json({ change: cardView(row) });
    }
    if (typeof body.text !== "string") {
      return NextResponse.json({ error: "text is required" }, { status: 422 });
    }
    // I-52c: anyone on the team may ask; a message does only what the asker's role may.
    const outcome = await postMessage(
      access.profile_id,
      access.account_id,
      body.text,
      {},
      roleOf(access) ?? "owner",
      // L-5: the answer is written in the asker's language (rule 5).
      await requestLocale(),
    );
    return NextResponse.json({
      intent: outcome.intent,
      proposal_id: outcome.proposal_id,
      reply: {
        id: outcome.reply.id,
        role: "system",
        text: outcome.reply.text,
        at: outcome.reply.at,
      },
      change: outcome.change ? cardView(outcome.change) : null,
    });
  } catch (error) {
    if (error instanceof ChatError || error instanceof ChangeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (isMissingEnvError(error)) {
      return NextResponse.json(
        { error: `I can't answer from here yet — this server's ${error.key} isn't set.` },
        { status: 503 },
      );
    }
    console.error(
      JSON.stringify({
        event: "chat_error",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
