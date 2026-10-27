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

/**
 * P3-53 (Session K, "real first, AI fallback"): where an item's media came
 * from. Real footage keeps the honest edit label above. GENERATED media is
 * labelled as generated — stronger than "AI-assisted", and never softened:
 * these are the words the caption ends with and the file's metadata holds.
 */
export type MediaOrigin = "footage" | "generated_image" | "generated_video";

const MEDIA_LABELS: Readonly<Record<MediaOrigin, string>> = {
  footage: LABELS.video,
  generated_image: "AI-generated image. Not a real photo.",
  generated_video: "AI-generated video. Not real footage.",
};

/**
 * The label for an item carrying media of this origin. A video item's label
 * is the media's alone; a post's says the words were AI-assisted AND what
 * the media is. Total — every kind and origin has one.
 */
export function mediaDisclosureLabel(kind: ContentKind, origin: MediaOrigin): string {
  if (kind === "video" || kind === "shot_list") return MEDIA_LABELS[origin];
  return `${LABELS[kind]} ${MEDIA_LABELS[origin]}`;
}

/**
 * Re-label a caption: the old trailing label (any of ours) comes off, the
 * new one goes on — so a post that gains generated media says so, and one
 * whose generated image is replaced by real footage stops saying it.
 * Idempotent, and a caption always ends labelled.
 */
export function relabel(body: string, label: string): string {
  let text = body.trimEnd();
  for (;;) {
    const known = ALL_LABELS.find((l) => text.endsWith(l));
    if (!known) break;
    text = text.slice(0, text.length - known.length).trimEnd();
  }
  return text === "" ? label : `${text}\n\n${label}`;
}

/** Is this a label for generated media? (provenance and the screen ask) */
export function isGeneratedLabel(label: string): boolean {
  return (
    label.endsWith(MEDIA_LABELS.generated_image) || label.endsWith(MEDIA_LABELS.generated_video)
  );
}

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

/**
 * P3-21b: does this caption END with one of the disclosure labels? The
 * Meta publish path refuses to send a Facebook caption that doesn't —
 * Facebook has no AI-disclosure field, so the label in the text is the
 * disclosure (rule 17). Checks, never strips.
 */
export function isDisclosed(text: string): boolean {
  const end = text.trimEnd();
  return ALL_LABELS.some((label) => end.endsWith(label));
}

/** Every label a caption may end with, longest first so relabel strips whole labels. */
const ALL_LABELS: readonly string[] = [
  ...new Set([...Object.values(LABELS), ...Object.values(MEDIA_LABELS)]),
].sort((a, b) => b.length - a.length);
