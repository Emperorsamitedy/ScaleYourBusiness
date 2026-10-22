// The slow-stock API — feature 34.
//
//   GET  /api/stock                                   what isn't selling, ranked by cash tied up,
//                                                     each item's ranked ways to clear it, and the
//                                                     proposal each option already has
//   POST /api/stock {action:"import", csv, currency?, window_days?, as_of?}
//                                                     a stock file, for a business with no store
//   POST /api/stock {action:"propose"}                put the options in the approval queue
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
import { StockImportError, importStockFile } from "../../../lib/stock/import";
import { loadStock, stockApplies } from "../../../lib/stock/load";
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
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    if (!(await stockApplies(access.profile_id))) {
      return NextResponse.json({ applies: false } satisfies StockView);
    }
    const now = new Date();
    const view = await loadStock(access.account_id, access.profile_id, now);
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
        ...(typeof body.as_of === "string" && body.as_of.trim() !== ""
          ? { as_of: body.as_of }
          : {}),
      });
      return NextResponse.json(result, { status: 201 });
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
