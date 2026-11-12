// What a partner does for a client — the v1 build spec §7.2's row actions
// and §7.3's white-label (P7-81). Each one asks the database's partner_may
// for its own scope first, and is written to the owner's audit trail as the
// partner's own action.
//
//   approveForClient   approve_actions: a queued proposal, decided by the
//                      partner as a named person (rule 12 holds: a human)
//   writeCommentary    read_diagnosis: firm-authored words on a report
//                      section, kept apart from SYB's and never touched by a
//                      re-run; an edit supersedes, nothing is overwritten
//   nudgeClient        manage_connectors: a notice in the owner's SYB asking
//                      them to connect something
//   whiteLabelReport   receive_reports: the latest report, co-branded
//                      "Prepared by [Firm] using SYB", with the commentary

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  diagnosisReports,
  fieldRecords,
  firmCommentary,
  firms,
  ownerNotices,
  proposals,
} from "../../db/schema";
import type { WhiteLabel } from "../../db/schema";
import { headlineMoneyAllowed } from "../diagnosis/diagnosis-grade";
import type { Grade } from "../core/grade";
import { approveProposal } from "../proposals/service";
import { logPartnerAction, partnerMay, requirePartner } from "./access";
import { requireFirm } from "./firm";

/** The report sections a firm may comment on. */
export const COMMENTARY_SECTIONS = [
  "summary",
  "findings",
  "recommendations",
  "gaps",
  "statement",
] as const;
export type CommentarySection = (typeof COMMENTARY_SECTIONS)[number];

export class PartnerActionError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "PartnerActionError";
    this.status = status;
  }
}

export async function approveForClient(args: {
  userId: string;
  profileId: string;
  proposalId: string;
}) {
  const { firm } = await requireFirm(args.userId, ["principal", "manager"]);
  await requirePartner(args.userId, args.profileId, "approve_actions");
  const row = await approveProposal({
    proposalId: args.proposalId,
    userId: args.userId,
    profileId: args.profileId,
    actor: "partner",
  });
  await logPartnerAction({
    profileId: args.profileId,
    userId: args.userId,
    firmId: firm.id,
    action: "approve",
    ref: row.id,
  });
  return row;
}

export async function writeCommentary(args: {
  userId: string;
  profileId: string;
  section: string;
  body: string;
}) {
  const { firm } = await requireFirm(args.userId);
  await requirePartner(args.userId, args.profileId, "read_diagnosis");
  if (!(COMMENTARY_SECTIONS as readonly string[]).includes(args.section))
    throw new PartnerActionError("no such section");
  const body = args.body.trim();
  if (body.length > 4_000) throw new PartnerActionError("keep a comment under 4,000 characters");
  const at = new Date().toISOString();
  const made = await db.transaction(async (tx) => {
    await tx
      .update(firmCommentary)
      .set({ superseded_at: at })
      .where(
        and(
          eq(firmCommentary.firm_id, firm.id),
          eq(firmCommentary.profile_id, args.profileId),
          eq(firmCommentary.section, args.section),
          isNull(firmCommentary.superseded_at),
        ),
      );
    if (body === "") return null; // an empty comment takes the old one down, kept
    const [row] = await tx
      .insert(firmCommentary)
      .values({
        firm_id: firm.id,
        profile_id: args.profileId,
        section: args.section,
        body,
        author_user_id: args.userId,
      })
      .returning();
    return row!;
  });
  await logPartnerAction({
    profileId: args.profileId,
    userId: args.userId,
    firmId: firm.id,
    action: "commentary",
    ref: args.section,
  });
  return made;
}

/** The live commentary of every firm with a mandate here, per section. */
export async function commentaryFor(profileId: string, firmId: string) {
  return db
    .select()
    .from(firmCommentary)
    .where(
      and(
        eq(firmCommentary.profile_id, profileId),
        eq(firmCommentary.firm_id, firmId),
        isNull(firmCommentary.superseded_at),
      ),
    );
}

export async function nudgeClient(args: { userId: string; profileId: string; what: string }) {
  const { firm } = await requireFirm(args.userId, ["principal", "manager"]);
  await requirePartner(args.userId, args.profileId, "manage_connectors");
  const what = args.what.trim().slice(0, 200);
  if (what === "") throw new PartnerActionError("say what to connect");
  await db.insert(ownerNotices).values({
    profile_id: args.profileId,
    kind: "partner_nudge",
    payload: { firm: firm.name, firm_id: firm.id, what },
  });
  await logPartnerAction({
    profileId: args.profileId,
    userId: args.userId,
    firmId: firm.id,
    action: "nudge",
    ref: what.slice(0, 40),
  });
}

