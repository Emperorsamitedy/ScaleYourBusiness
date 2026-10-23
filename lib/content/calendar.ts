// Calendar edits — the content module's own write for moving an item to
// another day or renaming it (review 2026-10-23, #8).
//
// The chat drafts one (lib/assistant/changes.ts, "content_item"), and the
// click puts it in the approval queue as a proposal. Nothing changes on the
// calendar until the owner approves it there (rule 12). APPROVING it is the
// act: lib/proposals/service.ts calls applyCalendarEdit inside the
// approval's own transaction, so the approval, the edit and its "execution"
// log entry land together or not at all. The edit re-checks that the item is
// still exactly as the card quoted it (status, day and title) and still free
// to change: a draft with no live publish proposal, since a queued or
// scheduled post carries its own time. Anything moved since is refused in
// words, and the approval with it; nothing is overwritten unseen.
//
// Internal, like producing drafts: nothing leaves the system, so it does not
// pass the execution engine; the proposal flips to executed with its log
// entry, as produceFromProposal's does.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbTx } from "../../db";
import { contentItems } from "../../db/schema";

export type CalendarEdit =
  | { op: "reschedule"; from: string | null; to: string }
  | { op: "retitle"; from: string; to: string };

/** What the card quoted: the item as it was when the change was drafted. */
export interface CalendarBasis {
  status: string;
  scheduled_for: string | null;
  title: string;
}

/** The only state the chat may edit: a draft. Queued, publishing and published items are not. */
export const EDITABLE_STATUS = "drafted";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarEdit(v: unknown): v is CalendarEdit {
  const e = v as { op?: unknown; from?: unknown; to?: unknown } | null;
  if (e === null || typeof e !== "object" || typeof e.to !== "string") return false;
  if (e.op === "reschedule")
    return DAY.test(e.to) && (e.from === null || typeof e.from === "string");
  if (e.op === "retitle") return typeof e.from === "string" && e.to.trim() !== "";
  return false;
}

export function isCalendarBasis(v: unknown): v is CalendarBasis {
  const b = v as Partial<CalendarBasis> | null;
  return (
    b !== null &&
    typeof b === "object" &&
    typeof b.status === "string" &&
    typeof b.title === "string" &&
    (b.scheduled_for === null || typeof b.scheduled_for === "string")
  );
}

/** A proposal's calendar edit, when it carries one. */
export function calendarEditOf(
  action: unknown,
): { itemId: string; edit: CalendarEdit; basis: CalendarBasis } | null {
  const d = (action as { kind?: unknown; detail?: Record<string, unknown> } | null)?.detail;
  if (!d || typeof d.content_item_id !== "string") return null;
  if (!isCalendarEdit(d.calendar_edit) || !isCalendarBasis(d.calendar_basis)) return null;
  return { itemId: d.content_item_id, edit: d.calendar_edit, basis: d.calendar_basis };
}

export type ContentItemRow = typeof contentItems.$inferSelect;

/**
 * The edit, in the caller's transaction: one conditional UPDATE that names
 * the item as the card quoted it and the only state it may change from.
 * Null when it no longer matches — the caller refuses and rolls back.
 */
export async function applyCalendarEdit(
  tx: DbTx,
  args: { profileId: string; itemId: string; edit: CalendarEdit; basis: CalendarBasis },
): Promise<ContentItemRow | null> {
  const { basis, edit } = args;
  if (basis.status !== EDITABLE_STATUS) return null;
  const [row] = await tx
    .update(contentItems)
    .set(edit.op === "reschedule" ? { scheduled_for: edit.to } : { title: edit.to.trim() })
    .where(
      and(
        eq(contentItems.id, args.itemId),
        eq(contentItems.profile_id, args.profileId),
        eq(contentItems.status, EDITABLE_STATUS),
        eq(contentItems.title, basis.title),
        basis.scheduled_for === null
          ? isNull(contentItems.scheduled_for)
          : eq(contentItems.scheduled_for, basis.scheduled_for),
        // A live publish proposal carries the old time and title: decline it first.
        sql`(${contentItems.publish_proposal_id} IS NULL OR NOT EXISTS (
          SELECT 1 FROM proposals p
          WHERE p.id = ${contentItems.publish_proposal_id}
            AND p.status IN ('pending', 'approved')
        ))`,
      ),
    )
    .returning();
  return row ?? null;
}
