// Ledgerline annotation engine
// ─────────────────────────────
// The pen marks on a diagnosis report are NOT decoration and must never be
// hand-placed: every report has different numbers, a different worst offer,
// maybe no contradiction at all. So marks are derived.
//
//   report data  →  RULES (which marks are earned)  →  ink layer (where they go)
//
// Rules return candidates with a priority; only the top MAX_MARKS survive, so
// a rich profile doesn't end up scribbled over. Anchors are DOM elements
// tagged data-anno="key" — never pixel offsets — and every mark is
// re-measured on resize, so the ink follows the layout instead of fighting it.

export const MAX_MARKS = 7;

/* ── formatting helpers (Hungarian-style spaced thousands) ── */
export const fmt = (n) => Math.round(n).toLocaleString("en-US").replace(/,/g, " ");
const money = (n) => `${fmt(n)} HUF`;
const compact = (n) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M` : fmt(n);

/* ── THE RULES ───────────────────────────────────────────────
   Each returns null (not earned) or a mark. `tone` picks the ink:
   money = amber, aside = grey, good = green.                    */
const RULES = [
  // The headline leak, annualised — a month means little, a year lands.
  (r) =>
    r.leak_monthly > 0 && {
      priority: 100,
      kind: "underline",
      anchor: "leak-figure",
      double: true,
      tone: "money",
      note: `≈ ${compact(r.leak_monthly * 12)} a year`,
      notePos: "above-right",
    },
  // Where to start, bracketed in the margin.
  (r) =>
    r.findings.length > 0 && {
      priority: 95,
      kind: "bracket",
      anchor: "leak-figure",
      tone: "money",
      note: "start here",
      notePos: "left",
    },
  // A stated number the arithmetic disagrees with: strike it, quantify the gap.
  (r) =>
    r.margin_stated != null &&
    Math.abs(r.margin_stated - r.margin_actual) >= 5 && {
      priority: 90,
      kind: "strike",
      anchor: "margin-stated",
      tone: "money",
      note: `${Math.round(Math.abs(r.margin_stated - r.margin_actual))} pts out`,
      notePos: "right",
    },
  // The worst performer in the lead finding.
  (r) => {
    const w = worst(r);
    return (
      w && {
        priority: 85,
        kind: "circle",
        anchor: "offer-worst-value",
        tone: "money",
        note: `${w.share}% of orders, ${w.margin}% margin`,
        notePos: "below-left",
      }
    );
  },
  // The best one — where the volume should move.
  (r) => {
    const b = best(r);
    return (
      b &&
      worst(r) &&
      b.name !== worst(r).name && {
        priority: 80,
        kind: "circle",
        anchor: "offer-best-value",
        tone: "money",
        note: "push this one",
        notePos: "above-right",
      }
    );
  },
  // The multiple between them, stated plainly.
  (r) => {
    const b = best(r), w = worst(r);
    return (
      b && w && w.margin > 0 && b.margin / w.margin >= 1.5 && {
        priority: 60,
        kind: "note",
        anchor: "offer-second-row",
        tone: "aside",
        note: `${(b.margin / w.margin).toFixed(1)}× the margin of your bestseller`,
        notePos: "above-right",
      }
    );
  },
  // Hours are abstract; working days are not.
  (r) =>
    r.time_finding_hours >= 8 && {
      priority: 55,
      kind: "circle",
      anchor: "time-figure",
      tone: "money",
      note: `= ${Math.round(r.time_finding_hours / 8)} working days`,
      notePos: "below-right",
    },
  // Say what is going right, or the report reads as an attack.
  (r) =>
    r.trend_pct > 0 && {
      priority: 50,
      kind: "check",
      anchor: "trend-value",
      tone: "good",
      note: "this bit works",
      notePos: "left",
    },
  // What the gaps would buy, if answered.
  (r) =>
    r.gaps.length > 0 && {
      priority: 40,
      kind: "query",
      anchor: "gaps-block",
      tone: "money",
      note: `answer these ${r.gaps.length} and finding ${r.findings.length} gets real`,
      notePos: "left",
    },
  // Name the block the money is escaping from.
  (r) =>
    r.cost_share >= 50 && {
      priority: 35,
      kind: "note",
      anchor: "cost-block",
      tone: "aside",
      note: "the leak lives in here",
      notePos: "inside",
    },
  // What she actually lives on.
  (r) =>
    r.keep_share <= 25 && {
      priority: 30,
      kind: "circle",
      anchor: "keep-block",
      tone: "aside",
      note: `only ${r.keep_share}% ends up yours`,
      notePos: "below-right",
    },
];

const byMargin = (r) => [...r.offers].sort((a, b) => b.margin - a.margin);
const best = (r) => byMargin(r)[0];
const worst = (r) => byMargin(r).at(-1);

/** Which marks this particular report has earned, highest value first. */
export function buildAnnotations(report) {
  return RULES.map((rule) => rule(report))
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_MARKS);
}

/* ── THE INK LAYER ── */
const NS = "http://www.w3.org/2000/svg";
const rand = (seed) => {
  // Deterministic wobble: the same report always draws the same hand.
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
};

function svg(cls, box, len, d, wobble) {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("class", cls);
  el.setAttribute("viewBox", box);
  el.setAttribute("preserveAspectRatio", "none");
  el.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d);
  path.style.setProperty("--len", len);
  path.style.strokeWidth = wobble ?? 1.7;
  el.appendChild(path);
  return el;
}

const TONE = { money: "", aside: " grey", good: " good" };

export function renderAnnotations(marks, layer, root) {
  layer.textContent = "";
  const base = root.getBoundingClientRect();
  marks.forEach((m, i) => {
    const target = root.querySelector(`[data-anno="${m.anchor}"]`);
    if (!target) return;
    const r = target.getBoundingClientRect();
    const box = {
      x: r.left - base.left,
      y: r.top - base.top,
      w: r.width,
      h: r.height,
    };
    const tone = TONE[m.tone] ?? "";
    const tilt = (rand(i + 1) * 5 - 2.5).toFixed(2);
    const put = (el, x, y, w, h) => {
      Object.assign(el.style, {
        position: "absolute",
        left: `${x}px`,
        top: `${y}px`,
        width: w == null ? "auto" : `${w}px`,
        height: h == null ? "auto" : `${h}px`,
      });
      layer.appendChild(el);
    };

    if (m.kind === "circle" || m.kind === "query") {
      const pad = 12;
      const el = svg(
        `pen${tone}`,
        "0 0 100 46",
        330,
        "M52,4 C80,3 96,12 96,23 C96,35 74,43 48,43 C22,43 4,35 4,23 C4,13 22,5 44,4 C50,3.6 57,3.8 63,5",
      );
      put(el, box.x - pad, box.y - pad * 0.8, box.w + pad * 2, box.h + pad * 1.6);
    }
    if (m.kind === "underline" || m.kind === "strike") {
      const y = m.kind === "strike" ? box.y + box.h * 0.5 - 6 : box.y + box.h - 6;
      const el = svg(`pen${tone}`, "0 0 200 13", 230, "M3,6 C42,2 82,11 122,5 C152,1.5 176,8 197,4", 2);
      put(el, box.x - 4, y, box.w + 8, 13);
      if (m.double) {
        const el2 = svg(`pen${tone}`, "0 0 200 13", 230, "M8,11 C48,8 92,13 136,9 C160,7 182,11 194,9", 2);
        put(el2, box.x - 2, y + 4, box.w + 4, 13);
      }
    }
    if (m.kind === "bracket") {
      const el = svg(`pen${tone}`, "0 0 22 100", 200, "M18,3 C7,3 6,10 6,50 C6,90 7,97 18,97");
      put(el, box.x - 30, box.y, 22, box.h);
    }
    if (m.kind === "check") {
      const el = svg(`pen${tone}`, "0 0 26 24", 50, "M4,13 L10,20 L22,4", 2.2);
      put(el, box.x + box.w + 8, box.y + box.h * 0.1, 26, 24);
    }

    if (!m.note) return;
    const note = document.createElement("span");
    note.className = `hand sm${tone}`;
    note.textContent = m.kind === "query" ? `? ${m.note}` : m.note;
    note.style.transform = `rotate(${tilt}deg)`;
    note.style.maxWidth = "190px";
    note.style.whiteSpace = "normal";
    note.style.lineHeight = "1.15";
    const P = {
      "above-right": [box.x + box.w + 14, box.y - 26],
      "below-right": [box.x + box.w * 0.4, box.y + box.h + 8],
      "below-left": [box.x - 40, box.y + box.h + 10],
      left: [box.x - 172, box.y + box.h * 0.3],
      right: [box.x + box.w + 14, box.y + box.h * 0.1],
      inside: [box.x + 24, box.y + box.h * 0.55],
    }[m.notePos] ?? [box.x, box.y - 24];
    put(note, Math.max(-150, P[0]), P[1]);
  });
}

/** Wire a report to a page: render marks, keep them glued through resize. */
export function mountAnnotations(report, root, layer) {
  const marks = buildAnnotations(report);
  const draw = () => renderAnnotations(marks, layer, root);
  draw();
  if (document.fonts?.ready) void document.fonts.ready.then(draw);
  let t;
  addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(draw, 120);
  });
  return marks;
}
