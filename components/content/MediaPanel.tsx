"use client";

// Footage in (P3-52) and the AI fallback (P3-53), under an item on /content
// that can take media — a shot list, or a post that needs a picture.
//
// Top to bottom: the clips the owner has uploaded, the upload control, the
// cut (caption, on-screen line, date) and where the last cut stands; then,
// only when there is no footage, the fallback: what generating would cost
// and that it is labelled as AI-generated — a PROPOSAL, decided in the
// queue, then "Generate it" once approved. Real footage first, always.
//
// Uploads go straight to Vercel Blob on a short-lived grant when the server
// has storage set up ("blob"), through SYB to the local store in
// development ("direct"), and are switched off otherwise ("off").

import { useState } from "react";
import Link from "next/link";
import { formatMinor, type MediaState } from "./content-view";

interface Item {
  id: string;
  kind: "post" | "email" | "shot_list" | "video";
  title: string;
  scheduled_for: string | null;
  provenance: { item?: { focus?: string } } | null;
}

async function post(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch("/api/content/media", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof j.error === "string" ? j.error : "that didn't work");
  return j;
}

async function uploadOne(item: Item, file: File, mode: "blob" | "direct"): Promise<void> {
  if (mode === "direct") {
    const form = new FormData();
    form.set("item_id", item.id);
    form.set("file", file);
    const res = await fetch("/api/content/media", { method: "POST", body: form });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(j.error ?? "the upload didn't work");
    return;
  }
  const grant = (await post({
    action: "grant",
    item_id: item.id,
    content_type: file.type,
    bytes: file.size,
    name: file.name,
  })) as { clip_id: string; pathname: string; token: string; content_type: string };
  const { put } = await import("@vercel/blob/client");
  await put(grant.pathname, file, {
    access: "public",
    token: grant.token,
    contentType: grant.content_type,
    multipart: file.size > 20 * 1024 * 1024,
  });
  await post({ action: "confirm", item_id: item.id, clip_id: grant.clip_id });
}

