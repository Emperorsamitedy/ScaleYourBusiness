"use client";

// Home's live line (specs/ux-spec-v1.md §2.1, "The live line"): people on
// the business's own site in each of the last minutes, from its Google
// Analytics connection (GET /api/live/visitors). Drawn the way a trading
// chart draws a price: a zigzag through the minutes, a dashed baseline at
// the window's first reading, green above it and red below, the scale on
// the right with the latest figure tagged on it, and a crosshair that reads
// any minute.
//
// It is live in two true ways: the reading is fetched again every half
// minute while the tab shows, and the window slides on with the clock in
// between. A reading older than STALE_MS turns the line grey and says when
// it was taken; with no connection the row says what would start it.

import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import Link from "next/link";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import { useChartWidth } from "../charts/useChartWidth";
import { stepKey } from "../../lib/charts/keys";
import { intlTag } from "../../lib/i18n/locales";
import type { AppLocale } from "../../lib/i18n/locales";
import type { LiveVisitors as Reading } from "../../lib/live/visitors";
import { change, fillOf, livePoints, liveScale, pathOf, splitAtBaseline } from "./live-model";

const POLL_MS = 30_000;
const STALE_MS = 3 * 60_000;
const WINDOWS = [15, 30] as const;
type Window = (typeof WINDOWS)[number];

const AXIS_W = 64;
const RIGHT_ROOM = 56;
const H = 190;
const TOP = 14;
const BOT = 152;
const TIME_Y = 162;

const tagOf = (locale: AppLocale) => (locale === "en" ? "en-GB" : intlTag(locale));
const timeOf = (ms: number, locale: AppLocale) =>
  new Date(ms).toLocaleTimeString(tagOf(locale), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** GET the reading now and every POLL_MS while the tab shows; the last live one is kept. */
function useLive() {
  const [latest, setLatest] = useState<Reading | null>(null);
  const [lastLive, setLastLive] = useState<Extract<Reading, { status: "live" }> | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/live/visitors", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<Reading>) : null))
        .then((d) => {
          if (!alive || !d) return;
          setLatest(d);
          if (d.status === "live") setLastLive(d);
        })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    document.addEventListener("visibilitychange", read);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, []);
  return { latest, lastLive };
}

