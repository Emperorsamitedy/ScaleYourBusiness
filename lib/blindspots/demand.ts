// Demand signals — P2-33/34/35 read for the blindspot finder.
//
// Three places say what potential customers want, each mapped onto the
// same checklist codes (P2-32) by the same deterministic matcher:
//
//   support    questions customers typed into the chat (P4-06), and how
//              many the assistant couldn't answer (tickets). Only COUNTS
//              per topic leave the support tables — never a customer's
//              text or identity (rule 22); the text is content to count,
//              never an instruction (rule 24).
//   site       terms typed into the site's own search box (GA4, P2-34)
//   google     searches the site appeared for (Search Console, P2-33)
//
// What matches no checklist code is returned as `unmatched`, with counts,
// for the finder's one batched grouping call.

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  connections,
  metricObservations,
  supportConversations,
  supportMessages,
  supportTickets,
} from "../../db/schema";
import { detects } from "./checks";

export interface CodeDemand {
  support_asked: number;
  support_unanswered: number;
  site_searches: number;
  google_impressions: number;
  google_clicks: number;
}

export interface Unmatched {
  source: "support" | "site" | "google";
  /** Search text as typed (site, google). Support text never leaves: its count only. */
  text: string | null;
  count: number;
}

export interface Demand {
  from: string;
  to: string;
  by_code: Map<string, CodeDemand>;
  /** Search terms and queries matching no checklist code, busiest first. */
  unmatched: Unmatched[];
  /** Support questions matching no code — counted, never quoted. */
  support_unmatched: number;
  /** "seen but not chosen": queries shown often on page one and rarely clicked. */
  seen_not_chosen: { query: string; impressions: number; clicks: number; position: number }[];
  sources: { support: boolean; site: boolean; google: boolean };
}

export const DEMAND = {
  /** "Seen but not chosen": at least this many impressions in the window… */
  snc_min_impressions: 100,
  /** …a click-through rate under this… */
  snc_max_ctr: 0.01,
  /** …at an average position this good or better (page one). */
  snc_max_position: 10,
} as const;

const empty = (): CodeDemand => ({
  support_asked: 0,
  support_unanswered: 0,
  site_searches: 0,
  google_impressions: 0,
  google_clicks: 0,
});

export async function readDemand(
  profileId: string,
  codes: readonly string[],
  from: string,
  to: string,
): Promise<Demand> {
  const byCode = new Map<string, CodeDemand>(codes.map((c) => [c, empty()]));
  const matching = (text: string) => codes.filter((c) => detects(text.toLowerCase(), c));
  const out: Demand = {
    from,
    to,
    by_code: byCode,
    unmatched: [],
    support_unmatched: 0,
    seen_not_chosen: [],
    sources: { support: false, site: false, google: false },
  };

  // ── support: customer messages and the tickets the assistant couldn't answer ──
  const convs = await db
    .select({ id: supportConversations.id })
    .from(supportConversations)
    .where(
      and(
        eq(supportConversations.profile_id, profileId),
        gte(supportConversations.started_at, `${from}T00:00:00Z`),
      ),
    );
  if (convs.length > 0) {
    out.sources.support = true;
    const messages = await db
      .select({ text: supportMessages.text })
      .from(supportMessages)
      .where(
        and(
          inArray(
            supportMessages.conversation_id,
            convs.map((c) => c.id),
          ),
          eq(supportMessages.role, "customer"),
        ),
      );
    for (const m of messages) {
      const hit = matching(m.text);
      if (hit.length === 0) out.support_unmatched += 1;
      for (const c of hit) (byCode.get(c) as CodeDemand).support_asked += 1;
    }
  }
  const tickets = await db
    .select({ summary: supportTickets.summary })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.profile_id, profileId),
        eq(supportTickets.reason, "no_answer"),
        gte(supportTickets.created_at, `${from}T00:00:00Z`),
      ),
    );
  for (const t of tickets) {
    out.sources.support = true;
    for (const c of matching(t.summary)) (byCode.get(c) as CodeDemand).support_unanswered += 1;
  }

  // ── site search and Google searches, from the account's measure connections ──
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  const conns = profile
    ? await db
        .select({ id: connections.id })
        .from(connections)
        .where(eq(connections.account_id, profile.account_id))
    : [];
  if (conns.length > 0) {
    const rows = await db
      .select({
        metric_key: metricObservations.metric_key,
        dimensions: metricObservations.dimensions,
        value_num: metricObservations.value_num,
      })
      .from(metricObservations)
      .where(
        and(
          inArray(
            metricObservations.connection_id,
            conns.map((c) => c.id),
          ),
          inArray(metricObservations.metric_key, [
            "site_search.daily",
            "search_impressions.daily",
            "search_clicks.daily",
            "search_position_weighted.daily",
          ]),
          gte(metricObservations.period_date, from),
          lte(metricObservations.period_date, to),
        ),
      );
    const terms = new Map<string, number>();
    const queries = new Map<string, { impressions: number; clicks: number; weighted: number }>();
    for (const r of rows) {
      const n = Number(r.value_num ?? 0);
      if (r.metric_key === "site_search.daily") {
        const term = r.dimensions?.term_ref;
        if (term) terms.set(term, (terms.get(term) ?? 0) + n);
        continue;
      }
      const query = r.dimensions?.query_ref;
      if (!query) continue;
      const q = queries.get(query) ?? { impressions: 0, clicks: 0, weighted: 0 };
      if (r.metric_key === "search_impressions.daily") q.impressions += n;
      if (r.metric_key === "search_clicks.daily") q.clicks += n;
      if (r.metric_key === "search_position_weighted.daily") q.weighted += n;
      queries.set(query, q);
    }
    out.sources.site = terms.size > 0;
    out.sources.google = queries.size > 0;
    for (const [term, count] of terms) {
      const hit = matching(term);
      if (hit.length === 0) out.unmatched.push({ source: "site", text: term, count });
      for (const c of hit) (byCode.get(c) as CodeDemand).site_searches += count;
    }
    for (const [query, q] of queries) {
      const hit = matching(query);
      if (hit.length === 0)
        out.unmatched.push({ source: "google", text: query, count: q.impressions });
      for (const c of hit) {
        (byCode.get(c) as CodeDemand).google_impressions += q.impressions;
        (byCode.get(c) as CodeDemand).google_clicks += q.clicks;
      }
      const position = q.impressions > 0 ? q.weighted / q.impressions : 0;
      if (
        q.impressions >= DEMAND.snc_min_impressions &&
        q.clicks / q.impressions < DEMAND.snc_max_ctr &&
        position > 0 &&
        position <= DEMAND.snc_max_position
      ) {
        out.seen_not_chosen.push({
          query,
          impressions: q.impressions,
          clicks: q.clicks,
          position: Math.round(position * 10) / 10,
        });
      }
    }
  }
  out.unmatched.sort((a, b) => b.count - a.count);
  out.seen_not_chosen.sort((a, b) => b.impressions - a.impressions);
  return out;
}