const mb = (bytes: number | null) =>
  bytes === null ? "" : `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function MediaPanel(props: {
  item: Item;
  media: MediaState;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onDone: (notice: string) => Promise<void>;
  onPick: (itemId: string) => void;
}) {
  const { item, media } = props;
  const footage = media.footage[item.id] ?? { clips: [], render: null };
  const gen = media.generation.items[item.id];
  const [caption, setCaption] = useState(item.provenance?.item?.focus ?? "");
  const [onScreen, setOnScreen] = useState("");
  const [date, setDate] = useState(item.scheduled_for ?? "");
  const [direction, setDirection] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<string>) => {
    props.setBusy(true);
    setError(null);
    try {
      const notice = await work();
      await props.onDone(notice);
    } catch (e) {
      setError(e instanceof Error ? e.message : "that didn't work");
    } finally {
      setProgress(null);
      props.setBusy(false);
    }
  };

  const upload = (files: FileList | null) => {
    if (!files || files.length === 0 || media.upload_mode === "off") return;
    const list = [...files];
    const mode = media.upload_mode;
    void run(async () => {
      for (const [i, file] of list.entries()) {
        setProgress(`Uploading ${i + 1} of ${list.length}: ${file.name}`);
        await uploadOne(item, file, mode);
      }
      return list.length === 1 ? "Clip uploaded." : `${list.length} clips uploaded.`;
    });
  };

  const live =
    footage.render && (footage.render.status === "queued" || footage.render.status === "rendering");
  const hasClips = footage.clips.length > 0;

  return (
    <div className="ct-mediapanel">
      <p className="cs-label ct-gap">Footage</p>
      {hasClips && (
        <ul className="ct-clips">
          {footage.clips.map((c) => (
            <li key={c.id}>
              <span className="ct-mono">{c.label}</span>
              <span className="src">{mb(c.bytes)}</span>
              <button
                type="button"
                className="prop-btn quiet"
                disabled={props.busy || Boolean(live)}
                onClick={() =>
                  void run(async () => {
                    await post({ action: "remove_clip", clip_id: c.id });
                    return "Clip removed.";
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {footage.render && (
        <p className="ct-why">
          <span
            className={`word boxed ${footage.render.status === "failed" ? "alarm" : footage.render.status === "rendered" ? "ok" : "live"}`}
          >
            {footage.render.status === "rendering" ? "cutting" : footage.render.status}
          </span>{" "}
          {footage.render.note ??
            (live ? "The cutting room is on it. This takes a minute or two." : "")}
          {footage.render.status === "rendered" && footage.render.result_item_id && (
            <>
              {" "}
              <button
                type="button"
                className="ct-pick"
                onClick={() => props.onPick(footage.render?.result_item_id as string)}
              >
                Open the video
              </button>
            </>
          )}
        </p>
      )}

      {media.upload_mode === "off" ? (
        <p className="ct-why">
          Uploads aren&apos;t set up on this server, so footage can&apos;t come in here yet.
        </p>
      ) : (
        <div className="ct-form">
          <label className="cs-label" htmlFor={`ct-clips-${item.id}`}>
            {hasClips ? "Add more clips" : "Upload what you filmed"} — MP4 or MOV, up to{" "}
            {Math.round(media.limits.clip_bytes / 1024 / 1024)} MB each,{" "}
            {media.limits.clips_per_item} clips at most
          </label>
          <input
            id={`ct-clips-${item.id}`}
            className="ct-input ct-file"
            type="file"
            accept="video/mp4,video/quicktime"
            multiple
            disabled={props.busy || Boolean(live)}
            onChange={(e) => {
              upload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      )}
      {progress && (
        <p className="ct-why" aria-live="polite">
          {progress}
        </p>
      )}

      {hasClips && !live && (
        <form
          className="ct-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await post({
                action: "cut",
                item_id: item.id,
                caption,
                on_screen: onScreen,
                date,
              });
              return "Cutting. The video appears in the queue when it's done.";
            });
          }}
        >
          {item.kind === "shot_list" && (
            <>
              <label className="cs-label" htmlFor={`ct-cap-${item.id}`}>
                Caption — what the post says under the video
              </label>
              <textarea
                id={`ct-cap-${item.id}`}
                className="ct-input ct-textarea"
                maxLength={media.limits.caption}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
              />
            </>
          )}
          <label className="cs-label" htmlFor={`ct-os-${item.id}`}>
            On-screen line (optional, burned into the video)
          </label>
          <input
            id={`ct-os-${item.id}`}
            className="ct-input"
            maxLength={media.limits.on_screen}
            value={onScreen}
            onChange={(e) => setOnScreen(e.target.value)}
          />
          <label className="cs-label" htmlFor={`ct-date-${item.id}`}>
            Goes out on
          </label>
          <input
            id={`ct-date-${item.id}`}
            className="ct-input"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <button
            className="prop-btn"
            disabled={props.busy || (item.kind === "shot_list" && caption.trim() === "")}
          >
            Cut it
          </button>
          <p className="ct-fine">
            Trimmed, framed 9:16 and captioned from your own clips; licensed music only. Labelled
            &ldquo;AI-assisted edit of real footage&rdquo;. It is offered for publishing after, with
            its own yes in the queue.
          </p>
        </form>
      )}

      {!hasClips && gen && (
        <div className="ct-fallback">
          <p className="cs-label ct-gap">No footage? The AI fallback</p>
          {!media.generation.setup.available ? (
            <p className="ct-why">{media.generation.setup.reason}</p>
          ) : gen.pending_proposal_id ? (
            <p className="ct-why">
              Generating media for this is waiting for your decision.{" "}
              <Link href="/proposals">Decide in the queue →</Link>
            </p>
          ) : gen.approved_proposal_id ? (
            <div className="ct-actions">
              <button
                type="button"
                className="prop-btn"
                disabled={props.busy}
                onClick={() =>
                  void run(async () => {
                    const out = (await post({
                      action: "generate",
                      proposal_id: gen.approved_proposal_id,
                    })) as { note?: string };
                    return out.note ?? "Generated.";
                  })
                }
              >
                Generate it
              </button>
              <span className="src">Approved. Generating spends the stated cost.</span>
            </div>
          ) : gen.refusal ? (
            <p className="ct-why">Not offered: {gen.refusal}.</p>
          ) : (
            <>
              <p className="ct-prose">
                SYB can propose generating an image
                {gen.estimates.image ? ` (about ${formatMinor(gen.estimates.image)})` : ""} or a
                5-second clip
                {gen.estimates.video ? ` (about ${formatMinor(gen.estimates.video)})` : ""} from
                this item&apos;s own words. It is labelled as AI-generated in the file and the
                caption, never shows a real person or a brand, and needs your yes twice: to
                generate, then to publish. Your own footage replaces it whenever you film it.
              </p>
              <form className="ct-form" onSubmit={(e) => e.preventDefault()}>
                <label className="cs-label" htmlFor={`ct-dir-${item.id}`}>
                  What it should show (optional)
                </label>
                <input
                  id={`ct-dir-${item.id}`}
                  className="ct-input"
                  maxLength={300}
                  placeholder="a bowl of pumpkin soup, top down"
                  value={direction}
                  onChange={(e) => setDirection(e.target.value)}
                />
              </form>
              <div className="ct-actions">
                {(["image", "video"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="prop-btn"
                    disabled={props.busy}
                    onClick={() =>
                      void run(async () => {
                        await post({
                          action: "propose_generation",
                          item_id: item.id,
                          media: m,
                          direction,
                        });
                        return "Proposed. It's in your approval queue with its cost.";
                      })
                    }
                  >
                    Propose {m === "image" ? "an image" : "a clip"}
                  </button>
                ))}
              </div>
            </>
          )}
          {gen.latest?.status === "failed" && (
            <p className="ct-why">
              <span className="word alarm">failed</span> The last try: {gen.latest.error}
              {gen.latest.cost ? ` (${formatMinor(gen.latest.cost)} charged)` : ""}.
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="ct-why" role="alert">
          <span className="word alarm">refused</span> {error}
        </p>
      )}
    </div>
  );
}
