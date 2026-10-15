// Operator helper (P3-47): close an escalated alert case after a person
// has dealt with it. The next alert on that goal may be reviewed again.
// Open cases are listed by /api/ops under "escalations".
// Usage: npx tsx scripts/resolve-escalation.ts <review_id>
import "dotenv/config";
import { resolveEscalation } from "../lib/care/review";

async function main(): Promise<void> {
  const reviewId = process.argv[2];
  if (!reviewId) throw new Error("usage: npx tsx scripts/resolve-escalation.ts <review_id>");
  await resolveEscalation(reviewId);
  console.log(`review ${reviewId} resolved`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
