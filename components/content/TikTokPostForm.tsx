"use client";

// The TikTok post form under an item on /content — 2026-11-08.
//
// TikTok's own posting rules, kept here: the account's nickname shown, so
// the owner knows where it goes; "who can see this post" picked by hand from
// TikTok's live options with NOTHING preselected (and only "Only me" while
// SYB's app is unaudited); comments, duets and stitches off unless turned
// on, and greyed out when the account has them off; the "your brand"
// disclosure off unless turned on; TikTok's music-usage declaration above
// the button. The choice is saved while the post's proposal waits; approving
// the proposal then covers these choices with the caption and the video.

import { useEffect, useState } from "react";
import { useTr } from "../sheet/useTr";

type Privacy = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";

export interface TikTokItemStateLike {
  proposal_id: string;
  proposal_status: string;
  settings: {
    privacy_level: Privacy;
    allow_comment: boolean;
    allow_duet: boolean;
    allow_stitch: boolean;
    brand_organic: boolean;
  } | null;
  can_choose: boolean;
}

interface CreatorView {
  nickname: string | null;
  username: string | null;
  privacy_options: Privacy[];
  audited: boolean;
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
}

export function TikTokPostForm({
  itemId,
  state,
  aiGenerated,
  busy,
  onSaved,
}: {
  itemId: string;
  state: TikTokItemStateLike;
  aiGenerated: boolean;
  busy: boolean;
  onSaved: (notice: string) => Promise<void>;
}) {
  const { tr } = useTr("content");
  const [creator, setCreator] = useState<CreatorView | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [privacy, setPrivacy] = useState<Privacy | "">(state.settings?.privacy_level ?? "");
  const [comment, setComment] = useState(state.settings?.allow_comment ?? false);
  const [duet, setDuet] = useState(state.settings?.allow_duet ?? false);
  const [stitch, setStitch] = useState(state.settings?.allow_stitch ?? false);
  const [brand, setBrand] = useState(state.settings?.brand_organic ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.can_choose) return;
    let live = true;
    // TikTok's rule: the latest creator info, read when the post form renders.
    void fetch("/api/content/tiktok")
      .then(async (res) => {
        const j = (await res.json().catch(() => ({}))) as CreatorView & { error?: string };
        if (!live) return;
        if (!res.ok) setLoadFailed(typeof j.error === "string" ? j.error : tr("tiktok.failedLoad"));
        else setCreator(j);
      })
      .catch(() => live && setLoadFailed(tr("tiktok.failedLoad")));
    return () => {
      live = false;
    };
  }, [state.can_choose]);

  const privacyWord = (p: Privacy) => tr(`tiktok.privacy.${p}`);

  if (!state.can_choose) {
    return (
      <div className="ct-why">
        <p className="cs-label">{tr("tiktok.title")}</p>
        {state.settings ? (
          <p>
            {tr("tiktok.chosen", { privacy: privacyWord(state.settings.privacy_level) })}{" "}
            <span className="src ct-sub">{tr("tiktok.locked")}</span>
          </p>
        ) : (
          <p>{tr("tiktok.needChoice")}</p>
        )}
        {aiGenerated && <p className="src ct-sub">{tr("tiktok.aiLabel")}</p>}
        <p className="src ct-sub">{tr("tiktok.noDelete")}</p>
      </div>
    );
  }

  const save = async () => {
    if (privacy === "") return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/content/tiktok", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          item_id: itemId,
          privacy_level: privacy,
          allow_comment: comment,
          allow_duet: duet,
          allow_stitch: stitch,
          brand_organic: brand,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(typeof j.error === "string" ? j.error : tr("tiktok.failedLoad"));
        return;
      }
      await onSaved(tr("tiktok.saved"));
    } finally {
      setSaving(false);
    }
  };

  const name = creator?.nickname ?? (creator?.username ? `@${creator.username}` : null);
  const toggle = (
    label: string,
    value: boolean,
    set: (v: boolean) => void,
    offOnTikTok: boolean,
  ) => (
    <label className="ct-check">
      <input
        type="checkbox"
        checked={value && !offOnTikTok}
        disabled={offOnTikTok || saving || busy}
        onChange={(e) => set(e.target.checked)}
      />{" "}
      {label}
      {offOnTikTok && <span className="src ct-sub"> · {tr("tiktok.offOnTikTok")}</span>}
    </label>
  );

  return (
    <div className="ct-why" aria-label={tr("tiktok.title")}>
      <p className="cs-label">{tr("tiktok.title")}</p>
      {loadFailed !== null && <p className="cn-error">{loadFailed}</p>}
      {creator === null && loadFailed === null && <p>{tr("tiktok.loading")}</p>}
      {creator !== null && (
        <>
          {name && <p>{tr("tiktok.account", { name })}</p>}
          <label className="ct-field">
            <span className="cs-label">{tr("tiktok.whoSees")}</span>{" "}
            <select
              value={privacy}
              disabled={saving || busy}
              onChange={(e) => setPrivacy(e.target.value as Privacy | "")}
            >
              {/* No default: TikTok requires the owner to pick. */}
              <option value="">{tr("tiktok.choose")}</option>
              {creator.privacy_options.map((p) => (
                <option key={p} value={p}>
                  {privacyWord(p)}
                </option>
              ))}
            </select>
          </label>
          {!creator.audited && <p className="src ct-sub">{tr("tiktok.privateOnly")}</p>}
          {toggle(tr("tiktok.allowComment"), comment, setComment, creator.comment_disabled)}
          {toggle(tr("tiktok.allowDuet"), duet, setDuet, creator.duet_disabled)}
          {toggle(tr("tiktok.allowStitch"), stitch, setStitch, creator.stitch_disabled)}
          <label className="ct-check">
            <input
              type="checkbox"
              checked={brand}
              disabled={saving || busy}
              onChange={(e) => setBrand(e.target.checked)}
            />{" "}
            {tr("tiktok.brand")}
            {brand && <span className="src ct-sub"> · {tr("tiktok.brandNote")}</span>}
          </label>
          {aiGenerated && <p className="src ct-sub">{tr("tiktok.aiLabel")}</p>}
          <p className="src ct-sub">{tr("tiktok.declaration")}</p>
          <p className="src ct-sub">{tr("tiktok.processing")}</p>
          <p className="src ct-sub">{tr("tiktok.noDelete")}</p>
          {error !== null && <p className="cn-error">{error}</p>}
          <button
            type="button"
            className="prop-btn"
            disabled={privacy === "" || saving || busy}
            onClick={() => void save()}
          >
            {saving ? tr("tiktok.saving") : tr("tiktok.save")}
          </button>
        </>
      )}
    </div>
  );
}
