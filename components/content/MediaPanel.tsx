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
//
// L-3c (TASKS-LANGUAGES.md): the panel's own words are the "content"
// catalogue (content.mediaPanel); sizes and costs in the reader's locale,
// the cost in its own currency. A clip's label, a render's note and every
// sentence the server sends (refusals, setup reasons, errors) are shown as
// they are.

import { useState } from "react";
import Link from "next/link";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import { formatMinor, type MediaState } from "./content-view";

interface Item {
  id: string;
  kind: "post" | "email" | "shot_list" | "video";
  title: string;
  scheduled_for: string | null;
  provenance: { item?: { focus?: string } } | null;
}

async function post(
  payload: Record<string, unknown>,
  failed: string,
): Promise<Record<string, unknown>> {
  const res = await fetch("/api/content/media", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof j.error === "string" ? j.error : failed);
  return j;
}

async function uploadOne(item: Item, file: File, mode: "blob" | "direct", tr: Tr): Promise<void> {
  if (mode === "direct") {
    const form = new FormData();
    form.set("item_id", item.id);
    form.set("file", file);
    const res = await fetch("/api/content/media", { method: "POST", body: form });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(j.error ?? tr("mediaPanel.uploadFailed"));
    return;
  }
  const grant = (await post(
    {
      action: "grant",
      item_id: item.id,
      content_type: file.type,
      bytes: file.size,
      name: file.name,
    },
    tr("failed"),
  )) as { clip_id: string; pathname: string; token: string; content_type: string };
  const { put } = await import("@vercel/blob/client");
  await put(grant.pathname, file, {
    access: "public",
    token: grant.token,
    contentType: grant.content_type,
    multipart: file.size > 20 * 1024 * 1024,
  });
  await post({ action: "confirm", item_id: item.id, clip_id: grant.clip_id }, tr("failed"));
}

const mb = (bytes: number | null, tr: Tr, locale: AppLocale) =>
  bytes === null
    ? ""
    : tr("mediaPanel.megabytes", {
        n: num(bytes / 1024 / 1024, bytes < 10 * 1024 * 1024 ? 1 : 0, locale),
      });

/** The AI fallback's clip length, in seconds, as this panel has always stated it. */
const CLIP_SECONDS = 5;

