// The stock API — feature 34 (slow stock) and Phase 5 Session A (what runs out).
//
//   GET  /api/stock                                   what isn't selling, ranked by cash tied up,
//                                                     each item's ranked ways to clear it, and the
//                                                     proposal each option already has; and every
//                                                     item's days of cover against its delivery
//                                                     time, the stock-out warnings and the reorder
//                                                     notes (P5-05)
//   POST /api/stock {action:"import", csv, currency?, window_days?, as_of?, decimal_style?}
//                                                     a stock file, for a business with no store
//   POST /api/stock {action:"propose"}                put the options in the approval queue
//   POST /api/stock {action:"reorder"}                put the reorder notes in the approval queue —
//                                                     notes only: nothing is ever ordered (rule 27)
//
// Reading needs the intake cookie; importing and proposing need a signed-in
// user (an import is the owner's figures under their name; a proposal lands
// in the queue). A business that holds no stock (STOCK_APPLIES, data over
// the bank's own answers) gets `applies: false` and nothing else. Nothing
// here executes anything: proposals wait for the owner (rule 12).

import { inArray, and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { proposals } from "../../../db/schema";
import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { careState } from "../../../lib/care/day-zero";
import { logSafeError } from "../../../lib/core/log-safe";
import { STOCK } from "../../../lib/stock/assess";
import { isDecimalStyle } from "../../../lib/core/money";
import { StockImportError, importStockFile } from "../../../lib/stock/import";
import { stockApplies } from "../../../lib/stock/load";
import type { CoverFlag } from "../../../lib/stock/cover";
import { COVER, coverColumn, coverFlag } from "../../../lib/stock/cover";
import { loadCover } from "../../../lib/stock/cover-load";
import { proposeReorders, reorderRef } from "../../../lib/stock/reorder";
import { loadStockHistory } from "../../../lib/charts/load";
import type { StockHistoryModel } from "../../../lib/charts/stock-history";
import { CLEARANCE, efficiencyLine } from "../../../lib/stock/options";
import {
  fmtFor,
  optionRef,
  optionsFor,
  proposeClearance,
  sharedContext,
} from "../../../lib/stock/propose";

/** How many slow items the screen lists. */
const SHOWN = 25;

export interface StockOptionView {
  key: string;
  label: string;
  unavailable: string | null;
  recovered: { low: number; high: number; expected: number };
  given_up: { low: number; high: number; expected: number };
  per_euro: number | null;
  efficiency: string;
  arithmetic: string;
  reversibility: string;
  /** The proposal this option already has this month, if any. */
  proposal: { id: string; status: string; blocked_by_limit: string | null } | null;
}

export interface StockItemView {
  key: string;
  name: string;
  source: string;
  as_of: string;
  on_hand: number;
  sold: { 30: number | null; 60: number | null; 90: number | null };
  days_of_cover: number | null;
  days_since_sale: number | null;
  no_sale_for_at_least: number | null;
  cash_tied_minor: number | null;
  value_at_price_minor: number | null;
  currency: string | null;
  cost_basis: "measured" | "stated" | null;
  flag: "STUCK" | "SLOW";
  why: string;
  /** Proposals are made for the top items only (CLEARANCE.max_items). */
  proposed_for: boolean;
  options: StockOptionView[];
}

/** One item's days of cover, as the /stock screen shows it (P5-05). */
export interface CoverItemView {
  key: string;
  name: string;
  source: string;
  as_of: string;
  on_hand: number;
  /** Units sold in the last 28 days; null when not measured. */
  sold_recent: number | null;
  /** Window A against window B (P5-01), when two windows are measured. */
  vs_prior: { change: number; band: number; direction: "up" | "down" | "flat" } | null;
  sell_through: string;
  /** "9–10", "sold out", "—". */
  cover_text: string;
  runs_out: { earliest: string; latest: string | null } | null;
  lead: { days: number; basis: "stated" | "assumed"; supplier: string | null; why: string };
  flag: CoverFlag;
  warning: string | null;
  /** Why it isn't judged, when it isn't. */
  why: string | null;
  boosted: boolean;
  reorder: {
    quantity: number;
    arithmetic: string;
    moq: number | null;
    rounded_to_moq: boolean;
    cost: { amount_minor: number; currency: string } | null;
    cost_arithmetic: string | null;
    proposal: { id: string; status: string; blocked_by_limit: string | null } | null;
  } | null;
  assumed: string[];
  sources: string;
}

export interface CoverBlock {
  window_days: number;
  default_lead_days: number;
  /** Warned items first (ACT NOW, then the soonest out), then the rest by cover. */
  items: CoverItemView[];
  warnings: number;
  /** The busy-season line: what was counted, or why nothing was. */
  season: string;
  /** Why reorder notes can't be proposed yet, when they can't (rule 15). */
  held: string | null;
}

export interface StockView {
  applies: boolean;
  today?: string;
  sources?: { label: string; as_of: string | null; items: number }[];
  counted?: number;
  slow?: StockItemView[];
  totals?: { currency: string; cash_tied_minor: number; items: number; unknown_cost: number }[];
  stated_dead_stock?: { amount_minor: number; currency: string } | null;
  thresholds?: { stuck_no_sale_days: number; slow_cover_days: number; max_items: number };
  /** Why proposals can't be made yet, when they can't (rule 15). */
  held?: string | null;
  /** Cash tied up per slow item on each stock count, when there are two counts or more. */
  history?: StockHistoryModel | null;
  /** P5-05: what runs out, and when. */
  cover?: CoverBlock;
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    if (!(await stockApplies(access.profile_id))) {
      return NextResponse.json({ applies: false } satisfies StockView);
    }
    const now = new Date();
    const coverView = await loadCover(access.account_id, access.profile_id, now);
    const view = coverView.stock;
    const shared = await sharedContext(access.profile_id, access.account_id, now);
    const care = await careState(access.profile_id);
    const held = !care
      ? "I propose ways to clear it once you've chosen how I work for you."
      : care.watch_ends_at && now.toISOString() < care.watch_ends_at
        ? `I'm watching until ${care.watch_ends_at.slice(0, 10)}, and I propose nothing before then.`
        : null;

    const shown = view.slow.slice(0, SHOWN);
    const refs = shown.flatMap((r) =>
      (["content", "bundle", "email", "markdown", "selloff"] as const).map((k) =>
        optionRef(r, k, now),
      ),
    );
    const existing =
      refs.length === 0
        ? []
        : await db
            .select({
              id: proposals.id,
              ref: proposals.originating_finding,
              status: proposals.status,
              blocked_by_limit: proposals.blocked_by_limit,
            })
            .from(proposals)
            .where(
              and(
                eq(proposals.profile_id, access.profile_id),
                inArray(proposals.originating_finding, [...new Set(refs)]),
              ),
            );
    const byRef = new Map(existing.map((p) => [p.ref, p]));

    // P5-05: every item's cover, warned items first, with any reorder note it has.
    const warnedKeys = new Set(coverView.warnings.map((r) => r.key));
    const coverRows = [
      ...coverView.warnings,
      ...coverView.rows
        .filter((r) => !warnedKeys.has(r.key))
        .sort(
          (a, b) =>
            (a.cover.cover?.low ?? Infinity) - (b.cover.cover?.low ?? Infinity) ||
            (a.name < b.name ? -1 : 1),
        ),
    ];
    const noteRefs = coverView.warnings.map((r) => reorderRef(r, now));
    const notes =
      noteRefs.length === 0
        ? []
        : await db
            .select({
              id: proposals.id,
              ref: proposals.originating_finding,
              status: proposals.status,
              blocked_by_limit: proposals.blocked_by_limit,
            })
            .from(proposals)
            .where(
              and(
                eq(proposals.profile_id, access.profile_id),
                inArray(proposals.originating_finding, noteRefs),
              ),
            );
    const noteByRef = new Map(notes.map((p) => [p.ref, p]));
    const cover: CoverBlock = {
      window_days: COVER.window_days,
      default_lead_days: COVER.default_lead_days,
      warnings: coverView.warnings.length,
      season: coverView.season_note,
      held: !care
        ? "I put reorder notes in your queue once you've chosen how I work for you."
        : care.watch_ends_at && now.toISOString() < care.watch_ends_at
          ? `I'm watching until ${care.watch_ends_at.slice(0, 10)}, and I propose nothing before then.`
          : null,
      items: coverRows.map((r) => {
        const c = r.cover;
        const st = c.sell_through;
        const note = noteByRef.get(reorderRef(r, now));
        return {
          key: r.key,
          name: r.name,
          source: r.source,
          as_of: r.item.as_of,
          on_hand: r.item.on_hand,
          sold_recent:
            st.status === "ready"
              ? st.a.units
              : c.rate && c.rate.over_days === COVER.window_days
                ? c.rate.units
                : null,
          vs_prior:
            st.status === "ready"
              ? { change: st.change, band: st.band, direction: st.direction }
              : null,
          sell_through: st.sentence,
          cover_text: coverColumn(c),
          runs_out: c.runs_out,
          lead: {
            days: c.lead.days,
            basis: c.lead.basis,
            supplier: c.lead.supplier?.name ?? null,
            why: c.lead.why,
          },
          flag: coverFlag(c),
          warning: c.warning?.sentence ?? null,
          why: c.why,
          boosted: c.boosted,
          reorder: c.reorder
            ? {
                quantity: c.reorder.quantity,
                arithmetic: c.reorder.arithmetic,
                moq: c.reorder.moq,
                rounded_to_moq: c.reorder.rounded_to_moq,
                cost: c.reorder.cost,
                cost_arithmetic: c.reorder.cost_arithmetic,
                proposal: note
                  ? { id: note.id, status: note.status, blocked_by_limit: note.blocked_by_limit }
                  : null,
              }
            : null,
          assumed: c.assumed,
          sources: c.sources,
        };
      }),
    };

    const slow: StockItemView[] = shown.map((r, i) => {
      const fmt = fmtFor(r.item.currency);
      return {
        key: `${r.item.connection_id}:${r.item.ref}`,
        name: r.item.name,
        source: view.sources.find((s) => s.connection_id === r.item.connection_id)?.label ?? "",
        as_of: r.item.as_of,
        on_hand: r.item.on_hand,
        sold: r.assessment.sold,
        days_of_cover:
          r.assessment.days_of_cover === null ? null : Math.round(r.assessment.days_of_cover),
        days_since_sale: r.assessment.days_since_sale,
        no_sale_for_at_least: r.assessment.no_sale_for_at_least,
        cash_tied_minor: r.assessment.cash_tied_minor,
        value_at_price_minor: r.item.value_at_price,
        currency: r.item.currency,
        cost_basis: r.item.cost_basis,
        flag: r.assessment.flag!,
        why: r.assessment.why,
        proposed_for: i < CLEARANCE.max_items,
        options: optionsFor(r, view, shared).map((o) => {
          const p = byRef.get(optionRef(r, o.key, now));
          return {
            key: o.key,
            label: o.label,
            unavailable: o.unavailable,
            recovered: o.recovered,
            given_up: o.given_up,
            per_euro: o.per_euro,
            efficiency: efficiencyLine(o, fmt),
            arithmetic: o.arithmetic,
            reversibility: o.reversibility.if_you_change_your_mind,
            proposal: p
              ? { id: p.id, status: p.status, blocked_by_limit: p.blocked_by_limit }
              : null,
          };
        }),
      };
    });

    const totals = new Map<string, { cash: number; items: number; unknown: number }>();
    for (const r of view.slow) {
      const c = r.item.currency ?? "";
      const t = totals.get(c) ?? { cash: 0, items: 0, unknown: 0 };
      t.items++;
      if (r.assessment.cash_tied_minor === null) t.unknown++;
      else t.cash += r.assessment.cash_tied_minor;
      totals.set(c, t);
    }

    const body: StockView = {
      applies: true,
      today: view.today,
      sources: view.sources.map((s) => ({ label: s.label, as_of: s.as_of, items: s.items })),
      counted: view.items.length,
      slow,
      totals: [...totals.entries()]
        .filter(([c]) => c !== "")
        .map(([currency, t]) => ({
          currency,
          cash_tied_minor: t.cash,
          items: t.items,
          unknown_cost: t.unknown,
        })),
      stated_dead_stock: view.stated_dead_stock,
      thresholds: {
        stuck_no_sale_days: STOCK.stuck_no_sale_days,
        slow_cover_days: STOCK.slow_cover_days,
        max_items: CLEARANCE.max_items,
      },
      held,
      cover,
      history: await loadStockHistory(
        view.slow.map((r) => ({
          connection_id: r.item.connection_id,
          ref: r.item.ref,
          name: r.item.name,
        })),
      ),
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "stock_view_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  if (!(await matchingSession())) {
    return NextResponse.json(
      { error: "importing or proposing needs you signed in" },
      { status: 401 },
    );
  }
  try {
    if (!(await stockApplies(access.profile_id))) {
      return NextResponse.json({ error: "your business doesn't hold stock" }, { status: 409 });
    }
    const body = (await request.json()) as {
      action?: unknown;
      csv?: unknown;
      currency?: unknown;
      window_days?: unknown;
      as_of?: unknown;
      decimal_style?: unknown;
    };
    if (body.action === "import") {
      if (typeof body.csv !== "string") {
        return NextResponse.json({ error: "csv is required" }, { status: 422 });
      }
      const windowDays =
        typeof body.window_days === "number"
          ? body.window_days
          : typeof body.window_days === "string" && body.window_days.trim() !== ""
            ? Number(body.window_days)
            : undefined;
      const result = await importStockFile(access.account_id, body.csv, {
        ...(typeof body.currency === "string" ? { currency: body.currency } : {}),
        ...(windowDays !== undefined ? { window_days: windowDays } : {}),
        ...(isDecimalStyle(body.decimal_style) ? { decimal_style: body.decimal_style } : {}),
        ...(typeof body.as_of === "string" && body.as_of.trim() !== ""
          ? { as_of: body.as_of }
          : {}),
      });
      return NextResponse.json(result, { status: 201 });
    }
    if (body.action === "reorder") {
      const run = await proposeReorders(access.profile_id);
      return NextResponse.json({
        created: run.created.length,
        blocked: run.blocked.length,
        skipped: run.skipped,
      });
    }
    if (body.action === "propose") {
      const run = await proposeClearance(access.profile_id);
      return NextResponse.json({
        created: run.created.length,
        blocked: run.blocked.length,
        skipped: run.skipped,
      });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 422 });
  } catch (error) {
    if (error instanceof StockImportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "stock_post_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
