// From a reorder suggestion to a purchase order proposal — P6-04, rule 27 amended.
//
// The owner asks for it, on /stock: one supplier, the items it supplies that
// are running low (lib/stock/cover's warnings, each with its reorder
// arithmetic, P5-03), the quantities (the suggestion's, or the owner's own,
// and the order says which), the delivery address and the supplier's email.
// What goes in the queue is a PROPOSAL through the same path as every other
// (rule 12): the owner's standing rules first (rule 14; a limit that names
// the kind blocks it, visibly; manual limits ride along), then createProposal,
// which writes the proposal and its decision-log entry together. Nothing is
// sent here; approved, the engine sends it (lib/purchasing/send).
//
// Rule 2: the supplier's email is not in the question bank's supplier schema
// (1.4.1.3 asks for name, country, products, price, minimum order, delivery
// time, terms). It is recorded where an answer about that supplier would be,
// suppliers.<id>.email, as a stated fact with its provenance (owner input,
// superseded, never overwritten), and read back from there next time. The
// bank's structure is unchanged.
//
// Rule 15: nothing is proposed before a business is in care or while it is
// watched (the reorder note's own hold); the screen says when it can be.

import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, proposals } from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { readCurrentField, writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import {
  checkHardLimits,
  ensureHardLimits,
  limitCaption,
  liveLimitLlm,
} from "../proposals/hard-limits";
import type { NewProposal, ProposalRow } from "../proposals/service";
import type { CoverRow, CoverView } from "../stock/cover-load";
import { loadCover } from "../stock/cover-load";
import { STOCK_MODULE, createOnce, fmtFor } from "../stock/propose";
import { reorderHold } from "../stock/reorder";
import type { PoLine, PurchaseOrder, SuggestedLine } from "./po";
import {
  PO,
  PO_KIND,
  cleanText,
  normaliseEmail,
  poLine,
  poNumber,
  poSha256,
  poTotals,
  readQuantity,
} from "./po";

/** Where the business's own postal address is on file (11.1e). */
export const ADDRESS_FIELD = "legal.postal_address";
export const NAME_FIELD = "identity.legal_name";
/** The ref prefix a purchase order is deduped and numbered by, under the stock index (0053/0055). */
export const PO_REF_PREFIX = "stock:po:";

export const supplierEmailField = (supplierId: string) => `suppliers.${supplierId}.email`;

export class PurchaseOrderError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "PurchaseOrderError";
    this.status = status;
  }
}

/* ── reading what an order would hold ── */

/** Pure: a warned row's suggestion as an order line (unit cost as reorderFor works it out). */
export function suggestedLine(row: CoverRow): SuggestedLine | null {
  const r = row.cover.reorder;
  if (!r) return null;
  const { item } = row;
  const unit =
    item.value_at_cost !== null && item.currency !== null && item.on_hand > 0
      ? { amount_minor: Math.round(item.value_at_cost / item.on_hand), currency: item.currency }
      : null;
  return {
    key: `${item.connection_id}:${item.ref}`,
    name: item.name,
    suggested: r.quantity,
    arithmetic: r.arithmetic,
    unit_cost: unit,
    cost_basis: unit === null ? null : item.cost_basis,
  };
}

/** Pure: the warned rows a supplier's order is made from. */
export function rowsFor(view: Pick<CoverView, "warnings">, supplierId: string): CoverRow[] {
  return view.warnings.filter(
    (r) => r.cover.reorder !== null && r.cover.lead.supplier?.id === supplierId,
  );
}

export interface PoDraft {
  supplier: { id: string; name: string };
  /** The address on file for this supplier (rule 2), or null: the screen asks for it. */
  email: string | null;
  address: string | null;
  lines: SuggestedLine[];
  /** An order for this supplier still waiting or approved: one at a time. */
  open: { id: string; number: string; status: string } | null;
}

export interface PoDrafts {
  drafts: PoDraft[];
  /** Items running low with a reorder suggestion but no supplier on file: no order can name one. */
  unsupplied: string[];
}

