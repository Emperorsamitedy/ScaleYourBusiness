// The pipeline API — Phase 5 Session D (P5-14..17).
//
//   GET  /api/pipeline   the deals by stage with value and age, the stale list
//                        with each one's follow-up state, the weighted value as a
//                        range (or why not), and the win rate it rests on
//   POST /api/pipeline {action:"add", deal}                 a deal, with a contact
//   POST /api/pipeline {action:"update", deal_id, change}   stage, value, next step, spoke today
//   POST /api/pipeline {action:"import", csv, status, statement, currency?, value_basis?}
//        P4-03's attestation: new contacts land under the owner's own statement
//   POST /api/pipeline {action:"propose_followups"}         stale deals → the approval queue
//   POST /api/pipeline {action:"draft_followup", proposal_id}  an approved follow-up → its draft
//
// Reading needs the intake cookie; every write needs a signed-in user. A
// business that sells only to consumers (PIPELINE_APPLIES, a condition over
// 6.1a) gets `applies: false` and nothing else, and every write is refused.
// Nothing here sends anything: a follow-up is a draft the owner sends
// themselves (rule 29).

import { type NextRequest, NextResponse } from "next/server";
import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { logSafeError } from "../../../lib/core/log-safe";
import type { Money } from "../../../lib/core/money";
import { readCurrentField } from "../../../lib/profile/field-store";
import type { ConsentStatus } from "../../../lib/crm/contacts";
import { ContactError } from "../../../lib/crm/contacts";
import { ProposalError } from "../../../lib/proposals/service";
import type { DealChange, DealValueInput, ValueBasis } from "../../../lib/pipeline/deals";
import {
  DealError,
  addDeal,
  dealFacts,
  dealValue,
  listDeals,
  pipelineApplies,
  updateDeal,
} from "../../../lib/pipeline/deals";
import type { FollowUpState } from "../../../lib/pipeline/followups";
import {
  draftFollowUp,
  fillName,
  followUpHold,
  followUpsFor,
  proposeFollowUps,
} from "../../../lib/pipeline/followups";
import { importDeals } from "../../../lib/pipeline/import";
import type {
  DealAge,
  StageAgeing,
  Staleness,
  Weighted,
  WinRate,
} from "../../../lib/pipeline/maths";
import {
  dealAge,
  stageAgeing,
  staleness,
  weightedValue,
  winRate,
} from "../../../lib/pipeline/maths";
import type { DealStage } from "../../../lib/pipeline/stages";
import {
  DEAL_STAGES,
  STAGE_LABELS,
  WIN_RATE_KEY,
  WIN_RATE_QUESTION,
  isDealStage,
  isOpenStage,
} from "../../../lib/pipeline/stages";

/** Won and lost deals stay on the board this long after they close. */
const CLOSED_SHOWN_DAYS = 90;

export interface DealCardView {
  id: string;
  /** The company, else the contact's name — never their address. */
  who: string;
  contact_name: string | null;
  title: string;
  stage: DealStage;
  value: Money | null;
  value_basis: ValueBasis | null;
  expected_close: string | null;
  next_step: string | null;
  next_step_due: string | null;
  age: DealAge;
  stale: Staleness | null;
  closed_at: string | null;
}

export interface StaleView {
  deal: DealCardView;
  /** The follow-up proposal for this deal, newest, with its draft filled for reading. */
  followup: (FollowUpState & { filled: string | null }) | null;
}

export interface PipelineView {
  applies: boolean;
  today?: string;
  columns?: { stage: DealStage; label: string; deals: DealCardView[] }[];
  ageing?: StageAgeing[];
  stale?: StaleView[];
  win_rate?: WinRate;
  weighted?: Weighted;
  win_rate_question?: string;
  /** Why follow-ups can't be proposed now, or null. */
  held?: string | null;
  counts?: { open: number; closed_shown: number; total: number };
}

