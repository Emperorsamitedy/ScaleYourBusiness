// The v2 landing page's motion (specs/ux-spec-v1.md §7.1b) — everything
// that moves once LandingV2 has rendered: the filmed scenes mixed by
// scroll, the product tour, and each screen's own demonstration. It
// works on the rendered page through [data-m] hooks and never decides
// what a figure is: every word and amount arrives formatted, in the
// reader's language, from the component (MotionWords).
//
// Reduced motion: no video, no loops, no leaning screens — each screen
// stands in its finished state and the scenes are their still frames.

import {
  V2,
  chartSeries,
  scanLeaks,
  scanTotal,
  type Candle,
  type CheckKind,
} from "../../lib/marketing/landing-v2";

export interface MotionQuestion {
  question: string;
  options: string[];
  /** Which option the demo's pointer picks. */
  pick: number;
  label: string;
  value: string;
  source: string;
}

export interface MotionWords {
  /** The tour's five screen names, in order. */
  screens: string[];
  tourWaiting: string;
  tourRecorded: string;
  facts: (count: number) => string;
  questions: MotionQuestion[];
  leaking: string;
  paused: string;
  approvePause: string;
  undoPause: string;
  leakAmount: string;
  leakNone: string;
  approve: string;
  undo: string;
  onRecord: (count: number) => string;
  ledgerEntry: string;
  byYou: string;
  approved: string;
  scanned: (pct: number) => string;
  found: (count: number, unpriced: number) => string;
  aMonth: (low_minor: number, high_minor: number) => string;
  dayOf: (day: number) => string;
  money: (amount_minor: number) => string;
  checkRange: (kind: CheckKind, sales_minor: number) => string;
  sorted: string;
  clock: () => string;
}

const VIEW = { W: 560, H: 230, L: 14, R: 14, T: 14, B: 22 } as const;

/** Where a candle sits in the chart's 560 × 230 view; the component draws with it, the motion reads with it. */
export function chartGeo(series: Candle[]) {
  const lo = Math.min(...series.map((d) => d.low_minor)) * 0.97;
  const hi = Math.max(...series.map((d) => d.slipped_minor)) * 1.02;
  const slot = (VIEW.W - VIEW.L - VIEW.R) / series.length;
  return {
    ...VIEW,
    bw: slot * 0.58,
    x: (i: number) => VIEW.L + (i + 0.5) * slot,
    y: (v: number) => VIEW.T + (1 - (v - lo) / (hi - lo)) * (VIEW.H - VIEW.T - VIEW.B),
  };
}

/** How long each tour screen stays up, in milliseconds; the diagnosis, the screen the tour opens on, longest. */
const TOUR_MS = [4400, 4600, 7200, 4800, 5600];
/** The tour opens on the diagnosis: the money at stake is the first thing a visitor reads. */
const TOUR_START = 2;

