// Idea 45 (I-45.1, I-45.2) — forwarded review notifications become review
// rows, and a poor one raises one alert. Against invented notification
// shapes in recorded-shape Resend payloads (./fixtures.ts); no network:
// fetch is stubbed to fail and every model is a fake.

import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  contacts,
  fieldRecords,
  intakeEvents,
  reviewSettings,
  reviews,
  watchActivity,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { ensureReviewSettings, rotateReviewToken } from "../review-desk/settings";
import type { InboundEmail } from "../support/inbound";
import { normaliseReceived, parseReceivedEvent } from "../support/inbound";
import { receivedEmail, receivedEvent } from "../support/resend-fixtures";
import type { ReviewParseLlm } from "./fallback";
import { REVIEW_PARSE_CAPS, REVIEW_PARSE_SYSTEM, RULE_24, coerceFallback } from "./fallback";
import type { NotificationFixture } from "./fixtures";
import {
  booksyNotification,
  freshaNotification,
  googleNotification,
  googleUnreadable,
  reviewEmailFixture,
  trustpilotForwarded,
} from "./fixtures";
import { receiveReviewEmail, reviewAddress, reviewRoutingFrom } from "./inbound";
import {
  NOTIFICATIONS,
  REVIEW_PLATFORMS,
  dedupeKey,
  isReviewNotification,
  originalMail,
  parseNotification,
  platformLink,
} from "./parse";
import { REVIEW_RETENTION_DAYS, fileReview, pruneExpiredReviews } from "./store";

const DOMAIN = "inbound.syb.test";
const NOW = new Date();
const created: { account_id: string; profile_id: string }[] = [];