function onError(error: unknown, accountId: string | null): NextResponse {
  if (
    error instanceof DealError ||
    error instanceof ContactError ||
    error instanceof ProposalError
  ) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(
    JSON.stringify({ event: "pipeline_error", account_id: accountId, ...logSafeError(error) }),
  );
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

async function statedWinRate(profileId: string): Promise<number | null> {
  const f = await readCurrentField<unknown>(profileId, WIN_RATE_KEY);
  return f && f.status === "answered" && typeof f.value === "number" ? f.value : null;
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    if (!(await pipelineApplies(access.profile_id))) {
      return NextResponse.json({ applies: false } satisfies PipelineView);
    }
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const [rows, stated, followups, held] = await Promise.all([
      listDeals(access.profile_id),
      statedWinRate(access.profile_id),
      followUpsFor(access.profile_id),
      followUpHold(access.profile_id, now),
    ]);
    const facts = rows.map((r) => dealFacts(r.deal));
    const cards: DealCardView[] = rows.map((r, i) => ({
      id: r.deal.id,
      who: r.deal.company?.trim() || r.contact.name?.trim() || "a contact with no name",
      contact_name: r.contact.name,
      title: r.deal.title,
      stage: r.deal.stage,
      value: dealValue(r.deal),
      value_basis: (r.deal.value_basis as ValueBasis | null) ?? null,
      expected_close: r.deal.expected_close,
      next_step: r.deal.next_step,
      next_step_due: r.deal.next_step_due,
      age: dealAge(facts[i]!, today),
      stale: staleness(facts[i]!, today),
      closed_at: r.deal.closed_at,
    }));
    const shown = cards.filter(
      (c) =>
        isOpenStage(c.stage) ||
        (c.closed_at !== null &&
          Date.parse(`${today}T00:00:00Z`) - Date.parse(c.closed_at) <=
            CLOSED_SHOWN_DAYS * 86_400_000),
    );
    const rate = winRate({ deals: facts, stated, today });
    const stale: StaleView[] = cards
      .filter((c) => c.stale !== null)
      .sort((a, b) => b.age.days_quiet - a.age.days_quiet)
      .map((deal) => {
        const f = followups.find((x) => x.deal_id === deal.id) ?? null;
        return {
          deal,
          followup: f
            ? { ...f, filled: f.draft ? fillName(f.draft.body, deal.contact_name) : null }
            : null,
        };
      });
    const body: PipelineView = {
      applies: true,
      today,
      columns: DEAL_STAGES.map((stage) => ({
        stage,
        label: STAGE_LABELS[stage],
        deals: shown
          .filter((c) => c.stage === stage)
          .sort((a, b) => b.age.days_in_stage - a.age.days_in_stage),
      })),
      ageing: stageAgeing(facts, today),
      stale,
      win_rate: rate,
      weighted: weightedValue(facts, rate),
      win_rate_question: WIN_RATE_QUESTION,
      held,
      counts: {
        open: cards.filter((c) => isOpenStage(c.stage)).length,
        closed_shown: shown.filter((c) => !isOpenStage(c.stage)).length,
        total: cards.length,
      },
    };
    return NextResponse.json(body);
  } catch (error) {
    return onError(error, access.account_id);
  }
}

