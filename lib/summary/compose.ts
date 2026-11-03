// The weekly summary's composer — idea 42 (Ideas round, 2026-10-26).
//
// Pure and deterministic: no model, no database, no clock (CLAUDE.md —
// never call an LLM for something deterministic). Given what is already on
// record for the week, it writes one email to the OWNER, in a text part and
// a plain HTML part that say the same thing.
//
// The watch's rule holds line by line: every line is a row that exists —
// a watch-log entry, a change that ran, a proposal that waits, a ticket
// that is open, a readback the trust layer computed. Nothing is
// summarised into motion it didn't have, and a week with nothing in it
// says exactly that. Customer words never appear: support is a count
// (rule 24, and the owner notice's discipline). Money prints through
// lib/core/money; a measured figure says "measured".
//
// L-6 (TASKS-LANGUAGES.md): the email's own words come from messages/
// <locale>.json (`emails.summary`) in the owner's language, chosen by the
// runner through the gate (lib/i18n/recipient); English by default, word
// for word what it said before. Dates, money and percentages go through
// Intl in that language. The lines the watch log already wrote (a row's
// `detail`) and a proposal's own summary are printed as recorded.

import { format, money } from "../core/money";
import { intlTag } from "../i18n/locales";
import type { Words } from "../i18n/recipient";
import { englishWords } from "../i18n/recipient";
import type { JudgedOn, OutcomeVerdict } from "../trust/readback";
import { NOTED_KINDS, REVIEW_ALERT_KIND, STOCK_WARNING_KIND } from "../watch/watch-view";
import type { SummaryWindow } from "./week";
import { dayLabel, windowLabel } from "./week";

/** One watch_activity row of the week. */
export interface SummaryActivity {
  at: string;
  kind: string;
  detail: string;
  meta: unknown;
}

/** An executed proposal's readback, as the trust layer judged it. */
export interface SummaryReadback {
  /** The proposal's own summary; null when it has none ("A proposal"). */
  summary: string | null;
  verdict: OutcomeVerdict;
  judged_on: JudgedOn;
  currency: string | null;
  /** Mean daily minor units before and after — revenue readbacks only. */
  before_minor: number | null;
  after_minor: number | null;
  delta_pct: number | null;
}

export interface SummaryInput {
  /** identity.legal_name when answered; null otherwise. */
  business: string | null;
  window: SummaryWindow;
  /** APP_URL's origin, no trailing slash. */
  origin: string;
  /** The signed one-click stop link. */
  stop_url: string;
  activity: readonly SummaryActivity[];
  /** Changes that ran this week — each one approved by the owner; `undone` when since undone. */
  executed: readonly { at: string; summary: string | null; undone?: boolean }[];
  /** Proposals waiting for a decision, newest first. */
  pending: readonly { summary: string | null }[];
  /** Support tickets open and waiting for the owner. A count, never their text. */
  open_tickets: number;
  readbacks: readonly SummaryReadback[];
  /** Connector labels by provider id, for the collapsed sync lines. */
  provider_labels: Readonly<Record<string, string>>;
  /** Idea 54: SYB's own forecasts graded this week, by verdict. */
  forecasts?: ForecastsGraded;
}

/** Idea 54: how the week's graded forecasts came out. */
export interface ForecastsGraded {
  inside: number;
  above: number;
  below: number;
  cant_tell: number;
}

export interface SummaryLine {
  text: string;
  /** Prefix, e.g. "Mon 20 Oct". */
  at?: string;
}

export interface SummarySection {
  key: "waiting" | "stock" | "reviews" | "done" | "noticed" | "goals" | "readback" | "forecasts";
  title: string;
  lines: SummaryLine[];
  /** Lines held back by the cap; the link shows them all. */
  more: number;
  /** Where the whole of it lives in the app. */
  href: string;
  link_text: string;
}

