// ContentLabeller — the v1 build spec §9.1 / §9.3 (P7-95): the one place
// that says how SYB marks what a model made, for every kind of output.
//
//   images, video  the label stamped INTO the file at render (IPTC Digital
//                  Source Type in JPEG XMP; the MP4 comment), read back or
//                  refused — lib/content/generate/label, called only from
//                  the two render paths (label-at-render.test)
//   every asset    a stored labelling record with a C2PA-style provenance
//                  manifest: who made it, how it was marked, to which
//                  standard, when, and who published it (lib/growth/library)
//   generated text the visible disclosure line each path already carries,
//                  plus a machine-readable mark where the channel has one:
//                  an email header on every AI-drafted email
//   interactive    Article 50(1): the widget, support replies and the phone
//                  line say they are an AI first (their own modules)
//
// The Commission's Code of Practice on transparency of AI-generated content
// is the adherence route; these are the marks it asks for.

import { createHash } from "node:crypto";
import { DIGITAL_SOURCE_TYPE } from "../content/generate/label";

export { DIGITAL_SOURCE_TYPE };

/** The standard every mark names. */
export const LABEL_STANDARD =
  "IPTC Digital Source Type trainedAlgorithmicMedia; EU AI Act Art. 50(2)";

/** §9.3: the email header that marks an AI-drafted email, machine-readably. */
export const AI_TEXT_HEADER = "X-AI-Generated";

/** The headers an AI-drafted email carries, beside its visible disclosure line. */
export function aiTextHeaders(): Record<string, string> {
  return { [AI_TEXT_HEADER]: `SYB; ${LABEL_STANDARD}` };
}

export interface ProvenanceManifest {
  /** The C2PA-style claim: what made it and how it was marked. */
  claim_generator: string;
  format: string;
  assertions: (
    | {
        label: "c2pa.actions";
        data: { actions: { action: "c2pa.created"; digitalSourceType: string; when: string }[] };
      }
    | { label: "syb.disclosure"; data: { visible_label: string; method: string; standard: string } }
  )[];
  /** SHA-256 of the labelled file, when the bytes were at hand. */
  asset_sha256: string | null;
}

/** Pure: the manifest stored with a labelling record. */
export function provenanceManifest(args: {
  media: "image" | "video";
  label: string;
  method: string;
  at: Date;
  bytes?: Uint8Array | null;
}): ProvenanceManifest {
  return {
    claim_generator: "SYB",
    format: args.media === "image" ? "image/jpeg" : "video/mp4",
    assertions: [
      {
        label: "c2pa.actions",
        data: {
          actions: [
            {
              action: "c2pa.created",
              digitalSourceType: DIGITAL_SOURCE_TYPE,
              when: args.at.toISOString(),
            },
          ],
        },
      },
      {
        label: "syb.disclosure",
        data: { visible_label: args.label, method: args.method, standard: LABEL_STANDARD },
      },
    ],
    asset_sha256: args.bytes ? createHash("sha256").update(args.bytes).digest("hex") : null,
  };
}