export function MediaPanel(props: {
  item: Item;
  media: MediaState;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onDone: (notice: string) => Promise<void>;
  onPick: (itemId: string) => void;
}) {
  const { item, media } = props;
  const { tr, locale } = useTr("content");
  const send = (payload: Record<string, unknown>) => post(payload, tr("failed"));
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
      setError(e instanceof Error ? e.message : tr("failed"));
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
        setProgress(
          tr("mediaPanel.uploading", { index: i + 1, total: list.length, name: file.name }),
        );
        await uploadOne(item, file, mode, tr);
      }
      return tr("mediaPanel.uploaded", { count: list.length });
    });
  };

  const live =
    footage.render && (footage.render.status === "queued" || footage.render.status === "rendering");
  const hasClips = footage.clips.length > 0;

  return (
    <div className="ct-mediapanel">
      <p className="cs-label ct-gap">{tr("mediaPanel.footage")}</p>
      {hasClips && (
        <ul className="ct-clips">
          {footage.clips.map((c) => (
            <li key={c.id}>
              <span className="ct-mono">{c.label}</span>
              <span className="src">{mb(c.bytes, tr, locale)}</span>
              <button
                type="button"
                className="prop-btn quiet"
                disabled={props.busy || Boolean(live)}
                onClick={() =>
                  void run(async () => {
                    await send({ action: "remove_clip", clip_id: c.id });
                    return tr("mediaPanel.removed");
                  })
                }
              >
                {tr("mediaPanel.remove")}
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
            {tr(`mediaPanel.render.${footage.render.status}`)}
          </span>{" "}
          {footage.render.note ?? (live ? tr("mediaPanel.render.live") : "")}
          {footage.render.status === "rendered" && footage.render.result_item_id && (
            <>
              {" "}
              <button
                type="button"
                className="ct-pick"
                onClick={() => props.onPick(footage.render?.result_item_id as string)}
              >
                {tr("mediaPanel.render.open")}
              </button>
            </>
          )}
        </p>
      )}

      {media.upload_mode === "off" ? (
        <p className="ct-why">{tr("mediaPanel.uploadsOff")}</p>
      ) : (
        <div className="ct-form">
          <label className="cs-label" htmlFor={`ct-clips-${item.id}`}>
            {tr("mediaPanel.upload.label", {
              action: hasClips ? tr("mediaPanel.upload.more") : tr("mediaPanel.upload.first"),
              mp4: "MP4",
              mov: "MOV",
              mb: num(Math.round(media.limits.clip_bytes / 1024 / 1024), 0, locale),
              count: media.limits.clips_per_item,
            })}
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
              await send({
                action: "cut",
                item_id: item.id,
                caption,
                on_screen: onScreen,
                date,
              });
              return tr("mediaPanel.cut.done");
            });
          }}
        >
          {item.kind === "shot_list" && (
            <>
              <label className="cs-label" htmlFor={`ct-cap-${item.id}`}>
                {tr("mediaPanel.cut.caption")}
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
            {tr("mediaPanel.cut.onScreen")}
          </label>
          <input
            id={`ct-os-${item.id}`}
            className="ct-input"
            maxLength={media.limits.on_screen}
            value={onScreen}
            onChange={(e) => setOnScreen(e.target.value)}
          />
          <label className="cs-label" htmlFor={`ct-date-${item.id}`}>
            {tr("mediaPanel.cut.date")}
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
            {tr("mediaPanel.cut.button")}
          </button>
          <p className="ct-fine">{tr("mediaPanel.cut.fine", { ratio: "9:16" })}</p>
        </form>
      )}

      {!hasClips && gen && (
        <div className="ct-fallback">
          <p className="cs-label ct-gap">{tr("mediaPanel.fallback.label")}</p>
          {!media.generation.setup.available ? (
            <p className="ct-why">{media.generation.setup.reason}</p>
          ) : gen.pending_proposal_id ? (
            <p className="ct-why">
              {tr("mediaPanel.fallback.pending")}{" "}
              <Link href="/proposals">{tr("action.decide")}</Link>
            </p>
          ) : gen.approved_proposal_id ? (
            <div className="ct-actions">
              <button
                type="button"
                className="prop-btn"
                disabled={props.busy}
                onClick={() =>
                  void run(async () => {
                    const out = (await send({
                      action: "generate",
                      proposal_id: gen.approved_proposal_id,
                    })) as { note?: string };
                    return out.note ?? tr("mediaPanel.fallback.generated");
                  })
                }
              >
                {tr("mediaPanel.fallback.generate")}
              </button>
              <span className="src">{tr("mediaPanel.fallback.approved")}</span>
            </div>
          ) : gen.refusal ? (
            <p className="ct-why">
              {tr("mediaPanel.fallback.notOffered", { reason: gen.refusal })}
            </p>
          ) : (
            <>
              <p className="ct-prose">
                {tr("mediaPanel.fallback.offer", {
                  image: gen.estimates.image ? formatMinor(gen.estimates.image, locale) : "none",
                  video: gen.estimates.video ? formatMinor(gen.estimates.video, locale) : "none",
                  seconds: num(CLIP_SECONDS, 0, locale),
                })}
              </p>
              <form className="ct-form" onSubmit={(e) => e.preventDefault()}>
                <label className="cs-label" htmlFor={`ct-dir-${item.id}`}>
                  {tr("mediaPanel.fallback.dirLabel")}
                </label>
                <input
                  id={`ct-dir-${item.id}`}
                  className="ct-input"
                  maxLength={300}
                  placeholder={tr("mediaPanel.fallback.dirPlaceholder")}
                  value={direction}
                  onChange={(e) => setDirection(e.target.value)}
                />
              </form>
              <div className="ct-actions">
                {/* P6-03: only what the provider makes (Higgsfield: video, as three candidates). */}
                {(["image", "video"] as const)
                  .filter((m) => gen.estimates[m] !== null)
                  .map((m) => (
                    <button
                      key={m}
                      type="button"
                      className="prop-btn"
                      disabled={props.busy}
                      onClick={() =>
                        void run(async () => {
                          await send({
                            action: "propose_generation",
                            item_id: item.id,
                            media: m,
                            // A candidate set is built from profile facts only (rule 33).
                            direction:
                              m === "video" && (media.generation.setup.candidates ?? 1) > 1
                                ? ""
                                : direction,
                          });
                          return tr("mediaPanel.fallback.proposed");
                        })
                      }
                    >
                      {tr("mediaPanel.fallback.propose", { media: m })}
                    </button>
                  ))}
              </div>
            </>
          )}
          {gen.latest?.status === "failed" && (
            <p className="ct-why">
              <span className="word alarm">{tr("state.failed")}</span>{" "}
              {tr("mediaPanel.fallback.lastTry", {
                error: gen.latest.error ?? "",
                cost: gen.latest.cost ? formatMinor(gen.latest.cost, locale) : "none",
              })}
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="ct-why" role="alert">
          <span className="word alarm">{tr("mediaPanel.refused")}</span> {error}
        </p>
      )}
    </div>
  );
}
