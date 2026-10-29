// "Remove this review" — idea 45, rule 22's spirit for reviewers.
//
// A reviewer is a person who never signed up for SYB. The owner can take
// their review out at once (a reviewer asked, or it was filed by mistake):
// the row goes, with the reviewer's name, the words, the link and any
// suggested reply on it. The decision log records that an erasure happened
// by ids and a hash only, so it stays verifiable and holds nothing
// personal (rule 7 and rule 22 never collide). The watch line the review's
// alert wrote stays: it names the platform and stars, nobody.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { decisionLog, reviews } from "../../db/schema";
import { ReviewDeskError } from "./settings";

export async function eraseReview(profileId: string, reviewId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(reviews)
      .where(and(eq(reviews.id, reviewId), eq(reviews.profile_id, profileId)))
      .returning({ id: reviews.id, account_id: reviews.account_id });
    if (!gone) throw new ReviewDeskError("no such review", 404);
    await tx.insert(decisionLog).values({
      profile_id: profileId,
      actor: "owner",
      kind: "erasure",
      ref_id: gone.id,
      payload_hash: createHash("sha256")
        .update(JSON.stringify({ account_id: gone.account_id, review_id: gone.id }))
        .digest("hex"),
    });
    console.log(
      JSON.stringify({ event: "review_erased", account_id: gone.account_id, review_id: gone.id }),
    );
  });
}
