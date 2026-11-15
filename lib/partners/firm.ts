// Firms and their members — the v1 build spec §7.1, §7.3, §7.5 (P7-80).
//
// A firm is its own entity above businesses, never a business with
// children. Whoever creates it is its principal; a principal adds managers
// and staff (people who have signed in to SYB once) and sets the firm's
// white-label. The tier and revenue share follow the number of active
// clients (§7.5): Starter 1–10 at 15 %, Practice 11–40 at 20 %, Network 41+
// at 25 %; the per-client price is the price book's partner row.

import { and, count, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../db";
import { firmMembers, firms, mandates, users } from "../../db/schema";
import type { WhiteLabel } from "../../db/schema";
import { PartnerAccessError, firmOf } from "./access";

export const FIRM_TYPES = [
  "accountancy",
  "bookkeeping",
  "marketing_agency",
  "consultancy",
] as const;
export type FirmType = (typeof FIRM_TYPES)[number];

export class FirmError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "FirmError";
    this.status = status;
  }
}

/** §7.5: the tier and its revenue share, by active clients. */
export function firmTierFor(activeClients: number): { tier: string; rev_share_bp: number } {
  if (activeClients > 40) return { tier: "partner_network", rev_share_bp: 2_500 };
  if (activeClients > 10) return { tier: "partner_practice", rev_share_bp: 2_000 };
  return { tier: "partner_starter", rev_share_bp: 1_500 };
}

export async function createFirm(args: {
  userId: string;
  name: string;
  country: string;
  type: string;
}) {
  const name = args.name.trim();
  const country = args.country.trim().toUpperCase();
  if (name === "" || name.length > 120) throw new FirmError("the firm needs a name");
  if (!/^[A-Z]{2}$/.test(country)) throw new FirmError("pick the firm's country");
  if (!(FIRM_TYPES as readonly string[]).includes(args.type))
    throw new FirmError("pick what kind of firm it is");
  if (await firmOf(args.userId)) throw new FirmError("you are already in a firm", 409);
  return db.transaction(async (tx) => {
    const [firm] = await tx
      .insert(firms)
      .values({ name, country, type: args.type as FirmType })
      .returning();
    await tx
      .insert(firmMembers)
      .values({ firm_id: firm!.id, user_id: args.userId, role: "principal" });
    return firm!;
  });
}

/** The caller's firm and role, or a refusal: the console is for firm members. */
export async function requireFirm(
  userId: string,
  roles: readonly ("principal" | "manager" | "staff")[] = ["principal", "manager", "staff"],
) {
  const mine = await firmOf(userId);
  if (!mine) throw new PartnerAccessError("you aren't in a firm", 403);
  if (!roles.includes(mine.role))
    throw new PartnerAccessError("your role in the firm can't do that", 403);
  return mine;
}

/** A principal adds someone who has signed in to SYB once, by their email. */
export async function addMember(args: {
  userId: string;
  email: string;
  role: "manager" | "staff";
}) {
  const { firm } = await requireFirm(args.userId, ["principal"]);
  const [person] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, args.email.trim().toLowerCase()), isNull(users.removed_at)))
    .limit(1);
  if (!person) throw new FirmError("they need to sign in to ScaleX once before they can join", 404);
  await db
    .insert(firmMembers)
    .values({ firm_id: firm.id, user_id: person.id, role: args.role })
    .onConflictDoNothing();
  return { firm_id: firm.id, user_id: person.id };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** §7.3: the firm's logo, colours and sender domain. Checked, never free CSS. */
export async function setWhiteLabel(userId: string, wl: WhiteLabel) {
  const { firm } = await requireFirm(userId, ["principal"]);
  const clean: WhiteLabel = {};
  if (wl.logo_url) {
    if (!/^https:\/\/[^\s"'<>]+$/.test(wl.logo_url))
      throw new FirmError("the logo must be an https address");
    clean.logo_url = wl.logo_url;
  }
  for (const k of ["primary_color", "accent_color"] as const) {
    if (wl[k]) {
      if (!HEX.test(wl[k]!)) throw new FirmError("a colour is written #rrggbb");
      clean[k] = wl[k]!;
    }
  }
  if (wl.sender_domain) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(wl.sender_domain))
      throw new FirmError("that isn't a domain");
    clean.sender_domain = wl.sender_domain.toLowerCase();
  }
  await db.update(firms).set({ white_label: clean }).where(eq(firms.id, firm.id));
  return clean;
}

/** §7.5: recount active clients and set the tier and share. */
export async function refreshTier(firmId: string, now = new Date()) {
  const [row] = await db
    .select({ n: count() })
    .from(mandates)
    .where(
      and(
        eq(mandates.firm_id, firmId),
        isNull(mandates.revoked_at),
        gt(mandates.expires_at, now.toISOString()),
      ),
    );
  const next = firmTierFor(row?.n ?? 0);
  await db.update(firms).set(next).where(eq(firms.id, firmId));
  return { ...next, clients: row?.n ?? 0 };
}
