// The real dependencies of the smoke tests (scripts/smoke-*.ts): the
// production code paths, wired to the database. Every database module is
// imported lazily, inside the call, so a smoke test that refuses (a key
// missing, no --yes) never loads db/index.ts, which demands DATABASE_URL
// the moment it is imported. Kept apart from the entry scripts so the
// tests can run the same wiring against the test database.

import type { ErasureDeps } from "./erasure";
import type { InboundDeps } from "./inbound";
import type { WidgetDeps } from "./widget";

async function store() {
  const [{ db }, schema, orm, contacts] = await Promise.all([
    import("../../db"),
    import("../../db/schema"),
    import("drizzle-orm"),
    import("../../lib/crm/contacts"),
  ]);
  return { db, schema, orm, contacts };
}

export const inboundDeps: InboundDeps = {
  inboundToken: async (profileId) => {
    const { settingsForProfile } = await import("../../lib/support/settings");
    return (await settingsForProfile(profileId))?.inbound_token ?? null;
  },
  seenMessageIds: async (profileId, from) => {
    const { db, schema, orm } = await store();
    const m = schema.supportEmailMessages;
    const rows = await db
      .select({ id: m.id })
      .from(m)
      .where(
        orm.and(
          orm.eq(m.profile_id, profileId),
          orm.eq(m.direction, "inbound"),
          orm.eq(m.from_address, from),
        ),
      );
    return rows.map((r) => r.id);
  },
  findLanding: async (profileId, from, seen) => {
    const { db, schema, orm } = await store();
    const m = schema.supportEmailMessages;
    const t = schema.supportTickets;
    const [row] = await db
      .select({
        ticket_id: t.id,
        channel: t.channel,
        status: t.status,
        sender_auth: m.sender_auth,
        contact_id: t.contact_id,
        suppressed_address: t.suppressed_address,
      })
      .from(m)
      .innerJoin(t, orm.eq(t.id, m.ticket_id))
      .where(
        orm.and(
          orm.eq(m.profile_id, profileId),
          orm.eq(m.direction, "inbound"),
          orm.eq(m.from_address, from),
          ...(seen.length > 0 ? [orm.notInArray(m.id, [...seen])] : []),
        ),
      )
      .orderBy(orm.desc(m.at))
      .limit(1);
    if (!row) return null;
    return {
      ticket_id: row.ticket_id,
      channel: row.channel,
      status: row.status,
      sender_auth: row.sender_auth,
      has_contact: row.contact_id !== null,
      suppressed_address: row.suppressed_address,
    };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

const SOURCE = "smoke:erasure, a throwaway test contact on a reserved domain";

export const erasureDeps: ErasureDeps = {
  profileOf: async (accountId) => {
    const { db, schema, orm } = await store();
    const [row] = await db
      .select({ id: schema.businessProfiles.id })
      .from(schema.businessProfiles)
      .where(orm.eq(schema.businessProfiles.account_id, accountId))
      .limit(1);
    return row?.id ?? null;
  },
  addContact: async (accountId, email, name) => {
    const { contacts } = await store();
    const row = await contacts.addContact(accountId, {
      email,
      name,
      consent: { status: "unsure", source: SOURCE },
    });
    return row.id;
  },
  eraseContact: async (accountId, contactId) => {
    const { contacts } = await store();
    await contacts.eraseContact(accountId, contactId);
  },
  contactExists: async (contactId) => {
    const { db, schema, orm } = await store();
    const rows = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(orm.eq(schema.contacts.id, contactId));
    return rows.length > 0;
  },
  suppressedReason: async (accountId, email) => {
    const { contacts } = await store();
    return contacts.isSuppressed(accountId, email);
  },
  readdRefused: async (accountId, email) => {
    const { db, schema, orm, contacts } = await store();
    try {
      const row = await contacts.addContact(accountId, {
        email,
        consent: { status: "unsure", source: SOURCE },
      });
      // It should never get here; if it does, the stray row goes at once.
      await db
        .delete(schema.contacts)
        .where(
          orm.and(
            orm.eq(schema.contacts.id, row.id),
            orm.eq(schema.contacts.account_id, accountId),
          ),
        );
      return false;
    } catch (error) {
      if (error instanceof contacts.ContactError && error.status === 409) return true;
      throw error;
    }
  },
  decisionLog: async (profileId) => {
    const { db, schema, orm } = await store();
    const d = schema.decisionLog;
    return db
      .select({ id: d.id, kind: d.kind, ref_id: d.ref_id, payload_hash: d.payload_hash })
      .from(d)
      .where(orm.eq(d.profile_id, profileId))
      .orderBy(orm.desc(d.at))
      .limit(200);
  },
  cleanup: async (accountId, email) => {
    const { db, schema, orm, contacts } = await store();
    const { erasedClientKeys } = await import("../../lib/bookings/erase");
    const suppressions = await db
      .delete(schema.contactSuppressions)
      .where(
        orm.and(
          orm.eq(schema.contactSuppressions.account_id, accountId),
          orm.inArray(schema.contactSuppressions.email_hash, [
            contacts.emailHash(email),
            contacts.legacyEmailHash(email),
          ]),
        ),
      )
      .returning({ id: schema.contactSuppressions.id });
    const keys = erasedClientKeys(accountId, { email, phone: null });
    const bookingKeys =
      keys.length === 0
        ? []
        : await db
            .delete(schema.bookingClientErasures)
            .where(
              orm.and(
                orm.eq(schema.bookingClientErasures.account_id, accountId),
                orm.inArray(schema.bookingClientErasures.client_key, keys),
              ),
            )
            .returning({ id: schema.bookingClientErasures.id });
    return { suppressions: suppressions.length, booking_keys: bookingKeys.length };
  },
  deleteContact: async (accountId, contactId) => {
    const { db, schema, orm } = await store();
    await db
      .delete(schema.contacts)
      .where(
        orm.and(
          orm.eq(schema.contacts.id, contactId),
          orm.eq(schema.contacts.account_id, accountId),
        ),
      );
  },
};

export const widgetDeps: WidgetDeps = {
  settings: async (profileId) => {
    const { settingsForProfile } = await import("../../lib/support/settings");
    const row = await settingsForProfile(profileId);
    return row ? { site_key: row.site_key, business_name: row.business_name } : null;
  },
  approvedKnowledge: async (profileId) => {
    const { publicKnowledge } = await import("../../lib/support/knowledge");
    return (await publicKnowledge(profileId)).length;
  },
};