export interface WhiteLabelReport {
  firm: { name: string; white_label: WhiteLabel };
  business: string | null;
  report: {
    generated_at: string;
    version: number;
    grade: Grade;
    findings: { title: string; detail: string; severity: string }[];
    recommendations: {
      title: string;
      low: { amount_minor: number; currency: string } | null;
      high: { amount_minor: number; currency: string } | null;
    }[];
    priced_gaps: unknown[];
  } | null;
  commentary: Partial<Record<CommentarySection, string>>;
}

/** §7.3: the co-branded report — receive_reports, and logged as the partner's action. */
export function whiteLabelReport(args: {
  userId: string;
  profileId: string;
}): Promise<WhiteLabelReport> {
  return reportFor({ ...args, scope: "receive_reports", log: true });
}

/**
 * The console's client page: the same report, commentary and branding,
 * read under read_diagnosis; plus what the partner may do there and the
 * proposals waiting (only with approve_actions).
 */
export async function clientView(args: { userId: string; profileId: string }) {
  const report = await reportFor({ ...args, scope: "read_diagnosis", log: false });
  const scopes = {
    approve: await partnerMay(args.userId, args.profileId, "approve_actions"),
    connectors: await partnerMay(args.userId, args.profileId, "manage_connectors"),
    reports: await partnerMay(args.userId, args.profileId, "receive_reports"),
  };
  const waiting = scopes.approve
    ? await db
        .select({ id: proposals.id, action: proposals.action, created_at: proposals.created_at })
        .from(proposals)
        .where(and(eq(proposals.profile_id, args.profileId), eq(proposals.status, "pending")))
        .orderBy(desc(proposals.created_at))
    : [];
  return {
    ...report,
    scopes,
    waiting: waiting.map((w) => ({
      id: w.id,
      summary:
        typeof (w.action as { summary?: unknown })?.summary === "string"
          ? (w.action as { summary: string }).summary
          : "",
    })),
  };
}

async function reportFor(args: {
  userId: string;
  profileId: string;
  scope: "receive_reports" | "read_diagnosis";
  log: boolean;
}): Promise<WhiteLabelReport> {
  const { firm } = await requireFirm(args.userId);
  await requirePartner(args.userId, args.profileId, args.scope);
  const [[latest], [name], live, [f]] = await Promise.all([
    db
      .select()
      .from(diagnosisReports)
      .where(eq(diagnosisReports.profile_id, args.profileId))
      .orderBy(desc(diagnosisReports.generated_at))
      .limit(1),
    db
      .select({ value: fieldRecords.value })
      .from(fieldRecords)
      .where(
        and(
          eq(fieldRecords.profile_id, args.profileId),
          eq(fieldRecords.field_key, "identity.business_name"),
          isNull(fieldRecords.superseded_at),
        ),
      ),
    commentaryFor(args.profileId, firm.id),
    db.select().from(firms).where(eq(firms.id, firm.id)),
  ]);
  if (args.log) {
    await logPartnerAction({
      profileId: args.profileId,
      userId: args.userId,
      firmId: firm.id,
      action: "report",
      ref: latest?.id ?? "none",
    });
  }
  const grade = (
    ["A", "B", "C", "D"].includes(String(latest?.diagnosis_grade)) ? latest!.diagnosis_grade : "D"
  ) as Grade;
  const money = headlineMoneyAllowed(grade);
  const recs = (latest?.recommendations ?? []) as {
    title: string;
    scenario?: {
      downside_case?: { profit_delta_monthly?: { amount_minor: number; currency: string } | null };
      upside_case?: { profit_delta_monthly?: { amount_minor: number; currency: string } | null };
    };
  }[];
  return {
    firm: { name: f!.name, white_label: f!.white_label },
    business: typeof name?.value === "string" ? name.value : null,
    report: latest
      ? {
          generated_at: latest.generated_at,
          version: latest.version ?? 1,
          grade,
          findings: (latest.findings as { title: string; detail: string; severity: string }[]).map(
            (x) => ({
              title: x.title,
              detail: x.detail,
              severity: x.severity,
            }),
          ),
          // §6.2: money leads only at A or B, on the firm's copy as on the owner's.
          recommendations: recs.map((r) => ({
            title: r.title,
            low: money ? (r.scenario?.downside_case?.profit_delta_monthly ?? null) : null,
            high: money ? (r.scenario?.upside_case?.profit_delta_monthly ?? null) : null,
          })),
          priced_gaps: (latest.priced_gaps as unknown[] | null) ?? [],
        }
      : null,
    commentary: Object.fromEntries(live.map((c) => [c.section, c.body])) as Partial<
      Record<CommentarySection, string>
    >,
  };
}