async function answered(profileId: string, key: string): Promise<string | null> {
  const f = await readCurrentField<unknown>(profileId, key);
  return f?.status === "answered" && typeof f.value === "string" && f.value.trim() !== ""
    ? f.value.trim()
    : null;
}

/** The orders still open (pending or approved), by supplier id. */
async function openOrders(
  profileId: string,
): Promise<Map<string, { id: string; number: string; status: string }>> {
  const rows = await db
    .select({ id: proposals.id, status: proposals.status, action: proposals.action })
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        like(proposals.originating_finding, `${PO_REF_PREFIX}%`),
        inArray(proposals.status, ["pending", "approved"]),
      ),
    );
  const out = new Map<string, { id: string; number: string; status: string }>();
  for (const r of rows) {
    const po = (r.action as { detail?: { po?: PurchaseOrder } } | null)?.detail?.po;
    if (po?.supplier?.id)
      out.set(po.supplier.id, { id: r.id, number: po.number, status: r.status });
  }
  return out;
}

/**
 * What an order to each supplier would hold today, from a cover view already
 * read (the /stock screen passes its own, in the reader's words). Reads the
 * supplier's email and the business's address from the profile; writes nothing.
 */
export async function poDrafts(profileId: string, view: CoverView): Promise<PoDrafts> {
  const bySupplier = new Map<string, { name: string; rows: CoverRow[] }>();
  const unsupplied: string[] = [];
  for (const r of view.warnings) {
    if (r.cover.reorder === null) continue;
    const s = r.cover.lead.supplier;
    if (!s) {
      unsupplied.push(r.item.name);
      continue;
    }
    const entry = bySupplier.get(s.id) ?? { name: s.name, rows: [] };
    entry.rows.push(r);
    bySupplier.set(s.id, entry);
  }
  if (bySupplier.size === 0) return { drafts: [], unsupplied };
  const [address, open] = await Promise.all([
    answered(profileId, ADDRESS_FIELD),
    openOrders(profileId),
  ]);
  const drafts: PoDraft[] = [];
  for (const [id, { name, rows }] of bySupplier) {
    drafts.push({
      supplier: { id, name },
      email: await answered(profileId, supplierEmailField(id)),
      address,
      lines: rows.map(suggestedLine).filter((l): l is SuggestedLine => l !== null),
      open: open.get(id) ?? null,
    });
  }
  return { drafts, unsupplied };
}

/* ── making the proposal ── */

export interface ProposePoInput {
  profileId: string;
  supplierId: unknown;
  email: unknown;
  deliveryAddress?: unknown;
  note?: unknown;
  /** Line key → the owner's quantity. A line left out keeps the suggestion. */
  quantities?: unknown;
  /** Line keys to order; all of the supplier's lines when absent. */
  include?: unknown;
  now?: Date;
  limitLlm?: LimitLlm;
  /** Tests: a cover view in place of the one read now. */
  view?: CoverView;
}

/** Record the supplier's email as a stated fact (rule 2) — only when it is new or changed. */
async function recordSupplierEmail(profileId: string, supplierId: string, email: string) {
  const key = supplierEmailField(supplierId);
  if ((await answered(profileId, key)) === email) return;
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField({
      id: fieldId(key),
      value: email,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note: "given on a purchase order",
    }),
  );
}

/**
 * Put a purchase order in the queue. Throws PurchaseOrderError with the
 * owner's sentence when it can't: held (rule 15), nothing running low from
 * this supplier, an address that isn't one, an order already open.
 */
