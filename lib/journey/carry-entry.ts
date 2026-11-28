// The free check's answers follow the owner into the account they make
// from its result (ux-spec §7.0). Three of its six questions are the
// interview's own, so they are answered once, by the owner, and written
// through the interview's own path (lib/intake submitAnswer): validated,
// provenance-tracked, superseded never overwritten. The other three (a
// revenue band, a channel, an operations answer) have no field of the same
// meaning and are not carried.

import { entryByToken } from "../entry/one-number";
import { submitAnswer } from "../intake/service";
import { entryWires, isEntryToken } from "./entry-wires";

export { ENTRY_COOKIE, isEntryToken } from "./entry-wires";

/**
 * Write the check's answers into this business, once. A question already
 * answered (by the owner, or on an earlier visit) is refused by the
 * interview and left as it is. Never throws: a failure leaves the
 * question for the interview to ask.
 */
export async function carryEntryAnswers(
  accountId: string,
  profileId: string,
  token: string,
): Promise<number> {
  if (!isEntryToken(token)) return 0;
  const entry = await entryByToken(token).catch(() => null);
  if (!entry) return 0;
  let written = 0;
  for (const { questionId, wire } of entryWires(entry.answers)) {
    try {
      await submitAnswer(accountId, profileId, questionId, { kind: "value", wire });
      written += 1;
    } catch {
      // Already answered, or not applicable to this business: the interview decides.
    }
  }
  console.log(
    JSON.stringify({ event: "entry_answers_carried", account_id: accountId, count: written }),
  );
  return written;
}
