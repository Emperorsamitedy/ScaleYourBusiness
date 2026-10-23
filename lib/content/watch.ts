// The watch blocks every content proposal — the calendar and the shot list
// alike (rule 15; P3-36: "gated by hard limits and watching mode like every
// other source"). One check, so the screen and the proposers can't disagree.

import { careState } from "../care/day-zero";
import { ContentError } from "./plan";

/** The day the watch ends (YYYY-MM-DD) while it is running, else null. */
export async function contentWatchUntil(
  profileId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const care = await careState(profileId);
  if (!care?.watch_ends_at) return null;
  return now.toISOString() < care.watch_ends_at ? care.watch_ends_at.slice(0, 10) : null;
}

export async function assertNotWatching(profileId: string, now: Date = new Date()): Promise<void> {
  const until = await contentWatchUntil(profileId, now);
  if (until) {
    throw new ContentError(
      `still watching until ${until} — nothing is proposed before then (rule 15)`,
      409,
    );
  }
}