export interface ComposedSummary {
  subject: string;
  heading: string;
  period: string;
  /** True when the week had nothing in it, and the email says so. */
  quiet: boolean;
  sections: SummarySection[];
  /** Real lines carried, across sections (the waiting counts included). */
  line_count: number;
  text: string;
  html: string;
}

/** At most this many lines a section; the rest is one "and N more" line. */
export const SECTION_CAP = 6;

/** Watch kinds that echo a change already listed from the executions themselves. */
export const EXECUTION_ECHO_KINDS: ReadonlySet<string> = new Set([
  "content_published",
  "ad_changed",
]);

/** The email's words in English: the default for every function below. */
const ENGLISH = (): Words => englishWords("emails.summary");

const JUDGED: Readonly<Record<JudgedOn, string>> = {
  revenue: "judged.revenue",
  post: "judged.post",
  campaign: "judged.campaign",
  email: "judged.email",
};

const chronological = <T extends { at: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

function capped(lines: SummaryLine[]): { lines: SummaryLine[]; more: number } {
  return lines.length > SECTION_CAP
    ? { lines: lines.slice(0, SECTION_CAP), more: lines.length - SECTION_CAP }
    : { lines, more: 0 };
}

function moneyText(minor: number, currency: string, w: Words): string {
  return format(money(Math.round(minor), currency), w.locale === "en" ? "en" : intlTag(w.locale));
}

/** "+12.7%", "-21.2%" in English, exactly as before; the language's own percent elsewhere. */
function pctText(delta: number, w: Words): string {
  if (w.locale === "en") return `${delta >= 0 ? "+" : ""}${delta}%`;
  return new Intl.NumberFormat(intlTag(w.locale), {
    style: "percent",
    signDisplay: "always",
    maximumFractionDigits: 1,
  }).format(delta / 100);
}

/** One readback as a sentence, or null for a verdict with nothing to say. */
export function readbackLine(r: SummaryReadback, w: Words = ENGLISH()): string | null {
  if (r.verdict === "unmeasured") return null;
  const summary = r.summary ?? w.t("aProposal");
  if (r.verdict === "too_early") return w.t("tooEarly", { summary });
  const verdict = w.t(`verdicts.${r.verdict}`);
  const pct = r.delta_pct !== null ? pctText(r.delta_pct, w) : null;
  if (
    r.judged_on === "revenue" &&
    r.currency !== null &&
    r.before_minor !== null &&
    r.after_minor !== null
  ) {
    const values = {
      summary,
      verdict,
      after: moneyText(r.after_minor, r.currency, w),
      before: moneyText(r.before_minor, r.currency, w),
    };
    return pct === null ? w.t("revenue", values) : w.t("revenuePct", { ...values, pct });
  }
  const values = { summary, verdict, basis: w.t(JUDGED[r.judged_on]) };
  return pct === null ? w.t("judgedOn", values) : w.t("judgedOnPct", { ...values, pct });
}

/**
 * Idea 54: the week's graded forecasts as one line, or null when none was
 * graded. A miss is said as plainly as a hit; "can't tell" is named apart
 * and never counted as right.
 */
export function forecastsLine(f: ForecastsGraded | undefined, w: Words = ENGLISH()): string | null {
  if (!f) return null;
  const total = f.inside + f.above + f.below + f.cant_tell;
  if (total === 0) return null;
  const missed = f.above + f.below;
  const misses =
    missed === 0
      ? w.t("missedNone")
      : f.below === 0
        ? w.t("missedAbove", { missed, above: f.above })
        : f.above === 0
          ? w.t("missedBelow", { missed, below: f.below })
          : w.t("missedBoth", { missed, above: f.above, below: f.below });
  const cant = f.cant_tell > 0 ? w.t("cantTell", { count: f.cant_tell }) : "";
  return w.t("forecasts", { total, inside: f.inside, misses, cant });
}

/** The connector syncs of a week, one line per source: the days add up. */
function syncLines(
  rows: readonly SummaryActivity[],
  labels: SummaryInput["provider_labels"],
  w: Words,
) {
  const days = new Map<string, number>();
  const other: SummaryActivity[] = [];
  for (const row of rows) {
    const meta = (row.meta ?? {}) as { provider?: unknown; new_days?: unknown };
    const provider = typeof meta.provider === "string" ? meta.provider : null;
    const n = typeof meta.new_days === "number" ? meta.new_days : 0;
    if (provider && n > 0) days.set(provider, (days.get(provider) ?? 0) + n);
    else other.push(row); // a re-measure with no new days: its own words
  }
  const lines: SummaryLine[] = [...days].map(([provider, n]) => ({
    text: w.t("synced", { count: n, source: labels[provider] ?? provider }),
  }));
  return { lines, other };
}

/** The sections, in reading order. Empty ones are left out. */
export function summarySections(input: SummaryInput, w: Words = ENGLISH()): SummarySection[] {
  const sections: SummarySection[] = [];
  const day = (at: string) => dayLabel(at, w.locale);

  // Waiting for you — the only part that asks anything of the owner.
  const waiting: SummaryLine[] = [];
  if (input.pending.length > 0) {
    waiting.push({ text: w.t("pending", { count: input.pending.length }) });
    for (const p of input.pending.slice(0, 3)) {
      waiting.push({ text: `— ${p.summary ?? w.t("aProposal")}` });
    }
    if (input.pending.length > 3) {
      waiting.push({ text: w.t("pendingMore", { count: input.pending.length - 3 }) });
    }
  }
  if (input.open_tickets > 0) {
    waiting.push({ text: w.t("tickets", { count: input.open_tickets }) });
  }
  if (waiting.length > 0) {
    sections.push({
      key: "waiting",
      title: w.t("titles.waiting"),
      lines: waiting,
      more: 0,
      href: input.pending.length > 0 ? "/proposals" : "/support",
      link_text: input.pending.length > 0 ? w.t("links.waiting") : w.t("links.support"),
    });
  }

  const rows = chronological(input.activity);
  const goals = rows.filter((r) => r.kind === "goal_progress");
  const noticed = rows.filter(
    (r) => NOTED_KINDS.has(r.kind) && r.kind !== STOCK_WARNING_KIND && r.kind !== REVIEW_ALERT_KIND,
  );

  // P5-02: running low — the latest warning of each item this week, in its
  // own words. A warning, never a push to act: the reorder is a note on /stock.
  const latestByItem = new Map<string, SummaryActivity>();
  for (const r of rows.filter((x) => x.kind === STOCK_WARNING_KIND)) {
    const key = ((r.meta ?? {}) as { key?: unknown }).key;
    latestByItem.set(typeof key === "string" ? key : r.detail, r);
  }
  if (latestByItem.size > 0) {
    sections.push({
      key: "stock",
      title: w.t("titles.stock"),
      ...capped([...latestByItem.values()].map((r) => ({ at: day(r.at), text: r.detail }))),
      href: "/stock",
      link_text: w.t("links.stock"),
    });
  }
  // Idea 45: reviews worth knowing, one line each and never folded together
  // (two 2-star reviews on Google are two reviews). Platform and stars only:
  // the reviewer and the words stay on /reviews.
  const reviewAlerts = rows.filter((r) => r.kind === REVIEW_ALERT_KIND);
  if (reviewAlerts.length > 0) {
    sections.push({
      key: "reviews",
      title: w.t("titles.reviews"),
      ...capped(reviewAlerts.map((r) => ({ at: day(r.at), text: r.detail }))),
      href: "/reviews",
      link_text: w.t("links.reviews"),
    });
  }
  const syncs = syncLines(
    rows.filter((r) => r.kind === "connector_sync"),
    input.provider_labels,
    w,
  );
  const work = [
    ...syncs.other,
    ...rows.filter(
      (r) =>
        r.kind !== "goal_progress" &&
        r.kind !== "connector_sync" &&
        !NOTED_KINDS.has(r.kind) &&
        !EXECUTION_ECHO_KINDS.has(r.kind),
    ),
  ];

  // What I did — changes that ran first (each approved), then the log's work.
  const done: SummaryLine[] = [
    ...chronological(input.executed).map((e) => ({
      at: day(e.at),
      text: w.t(e.undone ? "executedUndone" : "executed", {
        summary: e.summary ?? w.t("aProposal"),
      }),
    })),
    ...syncs.lines,
    ...dedupe(chronological(work)).map((r) => ({ at: day(r.at), text: r.detail })),
  ];
  if (done.length > 0) {
    sections.push({
      key: "done",
      title: w.t("titles.done"),
      ...capped(done),
      href: "/watch",
      link_text: w.t("links.watching"),
    });
  }

  if (noticed.length > 0) {
    sections.push({
      key: "noticed",
      title: w.t("titles.noticed"),
      ...capped(dedupe(noticed).map((r) => ({ at: day(r.at), text: r.detail }))),
      href: "/watch",
      link_text: w.t("links.watching"),
    });
  }

  // Goals: the latest check of each goal this week, in its own words.
  const latestByGoal = new Map<string, SummaryActivity>();
  for (const g of goals) {
    const id = ((g.meta ?? {}) as { goal_id?: unknown }).goal_id;
    latestByGoal.set(typeof id === "string" ? id : g.at, g);
  }
  if (latestByGoal.size > 0) {
    sections.push({
      key: "goals",
      title: w.t("titles.goals"),
      ...capped([...latestByGoal.values()].map((g) => ({ text: g.detail }))),
      href: "/progress",
      link_text: w.t("links.goals"),
    });
  }

  const readbacks = input.readbacks
    .map((r) => readbackLine(r, w))
    .filter((t): t is string => t !== null)
    .map((text) => ({ text }));
  if (readbacks.length > 0) {
    sections.push({
      key: "readback",
      title: w.t("titles.readback"),
      ...capped(readbacks),
      href: "/history",
      link_text: w.t("links.history"),
    });
  }
  const graded = forecastsLine(input.forecasts, w);
  if (graded) {
    sections.push({
      key: "forecasts",
      title: w.t("titles.forecasts"),
      lines: [{ text: graded }],
      more: 0,
      href: "/history",
      link_text: w.t("links.track"),
    });
  }
  return sections;
}

/** The same sentence logged twice in a week is said once. */
function dedupe<T extends { detail: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.detail) ? false : (seen.add(r.detail), true)));
}

