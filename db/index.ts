import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle(pool, { schema });

/** A transaction handle, as db.transaction's callback receives it. */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The database or an open transaction — for a write that may join a caller's transaction. */
export type DbOrTx = typeof db | DbTx;