/** The reader's clock every second, so the window slides on between readings. */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function LiveVisitors({
  onStatus,
}: {
  /** Tells Home what the line is doing, so its next steps can offer the missing connection. */
  onStatus?: (status: Reading["status"]) => void;
} = {}) {
  const { tr, locale } = useTr("home.live");
  const { latest, lastLive } = useLive();
  const status = latest?.status ?? null;
  useEffect(() => {
    if (status !== null) onStatus?.(status);
  }, [status, onStatus]);
  const now = useNow();
  const [win, setWin] = useState<Window>(30);
  const [at, setAt] = useState<number | null>(null);
  const { ref, width, narrow } = useChartWidth<HTMLDivElement>(900);

  const readAt = lastLive ? Date.parse(lastLive.read_at) : null;
  const points = useMemo(
    () =>
      lastLive && readAt !== null && now !== null
        ? livePoints(lastLive.minutes, readAt, Math.max(now, readAt), win)
        : [],
    [lastLive, readAt, now, win],
  );

  // One root that always exists, so the chart is measured even before its first reading.
  const head = (body: ReactNode, chart: ReactNode = null) => (
    <div className="lv" ref={ref}>
      <div className="lv-head">
        <p className="cs-label lv-name">{tr("label")}</p>
        {body}
      </div>
      {chart}
    </div>
  );

  if (!latest && !lastLive) return head(null);
  if (!lastLive || points.length < 2 || now === null || readAt === null) {
    const why =
      latest?.status === "not_connected"
        ? "notConnected"
        : latest?.status === "paused"
          ? "paused"
          : latest?.status === "unavailable"
            ? "unavailable"
            : null;
    if (why === null) return head(null);
    return head(
      <>
        <p className="lv-why">{tr(why)}</p>
        {why !== "unavailable" && (
          <Link href="/connections" className="lv-link">
            {tr("connect")}
          </Link>
        )}
      </>,
    );
  }

  const stale = now - readAt > STALE_MS || latest?.status !== "live";
  const plotR = width - AXIS_W;
  const tipX = plotR - RIGHT_ROOM;
  const from = now - win * 60_000;
  const x = (t: number) => ((t - from) / (now - from)) * tipX;
  const scale = liveScale(points.map((p) => p.value));
  const y = (v: number) => BOT - ((v - scale.lo) / (scale.hi - scale.lo)) * (BOT - TOP);

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const by = y(first.value);
  const split = splitAtBaseline(
    points.map((p) => ({ x: x(p.at), y: y(p.value) })),
    by,
  );
  const up = last.value >= first.value;

  const shown = at !== null ? (points[Math.min(at, points.length - 1)] ?? last) : last;
  const delta = change(first.value, shown.value);
  const people = (n: number) => tr("people", { count: n });
  const sign = delta.diff >= 0 ? "+" : "−";
  const changeText = `${delta.diff >= 0 ? "▲" : "▼"} ${sign}${num(Math.abs(delta.diff), 0, locale)}${
    delta.share === null ? "" : ` (${sign}${num(Math.abs(delta.share * 100), 0, locale)}%)`
  }`;

  const step = win === 15 || narrow ? (win === 15 ? 5 : 15) : 10;
  const ticksX: number[] = [];
  const firstTick = Math.ceil(from / (step * 60_000)) * step * 60_000;
  for (let t = firstTick; t <= now; t += step * 60_000) ticksX.push(t);

  const prev = points[points.length - 2]!;
  const heading =
    (Math.atan2(y(last.value) - y(prev.value), Math.max(1, x(last.at) - x(prev.at))) * 180) /
    Math.PI;
  const tag = (v: number) => Math.max(0, Math.min(BOT, y(v) - 10));
  const tone = stale ? "stale" : up ? "up" : "down";

  const pick = (ev: PointerEvent<SVGSVGElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * width;
    if (px > plotR) return setAt(null);
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.at) - px) < Math.abs(x(points[best]!.at) - px)) best = i;
    });
    setAt(best);
  };
  const onKey = (ev: KeyboardEvent<SVGSVGElement>) => {
    const { next, handled } = stepKey(ev.key, at, points.length);
    if (!handled) return;
    ev.preventDefault();
    setAt(next);
  };
  const hover = at !== null ? points[at] : null;

  return head(
    <>
      <p className="lv-legend" aria-live="polite">
        <b className="lv-value">{people(shown.value)}</b>
        <span className={`lv-change ${delta.diff >= 0 ? "up" : "down"}`}>{changeText}</span>
        <span className="lv-when">
          {stale
            ? tr("lastRead", { time: timeOf(readAt, locale) })
            : hover
              ? `${timeOf(hover.at, locale)} · ${tr("since", { time: timeOf(first.at, locale) })}`
              : tr("since", { time: timeOf(first.at, locale) })}
        </span>
      </p>
      <div className="lv-tabs" role="group" aria-label={tr("windowGroup")}>
        {WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            aria-pressed={win === w}
            onClick={() => {
              setWin(w);
              setAt(null);
            }}
          >
            {tr("window", { minutes: w })}
          </button>
        ))}
      </div>
    </>,
    <div className={`lv-plot ${tone}`}>
      <svg
        width={width}
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        role="img"
        aria-label={tr("summary", {
          now: people(last.value),
          time: timeOf(first.at, locale),
          base: people(first.value),
        })}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setAt(null)}
        onPointerMove={pick}
        onPointerLeave={() => setAt(null)}
      >
        {scale.ticks.map((t) => (
          <line key={`y${t}`} className="lv-grid" x1={0} x2={plotR} y1={y(t)} y2={y(t)} />
        ))}
        {ticksX.map((t) => (
          <line key={`x${t}`} className="lv-grid" x1={x(t)} x2={x(t)} y1={0} y2={TIME_Y} />
        ))}
        <line className="lv-axis" x1={plotR + 0.5} x2={plotR + 0.5} y1={0} y2={H} />
        <line className="lv-axis" x1={0} x2={width} y1={TIME_Y + 0.5} y2={TIME_Y + 0.5} />
        <path className="lv-fill-up" d={fillOf(split.up, by)} />
        <path className="lv-fill-down" d={fillOf(split.down, by)} />
        <line className="lv-base" x1={0} x2={plotR} y1={by} y2={by} />
        <line
          className="lv-level"
          x1={x(last.at)}
          x2={plotR}
          y1={y(last.value)}
          y2={y(last.value)}
        />
        <path className="lv-line-up" d={pathOf(split.up)} />
        <path className="lv-line-down" d={pathOf(split.down)} />
        <polygon
          className="lv-arrow"
          points="1,-6 13,0 1,6"
          transform={`translate(${x(last.at).toFixed(1)} ${y(last.value).toFixed(1)}) rotate(${Math.max(-60, Math.min(60, heading)).toFixed(1)})`}
        />
        {hover && (
          <>
            <line className="lv-cross" x1={x(hover.at)} x2={x(hover.at)} y1={0} y2={TIME_Y} />
            <line className="lv-cross" x1={0} x2={plotR} y1={y(hover.value)} y2={y(hover.value)} />
            <rect
              className="lv-dot"
              x={x(hover.at) - 4}
              y={y(hover.value) - 4}
              width={8}
              height={8}
            />
          </>
        )}
        {scale.ticks.map((t) => (
          <text key={`l${t}`} className="lv-tick" x={plotR + 8} y={y(t) + 4}>
            {num(t, 0, locale)}
          </text>
        ))}
        {ticksX
          .filter((t) => x(t) > 24 && x(t) < plotR - 24)
          .map((t) => (
            <text key={`t${t}`} className="lv-tick" x={x(t)} y={TIME_Y + 18} textAnchor="middle">
              {timeOf(t, locale)}
            </text>
          ))}
      </svg>
      <span
        className="lv-tag base"
        style={{ top: tag(first.value) }}
        hidden={Math.abs(tag(first.value) - tag(last.value)) < 22}
      >
        {num(first.value, 0, locale)}
      </span>
      <span className="lv-tag now" style={{ top: tag(last.value) }}>
        {num(last.value, 0, locale)}
      </span>
      {hover && (
        <>
          <span className="lv-tag cross" style={{ top: tag(hover.value) }}>
            {num(hover.value, 0, locale)}
          </span>
          <span
            className="lv-time"
            style={{ left: Math.max(0, Math.min(plotR - 64, x(hover.at) - 32)) }}
          >
            {timeOf(hover.at, locale)}
          </span>
        </>
      )}
      <div className="sr-only">
        <table>
          <caption>{tr("caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{tr("colTime")}</th>
              <th scope="col">{tr("colPeople")}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.at}>
                <th scope="row">{timeOf(p.at, locale)}</th>
                <td>{num(p.value, 0, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>,
  );
}
