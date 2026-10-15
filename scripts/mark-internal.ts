// Operator helper (P3-40b): flag SYB's own account as internal, so its
// numbers stay out of Gate 2 and the ops panel. Run it against the
// database the account lives in.
// Usage: npx tsx scripts/mark-internal.ts <account_id> [--off]
import "dotenv/config";
import { setAccountInternal } from "../lib/ops/internal";

async function main(): Promise<void> {
  const accountId = process.argv[2];
  if (!accountId) throw new Error("usage: npx tsx scripts/mark-internal.ts <account_id> [--off]");
  const internal = !process.argv.includes("--off");
  await setAccountInternal(accountId, internal);
  console.log(`account ${accountId} internal = ${internal}`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