/** The quiet week's line, in English. */
export const QUIET_LINE = ENGLISH().t("quiet");

function subjectFor(input: SummaryInput, quiet: boolean, w: Words): string {
  const waiting = input.pending.length + input.open_tickets;
  if (waiting > 0) return w.t("subjectWaiting", { count: waiting });
  if (quiet) return w.t("subjectQuiet");
  return w.t("subjectCalm");
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// The sheet system's tokens (specs/ux-spec-v1.md §2), inline because mail
// clients drop stylesheets: ink on paper, 1px rules, square corners, no
// images, no colour carrying meaning, nothing below 12px.
const INK = "#0E1A13";
const INK_2 = "#3A4C42";
const PAPER = "#F2F7F4";
const RULE = "#71897D";
const MONO = "'IBM Plex Mono',Menlo,Consolas,monospace";
const PROSE = "Archivo,Helvetica,Arial,sans-serif";

function renderText(
  c: Omit<ComposedSummary, "text" | "html">,
  input: SummaryInput,
  w: Words,
): string {
  const out: string[] = [c.heading, c.period, ""];
  if (c.quiet) out.push(w.t("quiet"), "");
  for (const s of c.sections) {
    out.push(
      w.locale === "en" ? s.title.toUpperCase() : s.title.toLocaleUpperCase(intlTag(w.locale)),
    );
    for (const l of s.lines) out.push(l.at ? `- ${l.at} · ${l.text}` : `- ${l.text}`);
    if (s.more > 0) out.push(`- ${w.t("more", { count: s.more })}`);
    out.push(`${s.link_text}: ${input.origin}${s.href}`, "");
  }
  out.push(
    w.t("footWatching", { url: `${input.origin}/watch` }),
    w.t("footApprove"),
    "",
    w.t("footStop"),
    input.stop_url,
  );
  return out.join("\n");
}

function renderHtml(
  c: Omit<ComposedSummary, "text" | "html">,
  input: SummaryInput,
  w: Words,
): string {
  const link = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" style="color:${INK};text-decoration:underline">${escapeHtml(label)}</a>`;
  /** A sentence with one <link> in it: its words escaped, the link drawn by `link`. */
  const sentence = (key: string, href: string) =>
    escapeHtml(w.markup(key, { link: (chunks) => `${chunks}` })).replace(
      /([^]*)/,
      (_, words: string) => link(href, words),
    );
  const label = (t: string) =>
    `<p style="margin:0 0 8px;font-family:${MONO};font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${INK_2}">${escapeHtml(t)}</p>`;
  const parts: string[] = [];
  parts.push(
    `<h1 style="margin:0 0 4px;font-family:'Zilla Slab',Georgia,serif;font-weight:600;font-size:26px;line-height:1.2;color:${INK}">${escapeHtml(c.heading)}</h1>`,
    `<p style="margin:0 0 24px;font-family:${MONO};font-size:12px;color:${INK_2}">${escapeHtml(c.period)}</p>`,
  );
  if (c.quiet) {
    parts.push(`<p style="margin:0 0 24px">${escapeHtml(w.t("quiet"))}</p>`);
  }
  for (const s of c.sections) {
    const items = s.lines
      .map(
        (l) =>
          `<li style="margin:0 0 6px">${
            l.at
              ? `<span style="font-family:${MONO};font-size:12px;color:${INK_2}">${escapeHtml(l.at)}</span> `
              : ""
          }${escapeHtml(l.text)}</li>`,
      )
      .join("");
    const more =
      s.more > 0
        ? `<li style="margin:0 0 6px">${escapeHtml(w.t("more", { count: s.more }))}</li>`
        : "";
    parts.push(
      `<div style="border-top:1px solid ${RULE};padding:16px 0 8px">`,
      label(s.title),
      `<ul style="margin:0 0 8px;padding-left:18px">${items}${more}</ul>`,
      `<p style="margin:0 0 8px">${link(`${input.origin}${s.href}`, `${s.link_text} →`)}</p>`,
      `</div>`,
    );
  }
  parts.push(
    `<div style="border-top:1px solid ${RULE};padding:16px 0 0;font-size:14px;color:${INK_2}">`,
    `<p style="margin:0 0 8px">${sentence("footWatchingHtml", `${input.origin}/watch`)}</p>`,
    `<p style="margin:0">${sentence("footStopHtml", input.stop_url)}</p>`,
    `</div>`,
  );
  return (
    `<!doctype html><html lang="${w.locale}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(c.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:${PAPER}">` +
    `<div style="max-width:600px;margin:0 auto;padding:32px 16px;font-family:${PROSE};font-size:16px;line-height:1.5;color:${INK};background:${PAPER}">` +
    parts.join("") +
    `</div></body></html>`
  );
}

/**
 * The whole email. Same input, same bytes. `w` is the owner's words
 * (lib/i18n/recipient wordsFor(locale, "emails.summary")); English by default.
 */
export function composeSummary(input: SummaryInput, w: Words = ENGLISH()): ComposedSummary {
  const sections = summarySections(input, w);
  const quiet = sections.length === 0;
  const base = {
    subject: subjectFor(input, quiet, w),
    heading: input.business ? w.t("headingNamed", { business: input.business }) : w.t("heading"),
    period: windowLabel(input.window, w.locale),
    quiet,
    sections,
    line_count: sections.reduce((n, s) => n + s.lines.length + s.more, 0),
  };
  return { ...base, text: renderText(base, input, w), html: renderHtml(base, input, w) };
}
