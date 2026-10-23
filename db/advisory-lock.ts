// A Postgres session-level advisory lock on a dedicated pool client, tried
// once and never waited on: when another holder has the key, `onLocked`
// answers instead. Moved here from lib/connectors/sync (P3-23a) so a
// module that only needs the lock doesn't import the connector sync.

import { db } from "./index";

export async function withAdvisoryLock<T>(
  key: string,
  run: () => Promise<T>,
  onLocked: () => T,
): Promise<T> {
  const client = await db.$client.connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as locked",
      [key],
    );
    if (res.rows[0]?.locked !== true) return onLocked();
    try {
      return await run();
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1))", [key]);
    }
  } finally {
    client.release();
  }
}
