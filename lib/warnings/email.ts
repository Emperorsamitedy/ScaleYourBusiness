// Warnings sent at once: the email — pure. One short email the first time a
// warning that looks ahead appears: the warning in the watch's own sentence,
// a way to its screen, why it came and where to stop it. Same input, same
// bytes. lib/warnings/alerts decides whether it goes (the owner's switch, a
// key to send with) and claims it before the provider is called.
//
// The subject is the phone alert's fixed phrase (no figure: a subject shows
// on a lock screen too). The body carries the sentence as logged, figures
// included: it is the owner's own inbox, as the weekly summary's is.

import type { OwnerEmail } from "../auth/email";
import type { Words } from "../i18n/recipient";
import { englishWords } from "../i18n/recipient";
import type { WarningKind } from "../push/plan";
import { WARNING_SCREEN } from "../push/plan";

const INK = "#0D1321";
const INK_2 = "#4A5263";
const PAPER = "#FFFFFF";
const RULE = "#7A8494";
const PROSE = "Archivo,Helvetica,Arial,sans-serif";

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export interface WarningEmailInput {
  kind: WarningKind;
  /**
   * The warnings as the watch logged them, already read in the owner's
   * language: one for the cash forecast, one per item for stock that runs low
   * in the same run of the watch. Never empty.
   */
  sentences: readonly string[];
  /** The warning's screen as the menu names it ("Cash flow"). */
  screen: string;
  /** The settings screen that holds the switch, as the menu names it. */
  settings: string;
  /** The app's own address, with no slash at its end. */
  origin: string;
  to: string;
  /** The first alert's id: what makes a second send of the same warnings a duplicate. */
  alert_id: string;
}

const ENGLISH = (): Words => englishWords("emails.warning");
const PUSH_ENGLISH = (): Words => englishWords("warningPush");

/**
 * The whole email. `w` is the owner's words for "emails.warning" and `pw`
 * theirs for "warningPush", whose fixed phrase is the subject.
 */
export function composeWarningEmail(
  input: WarningEmailInput,
  w: Words = ENGLISH(),
  pw: Words = PUSH_ENGLISH(),
): OwnerEmail {
  // One warning says what it is about; several are counted. Fixed words either way.
  const subject =
    input.sentences.length === 1
      ? pw.t(`one.${input.kind}`)
      : pw.t("many", { count: input.sentences.length });
  const screenUrl = `${input.origin}${WARNING_SCREEN[input.kind]}`;
  const settingsUrl = `${input.origin}/settings/alerts`;
  const open = w.t("open", { screen: input.screen });
  const stop = w.t("stop", { settings: input.settings });
  const text = [
    ...input.sentences,
    "",
    `${open}: ${screenUrl}`,
    "",
    w.t("why"),
    `${stop} ${settingsUrl}`,
  ].join("\n");
  const html =
    `<!doctype html><html lang="${w.locale}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:${PAPER}">` +
    `<div style="max-width:600px;margin:0 auto;padding:32px 16px;font-family:${PROSE};font-size:16px;line-height:1.5;color:${INK};background:${PAPER}">` +
    `<h1 style="margin:0 0 16px;font-family:${PROSE};font-weight:650;font-size:22px;line-height:1.25;color:${INK}">${escapeHtml(subject)}</h1>` +
    input.sentences.map((line) => `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`).join("") +
    `<p style="margin:8px 0 28px"><a href="${escapeHtml(screenUrl)}" style="display:inline-block;padding:10px 16px;border-radius:10px;background:${INK};color:${PAPER};font-weight:600;text-decoration:none">${escapeHtml(open)}</a></p>` +
    `<div style="border-top:1px solid ${RULE};padding:16px 0 0;font-size:14px;color:${INK_2}">` +
    `<p style="margin:0 0 8px">${escapeHtml(w.t("why"))}</p>` +
    `<p style="margin:0">${escapeHtml(stop)} <a href="${escapeHtml(settingsUrl)}" style="color:${INK};text-decoration:underline">${escapeHtml(input.settings)}</a></p>` +
    `</div></div></body></html>`;
  return {
    to: input.to,
    subject,
    text,
    html,
    idempotency_key: `warning-${input.alert_id}`,
  };
}
