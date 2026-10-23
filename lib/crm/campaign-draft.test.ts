// P4-16, drafting half — an approved campaign becomes ONE email in the
// owner's voice, disclosed, with the compliance footer the owner approves
// along with the words, a per-recipient unsubscribe SLOT (never a link),
// and no recipient anywhere in it. The law where the business is gets its
// say on the draft, before any send exists.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  contentItems,
  fieldRecords,
  intakeEvents,
  proposals,
  users,
} from "../../db/schema";
import type { DraftLlm } from "../content/draft";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal, createProposal } from "../proposals/service";
import {
  UNSUBSCRIBE_SLOT,
  campaignCompliance,
  campaignDraftFor,
  complianceFooter,
  draftCampaign,
} from "./campaign-draft";

describe("P4-16 — the footer and what the law still wants", () => {
  it("the footer names the sender and address, and leaves the unsubscribe as a slot", () => {
    const footer = complianceFooter("Emberworks", "Király utca 12, Budapest");
    expect(footer).toContain("Emberworks · Király utca 12, Budapest");
    expect(footer).toContain(`Unsubscribe: ${UNSUBSCRIBE_SLOT}`);
    expect(footer).not.toMatch(/https?:\/\//);
    expect(complianceFooter(null, null)).toContain("This business");
  });

  it("an EU business with its name is complete for the draft; the send adds the rest", () => {
    expect(
      campaignCompliance({
        businessCountry: "Hungary",
        senderName: "Emberworks",
        postalAddress: null,
      }),
    ).toEqual({
      regimes: ["eu_gdpr"],
      refused: null,
      gaps: [],
      at_send: ["the sending address", "each recipient's own unsubscribe link"],
      ask: [],
    });
  });

  it("a US business without a postal address is told so on the draft, before any send", () => {
    expect(
      campaignCompliance({ businessCountry: "USA", senderName: "Emberworks", postalAddress: null })
        .gaps,
    ).toEqual(["the business's postal address (United States)"]);
    expect(
      campaignCompliance({ businessCountry: "USA", senderName: null, postalAddress: "1 Main St" })
        .gaps,
    ).toEqual(["the business's name (United States)"]);
    // Each gap links to the question that closes it; an EU business is never asked for an address.
    expect(
      campaignCompliance({ businessCountry: "USA", senderName: null, postalAddress: null }).ask,
    ).toEqual([
      { question_id: "1.1", label: "Add your business name" },
      { question_id: "11.1e", label: "Add your postal address" },
    ]);
    expect(
      campaignCompliance({ businessCountry: "Hungary", senderName: null, postalAddress: null }).ask,
    ).toEqual([{ question_id: "1.1", label: "Add your business name" }]);
  });

  it("an unknown country is refused on the draft, not guessed", () => {
    const c = campaignCompliance({
      businessCountry: "Switzerland",
      senderName: "x",
      postalAddress: "y",
    });
    expect(c.regimes).toEqual([]);
    expect(c.refused).toMatch(/Switzerland/);
    expect(c.gaps).toHaveLength(1);
  });
});

/* ── drafting, against the database ── */

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length > 0) {
    await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(users).where(inArray(users.account_id, accountIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
});

async function owner(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

const limitsLlm: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

function fakeDraft(): DraftLlm & { calls: number; system: string } {
  const state = Object.assign(
    (async ({ system }) => {
      state.calls += 1;
      state.system = system;
      return {
        text: "It's been a while. The fire's lit and the autumn scents are back on the shelf.",
      };
    }) as DraftLlm,
    { calls: 0, system: "" },
  );
  return state;
}

async function campaign(status: "approved" | "pending") {
  const s = await bootstrapIntake();
  created.push(s);
  await owner(s.profile_id, "identity.legal_name", "Emberworks");
  await owner(s.profile_id, "legal.country", "USA");
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p4-16-${crypto.randomUUID()}@test.local`,
      display_name: "P4-16 owner",
      role: "owner",
    })
    .returning({ id: users.id });
  const p = await createProposal({
    profile_id: s.profile_id,
    module: "crm",
    action: {
      kind: "customer_email",
      summary: "A win-back email to 3 lapsed customers",
      detail: {
        segment: "lapsed",
        label: "Lapsed customers",
        what: "A warm win-back email",
        contact_ids: [
          "contact-never-in-a-draft-1",
          "contact-never-in-a-draft-2",
          "contact-never-in-a-draft-3",
        ],
        evidence: ["3 contacts last bought over 180 days ago"],
      },
    },
    scenario: {} as never,
    reversibility: { level: "hard", if_you_change_your_mind: "an email can't be unsent" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  if (status === "approved") {
    await approveProposal({ proposalId: p.id, userId: u!.id, profileId: s.profile_id });
  }
  return { ...s, proposal_id: p.id };
}

describe("P4-16 — draftCampaign", () => {
  it("one disclosed email in the owner's voice, with the footer, a count and no recipient", async () => {
    const c = await campaign("approved");
    const llm = fakeDraft();
    const { draft, compliance, fresh } = await draftCampaign(c.proposal_id, {
      draftLlm: llm,
      limitLlm: limitsLlm,
    });
    expect(fresh).toBe(true);
    expect(llm.system).toContain("Emberworks"); // the voice card knows the name (identity.legal_name)
    expect(draft).toMatchObject({ kind: "email", proposal_id: c.proposal_id, scheduled_for: null });
    expect(draft.body).toContain("Written with AI assistance.");
    expect(draft.body).toContain(`Unsubscribe: ${UNSUBSCRIBE_SLOT}`);
    expect(draft.body).toContain("You're getting this because you agreed to hear from Emberworks");
    expect(JSON.stringify(draft)).not.toContain("contact-never-in-a-draft"); // a count, never a contact (rule 22)
    expect(draft.provenance).toMatchObject({
      campaign: { segment: "lapsed", recipients_at_proposal: 3 },
    });
    // A US business without an address hears it now, on the draft.
    expect(compliance.gaps).toEqual(["the business's postal address (United States)"]);

    // Drafting isn't sending: the approval stays for the send to execute.
    const [p] = await db.select().from(proposals).where(eq(proposals.id, c.proposal_id));
    expect(p?.status).toBe("approved");

    // Idempotent: the second call returns the draft and spends nothing.
    const again = await draftCampaign(c.proposal_id, { draftLlm: llm, limitLlm: limitsLlm });
    expect(again).toMatchObject({ fresh: false, draft: { id: draft.id } });
    expect(llm.calls).toBe(1);
  });

  it("only an approved campaign drafts; a foreign one is missing", async () => {
    const pending = await campaign("pending");
    await expect(
      draftCampaign(pending.proposal_id, { draftLlm: fakeDraft(), limitLlm: limitsLlm }),
    ).rejects.toMatchObject({ status: 409 });
    const mine = await campaign("approved");
    await expect(
      draftCampaign(mine.proposal_id, {
        draftLlm: fakeDraft(),
        limitLlm: limitsLlm,
        expectedProfileId: pending.profile_id,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("review 2026-10-23 #22 — a double-click drafts one email, and every reader names it", () => {
  it("two drafts at once store ONE row, and both clicks are shown the same body", async () => {
    const c = await campaign("approved");
    // Both calls reach the model before either stores: the race a double-click makes.
    let arrived = 0;
    let open!: () => void;
    const both = new Promise<void>((r) => (open = r));
    const llm: DraftLlm = async () => {
      arrived += 1;
      if (arrived === 2) open();
      await both;
      return { text: `Draft number ${arrived}. The fire's lit again.` };
    };
    const [a, b] = await Promise.all([
      draftCampaign(c.proposal_id, { draftLlm: llm, limitLlm: limitsLlm }),
      draftCampaign(c.proposal_id, { draftLlm: llm, limitLlm: limitsLlm }),
    ]);
    const rows = await db
      .select()
      .from(contentItems)
      .where(and(eq(contentItems.proposal_id, c.proposal_id), eq(contentItems.kind, "email")));
    expect(rows).toHaveLength(1);
    expect(a.draft.id).toBe(rows[0]!.id);
    expect(b.draft.id).toBe(rows[0]!.id);
    expect(a.draft.body).toBe(b.draft.body);
    expect([a.fresh, b.fresh].sort()).toEqual([false, true]);
  });

  it("with a double on record, every lookup names the earliest stored, not the heap's first", async () => {
    const c = await campaign("approved");
    const { draft } = await draftCampaign(c.proposal_id, {
      draftLlm: fakeDraft(),
      limitLlm: limitsLlm,
    });
    // A legacy double from before the lock, written second but stamped
    // earlier: a lookup without an order would name the first row written.
    const rest: Partial<typeof draft> = { ...draft };
    delete rest.id;
    delete rest.created_at;
    const [legacy] = await db
      .insert(contentItems)
      .values({
        ...(rest as Omit<typeof draft, "id" | "created_at">),
        body: `${draft.body}
(a second body)`,
        created_at: new Date(Date.parse(draft.created_at) - 60_000).toISOString(),
      })
      .returning();
    for (let i = 0; i < 3; i++) {
      expect((await campaignDraftFor(c.proposal_id))?.id).toBe(legacy!.id);
    }
    // And a fresh draft call returns that same row, so the sha shown is the sha approved.
    const again = await draftCampaign(c.proposal_id, {
      draftLlm: fakeDraft(),
      limitLlm: limitsLlm,
    });
    expect(again).toMatchObject({ fresh: false, draft: { id: legacy!.id } });
  });
});
