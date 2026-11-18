// The Google Business Profile executor's database side — I-45a lifted
// (2026-11-16). What lib/execution/providers/google-business.ts reads and
// writes, loaded on first use so the provider map stays importable without a
// database: the live access (refreshed from the connection at rest), whether
// the connection's consent covers today's write lines, and the watch-log line
// the owner reads afterwards. Reads and one insert into watch_activity; never
// a token, a review's words or a reply in a log line.

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, watchActivity } from "../../db/schema";
import { googleBusinessEnv } from "../env";
import { activeExecutionConnection, executionSecret } from "../execution/connections";
import type { FetchLike } from "./client";
import { GbpRequestError, refreshAccess } from "./client";
import { GOOGLE_PROVIDER, googleWriteConsentCurrent, readGoogleSecret } from "./consent";
import { GOOGLE_RECONSENT } from "./words";

export interface GoogleWriteCredential {
  access_token: string;
  /** accounts/{a} */
  account: string;
  /** locations/{l} */
  location: string;
  title: string;
}

export interface GoogleBusinessBackend {
  credential(
    accountId: string,
    profileId: string,
  ): Promise<GoogleWriteCredential | { refused: string }>;
  changed(profileId: string, detail: string, meta: Record<string, unknown>): Promise<void>;
}

export function dbGoogleBusinessBackend(
  opts: { fetchImpl?: FetchLike } = {},
): GoogleBusinessBackend {
  return {
    async credential(accountId, profileId) {
      const env = googleBusinessEnv();
      if (!env) return { refused: "Google Business Profile isn't set up on ScaleX yet." };
      const row = await activeExecutionConnection(accountId, GOOGLE_PROVIDER);
      if (!row) {
        return {
          refused:
            "Google Business Profile isn't connected. Connect it on Connections; nothing was sent to Google.",
        };
      }
      if (row.status !== "connected") {
        return {
          refused:
            "Google stopped accepting ScaleX's access. Reconnect Google Business Profile on Connections; nothing was sent to Google.",
        };
      }
      if (!(await googleWriteConsentCurrent(accountId))) return { refused: GOOGLE_RECONSENT };
      const secret = readGoogleSecret(executionSecret(row));
      const [profile] = await db
        .select({ id: businessProfiles.id })
        .from(businessProfiles)
        .where(and(eq(businessProfiles.id, profileId), eq(businessProfiles.account_id, accountId)));
      if (!profile || secret.profile_id !== profileId) {
        return {
          refused:
            "The Google connection belongs to another business on this account. Nothing was sent to Google.",
        };
      }
      try {
        const tokens = await refreshAccess(env, secret.refresh_token, opts.fetchImpl);
        return {
          access_token: tokens.access_token,
          account: secret.account,
          location: secret.location,
          title: secret.title,
        };
      } catch (error) {
        if (error instanceof GbpRequestError && error.kind === "auth") {
          return {
            refused:
              "Google no longer accepts ScaleX's access. Reconnect Google Business Profile on Connections; nothing was sent to Google.",
          };
        }
        throw error;
      }
    },

    async changed(profileId, detail, meta) {
      await db
        .insert(watchActivity)
        .values({ profile_id: profileId, kind: "listing_changed", detail, meta });
    },
  };
}