export async function proposePurchaseOrder(input: ProposePoInput): Promise<ProposalRow> {
  const now = input.now ?? new Date();
  const profileId = input.profileId;
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) throw new PurchaseOrderError("no such business", 404);
  const hold = await reorderHold(profileId, now);
  if (hold !== null) {
    throw new PurchaseOrderError(`No purchase order can be made yet: ${hold}.`, 409);
  }
  if (typeof input.supplierId !== "string" || input.supplierId === "") {
    throw new PurchaseOrderError("name the supplier the order goes to");
  }
  const supplierId = input.supplierId;
  const view = input.view ?? (await loadCover(profile.account_id, profileId, now));
  let rows = rowsFor(view, supplierId);
  if (Array.isArray(input.include)) {
    const keep = new Set(input.include.filter((k): k is string => typeof k === "string"));
    rows = rows.filter((r) => keep.has(`${r.item.connection_id}:${r.item.ref}`));
  }
  if (rows.length === 0) {
    throw new PurchaseOrderError(
      "Nothing this supplier supplies is running low right now, so there is nothing to order from them.",
      409,
    );
  }
  rows = rows.slice(0, PO.max_lines);
  const supplier = rows[0]!.cover.lead.supplier!;

  const email = normaliseEmail(input.email);
  if (email === null) {
    throw new PurchaseOrderError(
      `${supplier.name}'s email address doesn't look right. It needs to be one address, like orders@example.com.`,
    );
  }
  const typed = cleanText(input.deliveryAddress, PO.max_address);
  const onFile = typed === null ? await answered(profileId, ADDRESS_FIELD) : null;
  const address = typed ?? onFile;
  if (address === null) {
    throw new PurchaseOrderError("Say where the order should be delivered.");
  }
  const note = cleanText(input.note, PO.max_note);

  const quantities =
    input.quantities && typeof input.quantities === "object"
      ? (input.quantities as Record<string, unknown>)
      : {};
  const lines: PoLine[] = [];
  for (const r of rows) {
    const s = suggestedLine(r)!;
    const raw = Object.hasOwn(quantities, s.key) ? quantities[s.key] : undefined;
    const chosen = raw === undefined || raw === null || raw === "" ? null : readQuantity(raw);
    if (raw !== undefined && raw !== null && raw !== "" && chosen === null) {
      throw new PurchaseOrderError(`The quantity for ${s.name} needs to be a whole number from 1.`);
    }
    lines.push(poLine(s, chosen));
  }

  const open = (await openOrders(profileId)).get(supplierId);
  if (open) {
    throw new PurchaseOrderError(
      `There is already an order for ${supplier.name} (${open.number}) ${open.status === "pending" ? "waiting for your approval" : "approved and on its way out"}. Decide that one first.`,
      409,
    );
  }

  // Rule 2: the address the owner gave, recorded about the supplier.
  await recordSupplierEmail(profileId, supplierId, email);

  const { limits } = await ensureHardLimits(profileId, input.limitLlm ?? liveLimitLlm);
  const verdict = checkHardLimits(limits, PO_KIND);
  const business = (await answered(profileId, NAME_FIELD)) ?? "Your business";

  // The business's own sequence, raced safely by the stock index: a loser takes the next number.
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        like(proposals.originating_finding, `${PO_REF_PREFIX}%`),
      ),
    );
  for (let n = count + 1; n <= count + 3; n++) {
    const totals = poTotals(lines);
    const po: PurchaseOrder = {
      number: poNumber(n),
      business,
      supplier: {
        id: supplierId,
        name: supplier.name,
        email,
        email_field: supplierEmailField(supplierId),
      },
      lines,
      totals: totals.totals,
      unpriced: totals.unpriced,
      delivery_address: address,
      delivery_address_field: typed === null ? ADDRESS_FIELD : null,
      note,
      prepared_on: now.toISOString().slice(0, 10),
    };
    const row = await createOnce(
      purchaseOrderProposal(profileId, `${PO_REF_PREFIX}${n}`, po, rows, now, verdict),
    );
    if (row) {
      console.log(
        JSON.stringify({
          event: "purchase_order_proposed",
          account_id: profile.account_id,
          profile_id: profileId,
          proposal_id: row.id,
          lines: lines.length,
          blocked: row.status === "blocked",
        }),
      );
      return row;
    }
  }
  throw new PurchaseOrderError("Another order was being made at the same moment. Try again.", 409);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Pure: the proposal, in English as stored (rules 4 and 7). */
