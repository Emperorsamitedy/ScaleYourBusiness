// The support reply's disclosure line — Phase 4 Session C (P4-10), rule 20.
// Pure, so the owner's screen shows the exact words the send appends.

export function replyDisclosure(businessName: string): string {
  return `This reply was drafted by an automated assistant and checked by a person at ${businessName} before it was sent.`;
}
