// AI disclosure — Phase 3 Session C (P3-19), rule 17.
//
// Anything the system produces is marked AI-assisted, per platform,
// applied automatically. Read this module's exports carefully: there is
// no flag, no option, no environment variable, no bypass parameter.
// The absence of an off switch IS the feature, and a test asserts it
// by inspecting the module's own surface.
//
// Wording is honest about what happened: content drafted from the
// owner's real words is "AI-assisted", edited real footage is
// "AI-assisted edit of real footage" — never implying generation that
// did not happen, never hiding assistance that did. (EU AI Act Art. 50
// requires disclosure of AI-generated or manipulated content; platform
// rules add their own labels, applied at publish time in Session D.)

export type ContentKind = "post" | "email" | "shot_list" | "video";

const LABELS: Readonly<Record<ContentKind, string>> = {
  post: "Written with AI assistance.",
  email: "Written with AI assistance.",
  shot_list: "Shot list prepared with AI assistance.",
  video: "AI-assisted edit of real footage. No AI-generated imagery.",
};

/** The label for a piece of content. Total function — every kind has one. */
export function disclosureLabel(kind: ContentKind): string {
  return LABELS[kind];
}

/**
 * Apply the disclosure to drafted text: the label goes on the end, set
 * off plainly. Idempotent — applying twice does not stack labels.
 */
export function withDisclosure(kind: ContentKind, body: string): string {
  const label = disclosureLabel(kind);
  if (body.trimEnd().endsWith(label)) return body;
  return `${body.trimEnd()}\n\n${label}`;
}