beforeAll(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(reviews).where(inArray(reviews.profile_id, ids));
    await db.delete(reviewSettings).where(inArray(reviewSettings.profile_id, ids));
    await db.delete(watchActivity).where(inArray(watchActivity.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  const settings = await ensureReviewSettings(s.profile_id);
  return {
    ...s,
    token: settings.inbound_token,
    address: reviewAddress(settings.inbound_token, DOMAIN),
  };
}

function email(n: NotificationFixture, to: string, over = {}): InboundEmail {
  const f = reviewEmailFixture(n, to, over);
  const e = normaliseReceived(parseReceivedEvent(receivedEvent(f))!, receivedEmail(f));
  if (!e) throw new Error("fixture did not normalise");
  return e;
}

const noModel: ReviewParseLlm = async () => {
  throw new Error("the model must not be called here");
};

const g2 = googleNotification({
  business: "Lumen Hair Studio",
  reviewer: "Aoife M.",
  stars: 2,
  words: "Waited 40 minutes past my appointment and nobody said sorry. I won't be back.",
  reviewId: "g-2star",
});

/* ── the data file ── */

describe("the notification formats are data, and every one is unverified", () => {
  it("each platform has a label, what the research found, senders and link hosts", () => {
    expect(Object.keys(NOTIFICATIONS.platforms).sort()).toEqual([...REVIEW_PLATFORMS].sort());
    for (const p of REVIEW_PLATFORMS) {
      const s = NOTIFICATIONS.platforms[p];
      expect(s.label, p).not.toBe("");
      expect(s.found.length, p).toBeGreaterThan(40);
      expect(s.verified, p).toBe(false);
      expect(s.sender_domains.length, p).toBeGreaterThan(0);
      expect(s.link_hosts.length, p).toBeGreaterThan(0);
    }
  });
  it("every pattern compiles", () => {
    const all = [
      ...NOTIFICATIONS.patterns.stars,
      NOTIFICATIONS.patterns.star_glyphs,
      ...NOTIFICATIONS.patterns.reviewer,
      ...NOTIFICATIONS.patterns.review_date,
      ...NOTIFICATIONS.patterns.stop,
      ...NOTIFICATIONS.patterns.skip,
      ...NOTIFICATIONS.forwarded_markers,
    ];
    for (const p of all) expect(() => new RegExp(p, "i"), p).not.toThrow();
  });
});

/* ── the address ── */

describe("the reviews address: r-<token>, routed by its prefix", () => {
  it("reads an r- token on our domain, and nothing else", () => {
    const t = "0123456789abcdef0123456789abcdef";
    expect(reviewRoutingFrom([`R-${t}@${DOMAIN}`], DOMAIN)).toBe(t);
    expect(reviewRoutingFrom([`s-${t}@${DOMAIN}`], DOMAIN)).toBeNull(); // the support inbox's
    expect(reviewRoutingFrom([`r-${t}@other.example`], DOMAIN)).toBeNull();
    expect(reviewRoutingFrom([`r-${t.slice(1)}@${DOMAIN}`], DOMAIN)).toBeNull();
  });

  it("the webhook hands r- mail to the reviews path before any ticket is filed", () => {
    const route = readFileSync(
      path.resolve(process.cwd(), "app/api/support/inbound/route.ts"),
      "utf8",
    );
    const review = route.indexOf("reviewRoutingFrom(email.to, domain)");
    expect(review).toBeGreaterThan(0);
    expect(review).toBeLessThan(route.indexOf("receiveInboundEmail(email, domain)"));
    expect(review).toBeGreaterThan(route.indexOf("verifyWebhook("));
  });

  it("rotating it stops the old address filing anything", async () => {
    const b = await business();
    const rotated = await rotateReviewToken(b.profile_id);
    expect(rotated.inbound_token).not.toBe(b.token);
    expect(await receiveReviewEmail(email(g2, b.address), DOMAIN, { llm: noModel })).toEqual({
      kind: "unrouted",
    });
    const fresh = reviewAddress(rotated.inbound_token, DOMAIN);
    expect((await receiveReviewEmail(email(g2, fresh), DOMAIN, { llm: noModel })).kind).toBe(
      "filed",
    );
  });
});

/* ── recognising and reading ── */

describe("recognising a review notification by its original sender", () => {
  it("an auto-forward keeps the platform's From; a manual forward carries it in the block", () => {
    const auto = originalMail({
      from: "businessprofile-noreply@google.com",
      subject: g2.subject,
      text: g2.text,
    });
    expect(auto).toMatchObject({ platform: "google", listed: true, forwarded: false });
    const tp = trustpilotForwarded({
      owner: "niamh@lumenhair.example",
      business: "Lumen Hair Studio",
      reviewer: "Ciara D.",
      stars: 5,
      title: "Best balayage I've had",
      words: "Took her time and listened. Lovely, calm salon.",
      reviewId: "tp-1",
      date: "Mon, Oct 26, 2026 at 9:14 AM",
    });
    const manual = originalMail({
      from: "niamh@lumenhair.example",
      subject: tp.subject,
      text: tp.text,
    });
    expect(manual).toMatchObject({ platform: "trustpilot", listed: false, forwarded: true });
    expect(manual?.subject).toBe("New 5-star review for Lumen Hair Studio");
    expect(manual?.date_line).toBe("Mon, Oct 26, 2026 at 9:14 AM");
  });

  it("a From line in the body only counts inside a forwarded block", () => {
    const sneaky = originalMail({
      from: "stranger@example.com",
      subject: "hello",
      text: "Hi there\nFrom: Google <businessprofile-noreply@google.com>\n2 stars, awful",
    });
    expect(sneaky).toBeNull();
  });

  it("anyone else's mail is not a review; nor is the platform's sign-in or security mail", () => {
    expect(
      originalMail({ from: "ana@example.com", subject: "Great cut!", text: "5 stars" }),
    ).toBeNull();
    const security = originalMail({
      from: "no-reply@accounts.google.com",
      subject: "Security alert: review your account activity",
      text: "A new sign-in on Windows",
    });
    expect(security).not.toBeNull();
    expect(isReviewNotification(security!)).toBe(false);
    const domainOnly = originalMail({
      from: "noreply@trustpilot.com",
      subject: "Your monthly invoice",
      text: "...",
    });
    expect(isReviewNotification(domainOnly!)).toBe(false);
    const review = originalMail({
      from: "noreply@trustpilot.com",
      subject: "New review for Lumen",
      text: "...",
    });
    expect(isReviewNotification(review!)).toBe(true);
  });
});

describe("each platform's notification, read by the deterministic parser", () => {
  const read = (n: NotificationFixture) => {
    const mail = originalMail({
      from: n.from.replace(/^.*<|>$/g, ""),
      subject: n.subject,
      text: n.text,
    });
    if (!mail) throw new Error("not recognised");
    return parseNotification(mail, NOW);
  };

  it("Google: glyph stars, the name as shown, the words, the reply link", () => {
    expect(read(g2)).toEqual({
      stars: 2,
      reviewer: "Aoife M.",
      text: "Waited 40 minutes past my appointment and nobody said sorry. I won't be back.",
      link: "https://business.google.com/reviews/l/g-2star?hl=en",
      reviewed_at: null,
    });
  });

  it("Google with stars and no words: words stay null, never the footer", () => {
    const r = read(
      googleNotification({
        business: "Lumen",
        reviewer: "Tom",
        stars: 5,
        words: null,
        reviewId: "x",
      }),
    );
    expect(r.stars).toBe(5);
    expect(r.text).toBeNull();
  });

  it("Trustpilot forwarded by hand: stars out of 5, the reviewer, title and words, the date", () => {
    const tp = trustpilotForwarded({
      owner: "Niamh <niamh@lumenhair.example>",
      business: "Lumen Hair Studio",
      reviewer: "Ciara D.",
      stars: 5,
      title: "Best balayage I've had",
      words: "Took her time and listened.",
      reviewId: "tp-1",
      date: "Mon, Oct 26, 2026 at 9:14 AM",
    });
    const mail = originalMail({
      from: "niamh@lumenhair.example",
      subject: tp.subject,
      text: tp.text,
    })!;
    const r = parseNotification(mail, new Date("2026-10-29T10:00:00Z"));
    expect(r.stars).toBe(5);
    expect(r.reviewer).toBe("Ciara D.");
    expect(r.text).toBe("Best balayage I've had\n\nTook her time and listened.");
    expect(r.link).toBe("https://businessapp.b2b.trustpilot.com/reviews/tp-1");
    expect(r.reviewed_at?.slice(0, 10)).toBe("2026-10-26");
  });

  it("Booksy and Fresha: 'Rating: 4/5' and 'rated you 3 stars', the service line left out", () => {
    const b = read(
      booksyNotification({
        business: "Lumen",
        reviewer: "Siobhan K.",
        stars: 4,
        words: "Quick and friendly.",
        reviewId: "b1",
      }),
    );
    expect(b).toMatchObject({
      stars: 4,
      reviewer: "Siobhan K.",
      text: "Quick and friendly.",
      link: "https://booksy.com/biz/reviews/b1",
    });
    const f = read(
      freshaNotification({
        reviewer: "Orla B.",
        stars: 3,
        service: "Cut & blow-dry",
        words: "Nice cut but it felt rushed.",
        reviewId: "f1",
      }),
    );
    expect(f).toMatchObject({
      stars: 3,
      reviewer: "Orla B.",
      text: "Nice cut but it felt rushed.",
      link: "https://partners.fresha.com/reviews/f1",
    });
  });

  it("an unreadable notification yields no stars, so it is not called parsed", () => {
    expect(read(googleUnreadable("Lumen")).stars).toBeNull();
  });

  it("a link off the platform's hosts, or not https, is never kept", () => {
    expect(platformLink("https://business.google.com/reviews/1", "google")).not.toBeNull();
    expect(platformLink("https://evil.example/business.google.com", "google")).toBeNull();
    expect(platformLink("http://business.google.com/reviews/1", "google")).toBeNull();
    expect(platformLink("https://business.google.com/notifications/settings", "google")).toBeNull();
  });
});

/* ── filing ── */

describe("a forwarded notification becomes one review row", () => {
  it("files it, and a redelivery or a re-forward files nothing twice", async () => {
    const b = await business();
    const e = email(g2, b.address);
    const first = await receiveReviewEmail(e, DOMAIN, { llm: noModel });
    expect(first).toMatchObject({ kind: "filed", read_by: "parser", alerted: true });
    expect(await receiveReviewEmail(e, DOMAIN, { llm: noModel })).toEqual({ kind: "duplicate" });
    // The same notification forwarded again: a new email, the same review.
    expect(await receiveReviewEmail(email(g2, b.address), DOMAIN, { llm: noModel })).toEqual({
      kind: "duplicate",
    });
    const rows = await db.select().from(reviews).where(eq(reviews.profile_id, b.profile_id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      platform: "google",
      stars: 2,
      reviewer: "Aoife M.",
      source: "email",
    });
  });

  it("two different reviews behind the same listing link are two rows", async () => {
    const b = await business();
    const a = googleNotification({
      business: "L",
      reviewer: "A",
      stars: 1,
      words: "Bad.",
      reviewId: "same",
    });
    const c = googleNotification({
      business: "L",
      reviewer: "C",
      stars: 5,
      words: "Great.",
      reviewId: "same",
    });
    expect((await receiveReviewEmail(email(a, b.address), DOMAIN, { llm: noModel })).kind).toBe(
      "filed",
    );
    expect((await receiveReviewEmail(email(c, b.address), DOMAIN, { llm: noModel })).kind).toBe(
      "filed",
    );
  });

  it("mail from anyone else is dropped, and no reviewer becomes a contact", async () => {
    const b = await business();
    const out = await receiveReviewEmail(
      email(
        { from: "Ana <ana@example.com>", subject: "Loved it", text: "5 stars from me" },
        b.address,
      ),
      DOMAIN,
      { llm: noModel },
    );
    expect(out).toEqual({ kind: "not_a_review" });
    await receiveReviewEmail(email(g2, b.address), DOMAIN, { llm: noModel });
    expect(await db.select().from(contacts).where(eq(contacts.account_id, b.account_id))).toEqual(
      [],
    );
  });

  it("an unknown token is dropped with a log line that names nobody", async () => {
    const log = vi.mocked(console.log);
    log.mockClear();
    const out = await receiveReviewEmail(email(g2, reviewAddress("f".repeat(32), DOMAIN)), DOMAIN, {
      llm: noModel,
    });
    expect(out).toEqual({ kind: "unrouted" });
    const said = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("review_inbound_unrouted");
    expect(said).not.toContain("Aoife");
  });
});

/* ── the fallback ── */

describe("the model fallback: only a recognised sender's unparsed mail, capped, held to the email", () => {
  const unreadable = googleUnreadable("Lumen Hair Studio");

  it("reads what the email says, and drops what it doesn't", async () => {
    const b = await business();
    const calls: { system: string; user: string }[] = [];
    const llm: ReviewParseLlm = async (args) => {
      calls.push(args);
      return {
        text: JSON.stringify({
          stars: 2,
          reviewer: "Invented Person",
          text: "Someone shared their experience with your business.",
          link: "https://business.google.com/reviews/l/00000000000000000000",
        }),
        calls: [],
      };
    };
    const out = await receiveReviewEmail(email(unreadable, b.address), DOMAIN, {
      llm,
      spentEur: async () => 0,
    });
    expect(out).toMatchObject({ kind: "filed", read_by: "model" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain(RULE_24);
    const [row] = await db.select().from(reviews).where(eq(reviews.profile_id, b.profile_id));
    expect(row?.reviewer).toBeNull(); // not in the email: dropped
    expect(row?.stars).toBe(2);
  });

  it("is never called for mail that parsed, nor for a stranger's", async () => {
    const b = await business();
    await receiveReviewEmail(email(g2, b.address), DOMAIN, {
      llm: noModel,
      spentEur: async () => 0,
    });
    await receiveReviewEmail(
      email({ from: "x@example.com", subject: "review", text: "no stars" }, b.address),
      DOMAIN,
      { llm: noModel, spentEur: async () => 0 },
    );
  });

  it("past the monthly cap it isn't called, and the review is filed unread with its link", async () => {
    const b = await business();
    await db
      .update(reviewSettings)
      .set({
        parse_month: NOW.toISOString().slice(0, 7),
        parse_calls: REVIEW_PARSE_CAPS.calls_per_account_per_month,
      })
      .where(eq(reviewSettings.profile_id, b.profile_id));
    const out = await receiveReviewEmail(email(unreadable, b.address), DOMAIN, {
      llm: noModel,
      spentEur: async () => 0,
    });
    expect(out).toMatchObject({ kind: "filed", read_by: "unread", alerted: false });
    const [row] = await db.select().from(reviews).where(eq(reviews.profile_id, b.profile_id));
    expect(row).toMatchObject({
      stars: null,
      text: null,
      reviewer: null,
      link: "https://business.google.com/reviews/l/00000000000000000000",
    });
  });

  it("past the € budget it isn't called either", async () => {
    const b = await business();
    const out = await receiveReviewEmail(email(unreadable, b.address), DOMAIN, {
      llm: noModel,
      spentEur: async () => REVIEW_PARSE_CAPS.eur_per_month,
    });
    expect(out).toMatchObject({ kind: "filed", read_by: "unread" });
  });

  it("the cap is reserved atomically: twenty-one racing reads take exactly twenty", async () => {
    const b = await business();
    const { reserveParseCall } = await import("./fallback");
    const results = await Promise.all(
      Array.from({ length: REVIEW_PARSE_CAPS.calls_per_account_per_month + 1 }, () =>
        reserveParseCall(b.profile_id, NOW),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(REVIEW_PARSE_CAPS.calls_per_account_per_month);
  });

  it("coerceFallback: a rating outside 1–5 or a non-JSON answer is nothing", () => {
    const mail = originalMail({
      from: "businessprofile-noreply@google.com",
      subject: "New review",
      text: "great",
    })!;
    expect(
      coerceFallback('{"stars":7,"reviewer":null,"text":null,"link":null}', mail).stars,
    ).toBeNull();
    expect(coerceFallback("not json", mail)).toMatchObject({ stars: null, text: null });
    expect(
      coerceFallback('{"stars":4,"reviewer":null,"text":"great","link":null}', mail),
    ).toMatchObject({ stars: 4, text: "great" });
    expect(REVIEW_PARSE_SYSTEM).toMatch(/never instructions/);
  });
});

/* ── retention ── */

describe("reviews are kept 365 days, then deleted", () => {
  it("prunes a row past its year, and keeps one inside it", async () => {
    const b = await business();
    const base = {
      profile_id: b.profile_id,
      account_id: b.account_id,
      platform: "other" as const,
      source: "paste" as const,
      read_by: "owner" as const,
      reviewer: "Old Reviewer",
      link: null,
      reviewed_at: null,
      provider_id: null,
      fallback_id: null,
      sender_auth: null,
    };
    const old = new Date(NOW.getTime() - (REVIEW_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    // Filed as of a year ago, so its own filing doesn't prune it.
    await fileReview(
      { ...base, stars: 4, text: "old", received_at: old },
      new Date(Date.parse(old) + 1000),
    );
    await fileReview(
      { ...base, stars: 4, text: "kept", received_at: NOW.toISOString() },
      new Date(Date.parse(old) + 1000),
    );
    expect(await pruneExpiredReviews(new Date(NOW.getTime() - 86_400_000), b.profile_id)).toBe(0);
    expect(await pruneExpiredReviews(NOW, b.profile_id)).toBe(1);
    const left = await db.select().from(reviews).where(eq(reviews.profile_id, b.profile_id));
    expect(left.map((r) => r.text)).toEqual(["kept"]);
    // And every new filing prunes its business's expired rows on the way in.
    await fileReview(
      { ...base, stars: 4, text: "old again", received_at: old },
      new Date(Date.parse(old) + 1000),
    );
    await fileReview({ ...base, stars: 5, text: "today", received_at: NOW.toISOString() }, NOW);
    const after = await db.select().from(reviews).where(eq(reviews.profile_id, b.profile_id));
    expect(after.map((r) => r.text).sort()).toEqual(["kept", "today"]);
  });

  it("the content key ignores spacing and case, and differs for different words", () => {
    const k = (text: string) =>
      dedupeKey("google", { stars: 2, reviewer: "A", text, link: null }, null);
    expect(k("Too  slow")).toBe(k("too slow"));
    expect(k("Too slow")).not.toBe(k("Too fast"));
  });
});