const CONSENT: readonly ConsentStatus[] = [
  "explicit_consent",
  "implied_consent",
  "no_consent",
  "unsure",
];

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function parseValue(v: unknown): DealValueInput | null {
  if (v === null || v === undefined) return null;
  const o = v as { amount_minor?: unknown; currency?: unknown; basis?: unknown };
  return {
    amount_minor: typeof o.amount_minor === "number" ? o.amount_minor : Number.NaN,
    currency: str(o.currency) ?? "",
    basis: (str(o.basis) ?? "") as ValueBasis,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const session = await matchingSession();
  if (!session) {
    return NextResponse.json(
      { error: "changing your pipeline needs you signed in" },
      { status: 401 },
    );
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    switch (body.action) {
      case "add": {
        const d = (body.deal ?? {}) as Record<string, unknown>;
        const stage = d.stage === undefined ? "lead" : d.stage;
        if (!isDealStage(stage)) {
          return NextResponse.json({ error: "that isn't a pipeline stage" }, { status: 422 });
        }
        const row = await addDeal(access.account_id, access.profile_id, {
          contact: { name: str(d.contact_name), email: str(d.email), phone: str(d.phone) },
          company: str(d.company),
          title: str(d.title) ?? "",
          stage,
          value: parseValue(d.value),
          expected_close: str(d.expected_close),
          next_step: str(d.next_step),
          next_step_due: str(d.next_step_due),
          last_contact_at: str(d.last_contact_at),
        });
        return NextResponse.json({ deal_id: row.id }, { status: 201 });
      }
      case "update": {
        if (typeof body.deal_id !== "string") {
          return NextResponse.json({ error: "deal_id is required" }, { status: 422 });
        }
        if (!(await pipelineApplies(access.profile_id))) {
          return NextResponse.json({ error: "no pipeline here" }, { status: 409 });
        }
        const c = (body.change ?? {}) as Record<string, unknown>;
        const change: DealChange = {};
        if (c.stage !== undefined) {
          if (!isDealStage(c.stage)) {
            return NextResponse.json({ error: "that isn't a pipeline stage" }, { status: 422 });
          }
          change.stage = c.stage;
        }
        if (c.value !== undefined) change.value = parseValue(c.value);
        if (c.next_step !== undefined) {
          const n = (c.next_step ?? {}) as Record<string, unknown>;
          change.next_step = { text: str(n.text), due: str(n.due) };
        }
        if (c.expected_close !== undefined) change.expected_close = str(c.expected_close);
        if (c.contacted !== undefined) {
          change.contacted = { on: str((c.contacted as { on?: unknown } | null)?.on) };
        }
        const row = await updateDeal(access.account_id, body.deal_id, change);
        return NextResponse.json({ deal_id: row.id, stage: row.stage });
      }
      case "import": {
        if (typeof body.csv !== "string" || typeof body.statement !== "string") {
          return NextResponse.json({ error: "csv and statement are required" }, { status: 422 });
        }
        const status = CONSENT.find((s) => s === body.status);
        if (!status) {
          return NextResponse.json(
            {
              error: "status must be one of explicit_consent, implied_consent, no_consent, unsure",
            },
            { status: 422 },
          );
        }
        const basis = body.value_basis === "quoted" ? "quoted" : "estimated";
        const result = await importDeals(
          access.account_id,
          access.profile_id,
          body.csv,
          { status, statement: body.statement },
          {
            ...(typeof body.currency === "string" && body.currency.trim() !== ""
              ? { currency: body.currency }
              : {}),
            value_basis: basis,
          },
        );
        const { rows, ...summary } = result;
        return NextResponse.json({ ...summary, rows: rows.length }, { status: 201 });
      }
      case "propose_followups": {
        const out = await proposeFollowUps(access.profile_id);
        return NextResponse.json({
          created: out.created.length,
          blocked: out.blocked.length,
          skipped: out.skipped,
        });
      }
      case "draft_followup": {
        if (typeof body.proposal_id !== "string") {
          return NextResponse.json({ error: "proposal_id is required" }, { status: 422 });
        }
        const { draft, fresh } = await draftFollowUp(body.proposal_id, {
          expectedProfileId: access.profile_id,
        });
        return NextResponse.json({ draft_id: draft.id, fresh }, { status: fresh ? 201 : 200 });
      }
      default:
        return NextResponse.json(
          {
            error:
              'action must be "add", "update", "import", "propose_followups" or "draft_followup"',
          },
          { status: 422 },
        );
    }
  } catch (error) {
    return onError(error, access.account_id);
  }
}