export function purchaseOrderProposal(
  profileId: string,
  ref: string,
  po: PurchaseOrder,
  rows: readonly CoverRow[],
  now: Date,
  verdict: ReturnType<typeof checkHardLimits>,
): NewProposal {
  const fmtTotal = po.totals.map((t) => fmtFor(t.currency)(t.amount_minor)).join(" + ");
  const costPart =
    po.totals.length === 0
      ? ""
      : `, about ${fmtTotal} at cost${po.unpriced > 0 ? ` for the ${plural(po.lines.length - po.unpriced, "line")} with a cost on file` : ""}`;
  const lead = rows[0]!.cover.lead;
  const items =
    po.lines.length === 1
      ? `${po.lines[0]!.quantity} × ${po.lines[0]!.name}`
      : plural(po.lines.length, "item");
  const assumptions: NewProposal["scenario"]["assumptions"] = rows.flatMap((r) => {
    const c = r.cover;
    return [
      {
        statement: `${r.item.name}: ${r.item.on_hand} on hand, read from ${r.source} on ${r.item.as_of}; ${c.rate?.units ?? 0} sold in the last ${plural(c.rate?.over_days ?? 0, "day")}`,
        value: null,
        source_field: null,
        measured: c.sources,
        sensitivity: "high" as const,
      },
    ];
  });
  assumptions.push({
    statement: `Delivery time: ${lead.why}`,
    value: lead.days,
    source_field: lead.source_field,
    sensitivity: "high",
  });
  if (lead.moq !== null) {
    assumptions.push({
      statement: `Minimum order: ${lead.moq}`,
      value: lead.moq,
      source_field: lead.moq_field,
      sensitivity: "medium",
    });
  }
  assumptions.push({
    statement: `${po.supplier.name}'s email address: ${po.supplier.email}, as you gave it`,
    value: null,
    source_field: po.supplier.email_field,
    sensitivity: "high",
  });
  if (po.delivery_address_field) {
    assumptions.push({
      statement: "Delivery address: your postal address on file",
      value: null,
      source_field: po.delivery_address_field,
      sensitivity: "medium",
    });
  }
  const formula = po.lines.map((l) => `${l.name}: ${l.arithmetic}`).join("; ");
  return {
    profile_id: profileId,
    module: STOCK_MODULE,
    originating_finding: ref,
    action: {
      kind: PO_KIND,
      summary: `Email purchase order ${po.number} to ${po.supplier.name}: ${items}${costPart}`,
      detail: {
        po,
        po_sha256: poSha256(po),
        // Approving schedules it for now: the next due run sends it, or the
        // owner's "Send now" on /stock does, through the engine either way.
        execute_on_approval: true,
        arithmetic: formula,
        evidence: rows.map((r) => `${r.item.name}: ${r.cover.warning?.sentence ?? ""}`.trim()),
        manual_limits: verdict.manual.map((l) => l.quote),
        sending: `Approving emails this order to ${po.supplier.email}, from SYB's address with replies going to you. A sent email can't be recalled, and I never change, cancel or pay an order: you do.`,
      },
    },
    scenario: {
      assumptions,
      base_case: {
        case: "base",
        statement: `Ordered today, ${items} from ${po.supplier.name}${costPart}, arriving in about ${plural(lead.days, "day")}.`,
        profit_delta_monthly: null,
        formula,
      },
      downside_case: {
        case: "downside",
        statement:
          "If an item sells at the fast end, it may still run out before the delivery lands.",
        profit_delta_monthly: null,
        formula: null,
      },
      upside_case: {
        case: "upside",
        statement: "If items sell at the slow end, the extra units sit as stock until they sell.",
        profit_delta_monthly: null,
        formula: null,
      },
      breakeven_condition: `Nothing to break even on here: the order's cost is yours to weigh${fmtTotal ? ` (${fmtTotal} at cost)` : ""}, and paying for it stays with you.`,
    },
    reversibility: {
      level: "hard",
      if_you_change_your_mind: `A sent email can't be recalled. If you change your mind after it goes, tell ${po.supplier.name} yourself: I never change, cancel or pay an order.`,
    },
    expires_at: new Date(now.getTime() + PO.expiry_days * 86_400_000).toISOString(),
    blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
  };
}