/** Start the page's motion on a rendered LandingV2; the returned function stops all of it. */
export function mountLandingV2(root: HTMLElement, w: MotionWords): () => void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const narrow = () => window.innerWidth < 900;
  let alive = true;
  const timers = new Set<number>();
  const offs: (() => void)[] = [];

  const later = (ms: number, fn: () => void): number => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      if (alive) fn();
    }, ms);
    timers.add(id);
    return id;
  };
  const on = (el: EventTarget, ev: string, fn: EventListener, opts?: AddEventListenerOptions) => {
    el.addEventListener(ev, fn, opts);
    offs.push(() => el.removeEventListener(ev, fn, opts));
  };
  const one = <T extends Element = HTMLElement>(name: string): T => {
    const el = root.querySelector<T>(`[data-m="${name}"]`);
    if (!el) throw new Error(`landing-v2: the page has no "${name}"`);
    return el;
  };
  const all = <T extends Element = HTMLElement>(sel: string): T[] =>
    Array.from(root.querySelectorAll<T>(sel));
  const el = (tag: string, cls: string, text?: string): HTMLElement => {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  root.classList.add("js");
  offs.push(() => root.classList.remove("js"));

  // Reveals: copy rises in; a screen is printed top to bottom, then tells its demo to start.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("shown");
        e.target.dispatchEvent(new Event("shown"));
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -14% 0px" },
  );
  all(".rv, .win.pre").forEach((n) => io.observe(n));
  offs.push(() => io.disconnect());

  /** Move a screen's pointer onto something inside the same box, the way a screen recording looks. */
  const pointTo = (cur: HTMLElement, target: Element, then?: () => void) => {
    const boxEl = cur.parentElement;
    if (!boxEl) return;
    const box = boxEl.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const k = box.width / boxEl.offsetWidth || 1;
    const x = (r.left - box.left + Math.min(r.width * 0.6, r.width - 14)) / k;
    const y = (r.top - box.top + r.height * 0.55) / k;
    cur.classList.add("show");
    cur.style.transform = `translate(${x}px,${y}px)`;
    if (then) later(950, then);
  };

  // ── hero: the product tour, five screens on a loop ──
  {
    const tour = one("tour");
    const scenes = all(".scene");
    const tabs = all<HTMLButtonElement>(".tabs button");
    const cur = one("tourCur");
    const scr = one("tourScr");
    const btn = one("tourBtn");
    const log = one("tourLog");
    const count = one("tourFacts");
    let run: number[] = [];
    const soon = (ms: number, fn: () => void) => run.push(later(ms, fn));

    const acts: (() => void)[] = [
      () => {
        all(".conn").forEach((row, i) => {
          row.classList.remove("ok");
          soon(900 + i * 800, () => row.classList.add("ok"));
        });
      },
      () => {
        const t0 = performance.now();
        const tick = (t: number) => {
          if (!alive || !scenes[1]?.classList.contains("on")) return;
          const k = Math.min(1, (t - t0) / 2600);
          count.textContent = w.facts(Math.round(V2.tourFacts * (1 - Math.pow(1 - k, 3))));
          if (k < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      () => {},
      () => {},
      () => {
        const sc = scenes[4];
        if (!sc) return;
        sc.classList.remove("is-done");
        btn.classList.remove("press");
        log.textContent = w.tourWaiting;
        cur.classList.remove("show");
        cur.style.transform = "translate(360px,40px)";
        soon(1700, () =>
          pointTo(cur, btn, () => {
            btn.classList.add("press");
            soon(180, () => {
              sc.classList.add("is-done");
              log.textContent = w.tourRecorded;
            });
            soon(900, () => cur.classList.remove("show"));
          }),
        );
      },
    ];

    const go = (i: number) => {
      run.forEach((id) => {
        window.clearTimeout(id);
        timers.delete(id);
      });
      run = [];
      scr.textContent = w.screens[i] ?? "";
      tour.style.setProperty("--dur", `${TOUR_MS[i] ?? 4000}ms`);
      scenes.forEach((s, j) => s.classList.toggle("on", j === i));
      tabs.forEach((t, j) => {
        t.classList.remove("on");
        t.classList.toggle("past", j < i);
        t.setAttribute("aria-selected", j === i ? "true" : "false");
        if (j === i) {
          void t.offsetWidth; // restart the tab's progress line
          t.classList.add("on");
        }
      });
      acts[i]?.();
      if (!reduced) soon(TOUR_MS[i] ?? 4000, () => go((i + 1) % scenes.length));
    };
    tabs.forEach((t, j) => on(t, "click", () => go(j)));

    if (reduced) {
      // Stand on the diagnosis, finished: the money at stake in one still frame.
      scenes.forEach((s, j) => s.classList.toggle("on", j === TOUR_START));
      tabs.forEach((t, j) => t.classList.toggle("past", j <= TOUR_START));
      scr.textContent = w.screens[TOUR_START] ?? "";
      log.textContent = w.tourRecorded;
      count.textContent = w.facts(V2.tourFacts);
    } else {
      go(TOUR_START);
      on(document, "visibilitychange", () => {
        if (!document.hidden) go(TOUR_START);
      });
    }
  }

  // ── 1 · interview: the pointer picks an answer, the fact lands on the sheet with fresh ink ──
  {
    const qText = one("qText");
    const qOpts = one("qOpts");
    const facts = one("facts");
    const counter = one("factCount");
    const cur = one("qCur");
    let i = 0;
    let n: number = V2.facts;
    const options = (q: MotionQuestion, picked: boolean) =>
      qOpts.replaceChildren(
        ...q.options.map((o, k) =>
          el("span", picked && k === q.pick ? "lx-opt pick" : "lx-opt", o),
        ),
      );
    const show = () => {
      const q = w.questions[i % w.questions.length];
      if (!q) return;
      qText.textContent = q.question;
      options(q, false);
      later(1300, () => {
        const target = qOpts.children[q.pick];
        if (!target) return;
        pointTo(cur, target, () => {
          target.classList.add("pick");
          later(600, () => {
            // A newer answer supersedes the older row for the same fact; it is not stacked beside it.
            Array.from(facts.children).forEach((r) => {
              if (r instanceof HTMLElement && r.dataset.k === q.label) r.remove();
            });
            const row = el("div", "rw fact new");
            row.dataset.k = q.label;
            const left = el("span", "", q.label);
            left.append(el("small", "", q.source));
            const right = el("span", "v");
            const ink = el("span", "mk", q.value);
            right.append(ink);
            row.append(left, right);
            facts.prepend(row);
            requestAnimationFrame(() => ink.classList.add("dry"));
            while (facts.children.length > 4) facts.lastElementChild?.remove();
            if (i < w.questions.length) n += 1;
            counter.textContent = w.facts(n);
            i += 1;
            later(2400, show);
          });
        });
      });
    };
    const first = w.questions[0];
    if (first) {
      qText.textContent = first.question;
      options(first, reduced);
    }
    if (!reduced) on(one("w1"), "shown", () => later(1500, show), { once: true });
  }

  // ── 2 · the scan follows the scroll; the total only counts what has been found so far ──
  const leakRows = all(".leak");
  const leaks = scanLeaks();
  const scanBar = one("scanBar");
  const scanPct = one("scanPct");
  const scanFound = one("scanFound");
  const scanSum = one("scanSum");
  const scanHud = (p: number) => {
    const q = Math.min(1, p / 0.86);
    scanBar.style.width = `${q * 100}%`;
    scanPct.textContent = w.scanned(Math.round(q * 100));
    leakRows.forEach((row, i) => row.classList.toggle("on", q >= (leaks[i]?.at ?? 2)));
    const total = scanTotal(q);
    scanFound.textContent = w.found(total.found, total.unpriced);
    scanSum.textContent = total.high_minor > 0 ? w.aMonth(total.low_minor, total.high_minor) : "—";
  };

  // ── 3 · seal the leak ──
  {
    const btn = one("sealBtn");
    const label = one("sealLabel");
    const amount = one("leakNum");
    const state = one("leakState");
    const lost = one("splitLost");
    const back = one("splitBack");
    const open = {
      lost: lost.style.getPropertyValue("--w"),
      back: back.style.getPropertyValue("--w"),
    };
    let sealed = false;
    on(btn, "click", () => {
      sealed = !sealed;
      amount.textContent = sealed ? w.leakNone : w.leakAmount;
      amount.classList.toggle("sealed", sealed);
      state.textContent = sealed ? w.paused : w.leaking;
      state.className = `flag ${sealed ? "ok" : "alarm"}`;
      lost.style.setProperty("--w", sealed ? "0%" : open.lost);
      back.style.setProperty("--w", sealed ? "100%" : open.back);
      label.textContent = sealed ? w.undoPause : w.approvePause;
    });
  }

  // ── 4 · approval: the stamp lands and a new line is written in the ledger ──
  {
    const sheet = one("dsheet");
    const btn = one("approveBtn");
    const label = one("approveLabel");
    const record = one("ledgerCount");
    const ledger = one("ledger");
    let row: HTMLElement | null = null;
    on(btn, "click", () => {
      if (sheet.classList.contains("is-done")) {
        sheet.classList.remove("is-done");
        label.textContent = w.approve;
        record.textContent = w.onRecord(V2.ledger.onRecord);
        row?.remove();
        row = null;
        return;
      }
      sheet.classList.add("is-done");
      label.textContent = w.undo;
      record.textContent = w.onRecord(V2.ledger.onRecord + 1);
      row = el("div", "fact new");
      const what = el("span", "");
      const ink = el("span", "mk", w.ledgerEntry);
      what.append(ink, ` · ${w.byYou}`);
      row.append(el("span", "m", w.clock()), what, el("span", "flag ok", w.approved));
      ledger.insertBefore(row, ledger.children[1] ?? null);
      requestAnimationFrame(() => ink.classList.add("dry"));
    });
  }

  // ── 5 · market view: a reading line follows the scroll across sixty daily candles ──
  const series = chartSeries();
  const geo = chartGeo(series);
  const seen = one<SVGRectElement>("chartSeen");
  const hair = one<SVGLineElement>("chartHair");
  const dot = one<SVGCircleElement>("chartDot");
  const dayLabel = one("dayLabel");
  const ohlc = (["open", "high", "low", "close"] as const).map((k) => one(`ohlc-${k}`));
  let lastDay = -1;
  const chartHud = (p: number) => {
    const i = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1))));
    if (i === lastDay) return;
    lastDay = i;
    const c = series[i];
    if (!c) return;
    const x = geo.x(i);
    seen.setAttribute("width", String(x + geo.bw));
    hair.setAttribute("x1", String(x));
    hair.setAttribute("x2", String(x));
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", String(geo.y(c.close_minor)));
    dayLabel.textContent = w.dayOf(i + 1);
    [c.open_minor, c.high_minor, c.low_minor, c.close_minor].forEach((v, k) => {
      const cell = ohlc[k];
      if (cell) cell.textContent = w.money(v);
    });
  };

  // ── 6 · choosing a plan lights the ladder up to that step ──
  {
    const steps = Array.from(one("ladder").children);
    const plans = all(".plan");
    const set = (n: number) => {
      steps.forEach((d, i) => {
        d.classList.toggle("lit", i < n - 1);
        d.classList.toggle("at", i === n - 1);
      });
      plans.forEach((p) => p.classList.toggle("on", Number(p.dataset.step) === n));
    };
    plans.forEach((p) => {
      const pick = () => set(Number(p.dataset.step));
      on(p, "mouseenter", pick);
      on(p, "click", pick);
    });
    set(3);
  }

  // ── 7 · the client book arrives A–Z, then sorts itself by money leaking ──
  {
    const book = one("book");
    const head = one("bookSort");
    const byLeak = () =>
      Array.from(book.children).sort(
        (a, b) => Number((b as HTMLElement).dataset.v) - Number((a as HTMLElement).dataset.v),
      );
    const sort = () => {
      const rows = Array.from(book.children) as HTMLElement[];
      const before = rows.map((r) => r.getBoundingClientRect().top);
      byLeak().forEach((r) => book.appendChild(r));
      head.textContent = w.sorted;
      if (reduced) return;
      rows.forEach((r, i) => {
        const dy = (before[i] ?? 0) - r.getBoundingClientRect().top;
        r.style.transition = "none";
        r.style.transform = `translateY(${dy}px)`;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            r.style.transition = "transform .9s cubic-bezier(.16,1,.3,1)";
            r.style.transform = "";
          }),
        );
      });
    };
    if (reduced) sort();
    else on(one("w7"), "shown", () => later(1900, sort), { once: true });
  }

  // ── 8 · free check ──
  {
    const kind = one<HTMLSelectElement>("ckType");
    const sales = one<HTMLInputElement>("ckRev");
    const salesOut = one("ckRevOut");
    const out = one("ckOut");
    const update = () => {
      const minor = Number(sales.value);
      salesOut.textContent = w.money(minor);
      out.textContent = w.checkRange(kind.value as CheckKind, minor);
    };
    on(kind, "change", update);
    on(sales, "input", update);
    update();
  }

  // ══ the filmed world: one scene per section, mixed by scroll ══
  {
    const sections = all(".s");
    const layers = all(".bg");
    const shade = one("shade");
    const prog = one("prog");
    const rail = all(".rail a");
    const fx = all(".fx");
    const lean = fx.map(() => 0);
    const shadeOf = layers.map((l) => Number(l.dataset.shade));
    const N = layers.length;

    const load = (layer: HTMLElement) => {
      const v = layer.querySelector("video");
      if (!v || v.dataset.on || reduced) return;
      v.dataset.on = "1";
      v.querySelectorAll("source").forEach((s) => {
        if (s.dataset.src) s.src = s.dataset.src;
      });
      v.load();
      v.addEventListener("playing", () => v.classList.add("playing"), { once: true });
    };

    /** Each section's pull on the scene (0–1) and how far the reader is through it (0–1). */
    const weights = () => {
      const vh = window.innerHeight;
      const mid = vh / 2;
      return sections.map((s) => {
        const r = s.getBoundingClientRect();
        const c = Math.max(r.top, Math.min(mid, r.bottom));
        const d = Math.abs(mid - c) / vh;
        const p = Math.min(1, Math.max(0, (mid - r.top) / Math.max(1, r.height)));
        return { w: Math.max(0, 1 - d * 2.2), p, g: Number(s.dataset.g) };
      });
    };

    let t = 0;
    let last = performance.now();
    let active = -1;
    let sh = 0.3;
    let first = true;
    let frame = 0;

    const step = (now: number) => {
      if (!alive) return;
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      if (!reduced) t += dt;
      const ws = weights();
      const gw = new Array<number>(N).fill(0);
      const gp = new Array<number>(N).fill(0);
      let best = 0;
      ws.forEach((x, i) => {
        const pull = x.w * x.w;
        if (pull > (gw[x.g] ?? 0)) {
          gw[x.g] = pull;
          gp[x.g] = x.p;
        }
        if (x.w > (ws[best]?.w ?? 0)) best = i;
      });
      if (best !== active) {
        active = best;
        rail.forEach((a, i) => a.classList.toggle("on", i === best));
      }

      // Painter's mix: each layer covers the ones under it by its share of the weight so far.
      let acc = 0;
      let sum = 0;
      let shT = 0;
      layers.forEach((l, i) => {
        const pull = gw[i] ?? 0;
        const p = gp[i] ?? 0;
        acc += pull;
        sum += pull;
        shT += pull * (shadeOf[i] ?? 0.3);
        const a = pull > 0 ? pull / acc : 0;
        if (a > 0.004) {
          load(l);
          l.style.visibility = "visible";
          l.style.opacity = a.toFixed(3);
          const drift =
            l.classList.contains("still") && !reduced ? 0.025 * (1 + Math.sin(t * 0.22 + i)) : 0;
          l.style.transform = `translate3d(0,${((p - 0.5) * -34).toFixed(1)}px,0) scale(${(1 + drift).toFixed(4)})`;
          if (l.classList.contains("pan")) {
            const im = l.firstElementChild as HTMLElement | null;
            if (im) {
              const over = Math.max(0, im.offsetWidth - l.offsetWidth);
              im.style.transform = `translate3d(${(-p * over).toFixed(1)}px,0,0)`;
            }
          }
        } else {
          l.style.visibility = "hidden";
          l.style.opacity = "0";
        }
        const v = l.querySelector("video");
        if (v?.dataset.on) {
          if (a > 0.02) {
            if (v.paused) v.play().catch(() => {});
          } else if (!v.paused) v.pause();
        }
      });
      if (sum > 0) {
        sh += (shT / sum - sh) * (reduced || first ? 1 : 1 - Math.pow(0.01, dt));
        shade.style.setProperty("--sh", sh.toFixed(3));
      }

      // Each screen leans in from below as it arrives and tips away as it leaves.
      const vh = window.innerHeight;
      const flat = narrow() || reduced;
      fx.forEach((node, i) => {
        if (flat) {
          node.style.transform = "";
          node.style.opacity = "";
          return;
        }
        const r = (node.parentElement ?? node).getBoundingClientRect();
        const target = Math.max(-1, Math.min(1, (r.top + r.height / 2 - vh / 2) / vh));
        const k = first
          ? target
          : (lean[i] ?? 0) + (target - (lean[i] ?? 0)) * (1 - Math.pow(0.0008, dt));
        lean[i] = k;
        const e = Math.max(0, Math.abs(k) - 0.12);
        const o = 1 - Math.max(0, (Math.abs(k) - 0.42) / 0.34);
        node.style.transform =
          `translate3d(0,${(k > 0 ? e * 110 : -e * 70).toFixed(1)}px,0) ` +
          `rotateX(${(k > 0 ? e * 26 : -e * 16).toFixed(2)}deg) ` +
          `rotateY(${(e * (i % 2 ? 7 : -7)).toFixed(2)}deg) scale(${(1 - e * 0.1).toFixed(4)})`;
        node.style.opacity = Math.max(0, Math.min(1, o)).toFixed(3);
      });

      const doc = document.documentElement;
      prog.style.width = `${(window.scrollY / Math.max(1, doc.scrollHeight - vh)) * 100}%`;
      scanHud(gp[2] ?? 0);
      chartHud(gp[5] ?? 0);
      first = false;
      if (!reduced) frame = requestAnimationFrame(step);
    };

    if (reduced) {
      const again = () => requestAnimationFrame(step);
      on(window, "scroll", again, { passive: true });
      on(window, "resize", again);
    }
    frame = requestAnimationFrame(step);
    offs.push(() => cancelAnimationFrame(frame));
    on(document, "visibilitychange", () => {
      last = performance.now();
    });
  }

  return () => {
    alive = false;
    timers.forEach((id) => window.clearTimeout(id));
    timers.clear();
    offs.forEach((off) => off());
  };
}
