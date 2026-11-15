"use client";

// The Decisions screen's charts (specs/ux-spec-v1.md §8, "Charts on the
// Decisions screen"). Each one draws something the screen already says in
// words, from the same data: the queue's mix, what each waiting item is
// worth, how big a wording change is, when a site change rolls itself
// back, what the evidence rests on, how the decision is built, and the
// way back. Circular charts are drawn as arc-reactor rings: one lit cell
// per item, so a count can be read off the ring. The words stay where
// they were; a chart never replaces them.

import { useId, type CSSProperties, type ReactNode } from "react";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { HEALTH, loadLimits } from "../../lib/site/health-rule";
import { num } from "../sheet/num";
import { pct, type WordChange } from "./chart-model";
import { rangeAxis } from "./queue-model";

const w = (v: number) => ({ "--w": `${v}%` }) as CSSProperties;
const left = (v: number) => ({ "--l": `${v}%` }) as CSSProperties;

export interface RingSlice {
  key: string;
  label: string;
  count: number;
  color: string;
}

/**
 * An arc-reactor ring. The segmented ring is the data, one cell per item;
 * around it a turning tick ring, inside it a counter-turning coil ring,
 * and a lit core carrying the total. Motion stops under reduced motion.
 */
export function Reactor({
  slices,
  center,
  label,
  className,
}: {
  slices: readonly RingSlice[];
  center: string;
  label: string;
  className?: string;
}) {
  const id = useId().replace(/:/g, "");
  const c = 100;
  const at = (r: number, a: number) => [c + r * Math.sin(a), c - r * Math.cos(a)] as const;
  const arc = (r: number, a0: number, a1: number) => {
    const [x0, y0] = at(r, a0);
    const [x1, y1] = at(r, a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  const total = slices.reduce((a, s) => a + s.count, 0);
  const cells: { d: string; color: string; key: string }[] = [];
  if (total > 0) {
    const step = (2 * Math.PI) / total;
    const gap = Math.min(0.06, step * 0.25);
    let n = 0;
    for (const s of slices) {
      for (let u = 0; u < s.count; u++) {
        cells.push({
          key: `${s.key}-${u}`,
          color: s.color,
          d: arc(74, n * step + gap / 2, (n + 1) * step - gap / 2),
        });
        n += 1;
      }
    }
  }
  const ticks = Array.from({ length: 72 }, (_, k) => {
    const a = (k / 72) * 2 * Math.PI;
    const [x0, y0] = at(k % 6 ? 89 : 85, a);
    const [x1, y1] = at(93, a);
    return { k, x0, y0, x1, y1, major: k % 6 === 0 };
  });
  const long = center.length > 3;
  return (
    <svg
      className={`q-reactor${className ? ` ${className}` : ""}`}
      viewBox="0 0 200 200"
      role="img"
      aria-label={label}
    >
      <defs>
        <filter id={`g${id}`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <radialGradient id={`c${id}`}>
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".42" stopColor="#d9f4ff" />
          <stop offset=".72" stopColor="#7fd3ff" />
          <stop offset="1" stopColor="#1d6fa8" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="100" cy="100" r="97" fill="#0a140f" stroke="#22362c" />
      <g className="q-spin">
        {ticks.map((t) => (
          <line
            key={t.k}
            x1={t.x0.toFixed(2)}
            y1={t.y0.toFixed(2)}
            x2={t.x1.toFixed(2)}
            y2={t.y1.toFixed(2)}
            stroke={t.major ? "#6cc4e8" : "#2e5a6e"}
            strokeWidth={t.major ? 1.6 : 1}
          />
        ))}
      </g>
      <circle cx="100" cy="100" r="74" fill="none" stroke="#16262d" strokeWidth="13" />
      <g filter={`url(#g${id})`}>
        {cells.map((cell) => (
          <path key={cell.key} d={cell.d} fill="none" stroke={cell.color} strokeWidth="11" />
        ))}
      </g>
      <circle cx="100" cy="100" r="63" fill="none" stroke="#2e5a6e" />
      <g className="q-spin q-spin-rev">
        {Array.from({ length: 10 }, (_, k) => (
          <rect
            key={k}
            x="94"
            y="45"
            width="12"
            height="11"
            rx="1.5"
            fill="#bfe9fb"
            opacity=".8"
            transform={`rotate(${k * 36} 100 100)`}
          />
        ))}
      </g>
      <circle
        className="q-pulse"
        cx="100"
        cy="100"
        r="40"
        fill={`url(#c${id})`}
        filter={`url(#g${id})`}
      />
      <circle cx="100" cy="100" r="25" fill="#ffffff" opacity=".9" />
      <text
        x="100"
        y={long ? 108 : 111}
        textAnchor="middle"
        fontSize={long ? 24 : 30}
        fontWeight="700"
        fill="#0a140f"
      >
        {center}
      </text>
    </svg>
  );
}

/** The ring's legend: a swatch, the word, the count. */
export function RingKey({ slices, locale }: { slices: readonly RingSlice[]; locale: AppLocale }) {
  return (
    <ul className="q-ring-key">
      {slices.map((s) => (
        <li key={s.key}>
          <i style={{ background: s.color }} aria-hidden="true" />
          <span>{s.label}</span>
          <b>{num(s.count, 0, locale)}</b>
        </li>
      ))}
    </ul>
  );
}

/** The masthead's small ring: this month's decisions, approved lit, the rest coral. */
export function MastRing({
  approved,
  decided,
  label,
}: {
  approved: number;
  decided: number;
  label: string;
}) {
  const id = useId().replace(/:/g, "");
  const r = 10;
  const C = 2 * Math.PI * r;
  const share = decided > 0 ? approved / decided : 0;
  return (
    <svg
      className="q-mast-ring"
      width="26"
      height="26"
      viewBox="0 0 26 26"
      role="img"
      aria-label={label}
    >
      <defs>
        <radialGradient id={`m${id}`}>
          <stop offset="0" stopColor="#fff" />
          <stop offset=".55" stopColor="#9fe3ff" />
          <stop offset="1" stopColor="#2b8fd1" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="13" cy="13" r={r} fill="none" stroke="#ff9d92" strokeWidth="2.5" />
      {share > 0 && (
        <circle
          cx="13"
          cy="13"
          r={r}
          fill="none"
          stroke="#9fe3ff"
          strokeWidth="2.5"
          strokeDasharray={`${(share * C).toFixed(2)} ${C.toFixed(2)}`}
          transform="rotate(-90 13 13)"
        />
      )}
      <circle cx="13" cy="13" r="6" fill={`url(#m${id})`} />
    </svg>
  );
}

/** A waiting item's value on the shared scale; hatched when there is no money range. */
export function ValueBar({
  low,
  high,
  top,
  label,
  caption,
}: {
  low: number | null;
  high: number | null;
  top: number | null;
  label: string;
  caption: string;
}) {
  const priced = low !== null && high !== null && top !== null;
  return (
    <span className="q-vbar">
      <span className={`q-vbar-track${priced ? "" : " none"}`} role="img" aria-label={label}>
        {priced && (
          <i
            style={{ ...left(pct(Math.min(low, high), top)), ...w(pct(Math.abs(high - low), top)) }}
          />
        )}
      </span>
      <small>{caption}</small>
    </span>
  );
}

/** A figure frame: a caption naming the chart, an optional unit, the chart, an optional note. */
function Fig({
  title,
  unit,
  note,
  children,
  className,
}: {
  title: string;
  unit?: string;
  note?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={`q-fig${className ? ` ${className}` : ""}`}>
      <figcaption>
        {title}
        {unit && <span>{unit}</span>}
      </figcaption>
      {children}
      {note && <p className="q-fig-note">{note}</p>}
    </figure>
  );
}

/** How big a wording change is: words before, and after split into kept and added. */
export function ChangeSize({
  change,
  tr,
  locale,
}: {
  change: WordChange;
  tr: Tr;
  locale: AppLocale;
}) {
  const top = Math.max(change.before, change.after);
  const n = (v: number) => num(v, 0, locale);
  return (
    <Fig title={tr("chart.size.title")} unit={tr("chart.size.unit")}>
      <div
        className="q-bars"
        role="img"
        aria-label={tr("chart.size.aria", {
          before: n(change.before),
          after: n(change.after),
          kept: n(change.kept),
          added: n(change.added),
          removed: n(change.removed),
        })}
      >
        <span className="q-bars-lab">{tr("chart.size.before")}</span>
        <span className="q-bars-track">
          <i className="kept" style={w(pct(change.kept, top))} />
          <i className="out" style={w(pct(change.removed, top))} />
        </span>
        <b>{tr("chart.size.words", { count: change.before })}</b>
        <span className="q-bars-lab">{tr("chart.size.after")}</span>
        <span className="q-bars-track">
          <i className="kept" style={w(pct(change.kept, top))} />
          <i className="in" style={w(pct(change.added, top))} />
        </span>
        <b>{tr("chart.size.words", { count: change.after })}</b>
      </div>
      <ul className="q-fig-key" aria-hidden="true">
        <li>
          <i className="kept" />
          {tr("chart.size.kept", { count: n(change.kept) })}
        </li>
        <li>
          <i className="in" />
          {tr("chart.size.added", { count: n(change.added) })}
        </li>
        <li>
          <i className="out" />
          {tr("chart.size.removed", { count: n(change.removed) })}
        </li>
      </ul>
    </Fig>
  );
}

/** A site change's load today against the load it rolls back past (lib/site/health-rule.ts). */
export function RollbackBars({
  baselineMs,
  tr,
  locale,
}: {
  baselineMs: number;
  tr: Tr;
  locale: AppLocale;
}) {
  const { times, plus, limit } = loadLimits(baselineMs);
  const axis = rangeAxis(0, limit);
  const top = axis.scale[1];
  const ms = (v: number) => tr("chart.rollback.ms", { ms: num(v, 0, locale) });
  return (
    <Fig
      title={tr("chart.rollback.title")}
      unit={tr("chart.rollback.unit")}
      note={tr("chart.rollback.note", {
        factor: num(HEALTH.load_factor, 0, locale),
        times: ms(times),
        seconds: num(HEALTH.load_floor_ms / 1000, 0, locale),
        plus: ms(plus),
      })}
    >
      <div
        className="q-bars q-bars-axis"
        role="img"
        aria-label={tr("chart.rollback.aria", { today: ms(baselineMs), limit: ms(limit) })}
      >
        <span className="q-bars-lab">{tr("chart.rollback.today")}</span>
        <span className="q-bars-track">
          <i className="ink" style={w(pct(baselineMs, top))} />
        </span>
        <b>{ms(baselineMs)}</b>
        <span className="q-bars-lab">{tr("chart.rollback.past")}</span>
        <span className="q-bars-track">
          <i className="limit" style={w(pct(limit, top))} />
        </span>
        <b>{ms(limit)}</b>
        <span />
        <span className="q-ticks-row" aria-hidden="true">
          {axis.ticks.map((t) => (
            <span key={t} style={left(pct(t, top))}>
              {num(t, 0, locale)}
            </span>
          ))}
        </span>
        <span />
      </div>
    </Fig>
  );
}

/** What the evidence rests on, as a reactor ring: one cell per evidence line, by basis. */
export function EvidenceRing({
  slices,
  tr,
  locale,
}: {
  slices: readonly RingSlice[];
  tr: Tr;
  locale: AppLocale;
}) {
  const total = slices.reduce((a, s) => a + s.count, 0);
  const weakest = slices.filter((s) => s.count > 0).at(-1);
  const center =
    weakest && weakest.count === total
      ? `${num(total, 0, locale)}/${num(total, 0, locale)}`
      : num(total, 0, locale);
  return (
    <Fig title={tr("chart.evidence.title")} className="q-fig-ring">
      <div className="q-ring-row">
        <Reactor
          slices={slices}
          center={center}
          label={tr("chart.evidence.aria", {
            count: total,
            parts: slices
              .filter((s) => s.count > 0)
              .map((s) => `${s.label} ${num(s.count, 0, locale)}`)
              .join(", "),
          })}
        />
        <RingKey slices={slices} locale={locale} />
      </div>
    </Fig>
  );
}

/** How the decision is built: the question, what it rests on, and the facts under them. */
export function DecisionTree({
  facts,
  rules,
  disagreements,
  tr,
  locale,
}: {
  facts: { basisLabel: string }[];
  rules: number;
  disagreements: number;
  tr: Tr;
  locale: AppLocale;
}) {
  const n = (v: number) => num(v, 0, locale);
  const shown = facts.slice(0, 6);
  const more = facts.length - shown.length;
  const bases = new Map<string, number>();
  for (const f of facts) bases.set(f.basisLabel, (bases.get(f.basisLabel) ?? 0) + 1);
  const factsSub = [...bases].map(([b, c]) => `${b} ${n(c)}`).join(" · ");
  return (
    <Fig title={tr("chart.tree.title")} className="q-fig-tree">
      <div
        className="q-tree"
        role="img"
        aria-label={tr("chart.tree.aria", { facts: facts.length, rules, disagreements })}
      >
        <div className="q-tree-root">{tr("chart.tree.root")}</div>
        <ul className="q-tree-kids">
          <li>
            <div className="q-tree-node">
              <b>{tr("chart.tree.facts", { count: facts.length })}</b>
              {factsSub && <span>{factsSub}</span>}
            </div>
            {shown.length > 0 && (
              <ul className="q-tree-kids q-tree-leaves">
                {shown.map((f, i) => (
                  <li key={i}>
                    <div className="q-tree-node leaf">
                      <b>{tr("chart.tree.fact", { n: n(i + 1) })}</b>
                      <span>{f.basisLabel}</span>
                    </div>
                  </li>
                ))}
                {more > 0 && (
                  <li>
                    <div className="q-tree-node leaf">
                      <span>{tr("chart.tree.more", { count: n(more) })}</span>
                    </div>
                  </li>
                )}
              </ul>
            )}
          </li>
          {rules > 0 && (
            <li>
              <div className="q-tree-node yours">
                <b>{tr("chart.tree.rules", { count: rules })}</b>
                <span>{tr("chart.tree.rulesSub")}</span>
              </div>
            </li>
          )}
          {disagreements > 0 && (
            <li>
              <div className="q-tree-node">
                <b>{tr("chart.tree.disagree", { count: disagreements })}</b>
                <span>{tr("chart.tree.disagreeSub")}</span>
              </div>
            </li>
          )}
        </ul>
      </div>
    </Fig>
  );
}

/** The way back: stored, changed, one click back — and, for a site change, back by itself. */
export function WayBack({
  autoMs,
  tr,
  locale,
}: {
  autoMs: number | null;
  tr: Tr;
  locale: AppLocale;
}) {
  return (
    <Fig title={tr("chart.way.title")}>
      <div
        className="q-way"
        role="img"
        aria-label={
          autoMs === null
            ? tr("chart.way.aria")
            : tr("chart.way.ariaAuto", { ms: num(autoMs, 0, locale) })
        }
      >
        <span className="q-way-box">{tr("chart.way.now")}</span>
        <span className="q-way-arrow">{tr("chart.way.stored")}</span>
        <span className="q-way-box ink">{tr("chart.way.changed")}</span>
        <span className="q-way-arrow">{tr("chart.way.click")}</span>
        <span className="q-way-box back">{tr("chart.way.back")}</span>
      </div>
      {autoMs !== null && (
        <p className="q-way-auto">
          <span aria-hidden="true">↺ </span>
          {tr("chart.way.auto", { ms: num(autoMs, 0, locale) })}
        </p>
      )}
    </Fig>
  );
}
