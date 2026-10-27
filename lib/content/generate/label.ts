// Labelling generated media IN THE FILE — P3-53, rule 17.
//
// Whatever a provider returns, SYB stamps it before it goes anywhere, and
// checks the stamp is there after. No provider can skip it: the provider
// returns bytes, this module writes the label, and an unlabelled result
// never reaches an item (generateFromProposal refuses it).
//
//   JPEG: an XMP packet (APP1) carrying the IPTC Digital Source Type
//         "trainedAlgorithmicMedia" — the industry's field for "made by a
//         generative model" — with the label as its description, plus the
//         label as a plain JPEG comment (COM) for any reader that knows no XMP
//   MP4:  the label in the container's comment and description tags, by an
//         FFmpeg stream copy (no re-encode), checked with ffprobe
//
// _Verify at build_: whether Meta keeps IPTC/XMP or C2PA metadata on API
// uploads is undocumented (P3-21b's note). The caption label and
// Instagram's is_ai_generated flag are the disclosures that don't depend on it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import { path as ffprobePath } from "ffprobe-static";
import { ffmpegAvailable } from "../edit";

const run = promisify(execFile);

export const DIGITAL_SOURCE_TYPE =
  "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
const XMP_NS = "http://ns.adobe.com/xap/1.0/\0";

export class LabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabelError";
  }
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.byteLength + 2;
  if (len > 0xffff) throw new LabelError("the label is too long for a JPEG segment");
  const out = new Uint8Array(len + 2);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = len >> 8;
  out[3] = len & 0xff;
  out.set(payload, 4);
  return out;
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.byteLength > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Pure: the JPEG with the generated-media XMP and comment inserted after SOI (and APP0). */
export function stampJpeg(bytes: Uint8Array, label: string): Uint8Array {
  if (!isJpeg(bytes)) throw new LabelError("the generated image isn't a JPEG");
  const enc = new TextEncoder();
  const xmp =
    `<?xpacket begin="\u{feff}" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" Iptc4xmpExt:DigitalSourceType="${DIGITAL_SOURCE_TYPE}">` +
    `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(label)}</rdf:li></rdf:Alt></dc:description>` +
    `</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const app1 = segment(0xe1, new Uint8Array([...enc.encode(XMP_NS), ...enc.encode(xmp)]));
  const com = segment(0xfe, enc.encode(label));
  // JFIF wants APP0 straight after SOI: insert after it when it is there.
  let at = 2;
  if (bytes[2] === 0xff && bytes[3] === 0xe0) at = 4 + ((bytes[4]! << 8) | bytes[5]!);
  const out = new Uint8Array(bytes.byteLength + app1.byteLength + com.byteLength);
  out.set(bytes.subarray(0, at), 0);
  out.set(app1, at);
  out.set(com, at + app1.byteLength);
  out.set(bytes.subarray(at), at + app1.byteLength + com.byteLength);
  return out;
}

/** Pure: what a JPEG says about itself — its comments and whether its XMP marks it generated. */
export function readJpegLabels(bytes: Uint8Array): { comments: string[]; generated: boolean } {
  const dec = new TextDecoder();
  const comments: string[] = [];
  let generated = false;
  let i = 2;
  while (i + 4 <= bytes.byteLength && bytes[i] === 0xff) {
    const marker = bytes[i + 1]!;
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    const payload = bytes.subarray(i + 4, i + 2 + len);
    if (marker === 0xfe) comments.push(dec.decode(payload));
    if (marker === 0xe1) {
      const text = dec.decode(payload);
      if (text.startsWith(XMP_NS) && text.includes(DIGITAL_SOURCE_TYPE)) generated = true;
    }
    i += 2 + len;
  }
  return { comments, generated };
}

/** Stamp an MP4's container tags by stream copy; returns the stamped file's path. */
export async function stampVideo(input: string, output: string, label: string): Promise<string> {
  if (!ffmpegAvailable()) {
    throw new LabelError("a generated clip can't be labelled here (FFmpeg isn't available)");
  }
  await run(ffmpegPath as string, [
    "-y",
    "-i",
    input,
    "-map",
    "0",
    "-c",
    "copy",
    "-metadata",
    `comment=${label}`,
    "-metadata",
    `description=${label}`,
    "-movflags",
    "+faststart",
    output,
  ]);
  return output;
}

/** The comment tag an MP4 carries, read back by ffprobe. */
export async function readVideoComment(file: string): Promise<string | null> {
  const { stdout } = await run(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format_tags=comment",
    "-print_format",
    "json",
    file,
  ]);
  const parsed = JSON.parse(stdout) as { format?: { tags?: { comment?: string } } };
  return parsed.format?.tags?.comment ?? null;
}
