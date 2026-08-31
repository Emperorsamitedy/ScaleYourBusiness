"use client";

// The spec's FadingVideo: fades in on loadeddata over 500ms, fades out
// over the last 550ms of each play, then loops (single src) or advances
// (array), driven by requestAnimationFrame.

import { useCallback, useEffect, useRef, useState } from "react";

const FADE_IN_MS = 500;
const FADE_OUT_MS = 550;
const FADE_OUT_REMAINING = 0.55;

export function FadingVideo({
  src,
  className,
  style,
}: {
  src: string | string[];
  className?: string;
  style?: React.CSSProperties;
}) {
  const sources = Array.isArray(src) ? src : [src];
  const [index, setIndex] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const raf = useRef(0);
  const fadingOut = useRef(false);

  const fade = useCallback((from: number, to: number, ms: number, done?: () => void) => {
    cancelAnimationFrame(raf.current);
    const el = videoRef.current;
    if (!el) return;
    const t0 = performance.now();
    const tick = (now: number): void => {
      const p = Math.min(1, (now - t0) / ms);
      el.style.opacity = String(from + (to - from) * p);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else done?.();
    };
    raf.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const onLoaded = (): void => {
      fadingOut.current = false;
      fade(0, 1, FADE_IN_MS);
    };
    const onTime = (): void => {
      if (fadingOut.current || !el.duration) return;
      if (el.duration - el.currentTime <= FADE_OUT_REMAINING) {
        fadingOut.current = true;
        fade(1, 0, FADE_OUT_MS);
      }
    };
    const onEnded = (): void => {
      if (sources.length === 1) {
        el.currentTime = 0;
        void el.play();
        fadingOut.current = false;
        fade(0, 1, FADE_IN_MS);
      } else {
        setIndex((i) => (i + 1) % sources.length);
      }
    };

    el.addEventListener("loadeddata", onLoaded);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnded);
    return () => {
      cancelAnimationFrame(raf.current);
      el.removeEventListener("loadeddata", onLoaded);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnded);
    };
  }, [fade, sources.length, index]);

  return (
    <video
      ref={videoRef}
      key={sources[index]}
      src={sources[index]}
      className={className}
      style={{ opacity: 0, ...style }}
      autoPlay
      muted
      playsInline
      preload="auto"
    />
  );
}
