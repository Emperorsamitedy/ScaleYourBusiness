"use client";

// The long landing — cinematic machinery, Ember Grid voice.
//
// Owner direction (2026-08-31): keep the films, Framer Motion and the
// scroll choreography from the liquid-glass pass, but in OUR fonts and
// styles (Satoshi display, Geist body, amber ember, glass + cool rim),
// bring back the built instruments (MorphDemo, scan meter, Reel, Arc,
// Trust), and stretch the page across the whole five-phase roadmap.
//
// Scroll grammar: fade-up for prose, POP (spring scale) for instruments,
// slide-in alternating for phase blocks, parallax on the big phase
// numerals, and a slow pulse on the primary CTA. Everything respects
// prefers-reduced-motion via framer's useReducedMotion.

import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import Link from "next/link";
import { useRef } from "react";
import type { ReactNode } from "react";
import { Arc } from "@/components/landing/Arc";
import { MorphDemo } from "@/components/landing/MorphDemo";
import { Reel } from "@/components/landing/Reel";
import { Trust } from "@/components/landing/Trust";
import { BlurText } from "./BlurText";
import { FadingVideo } from "./FadingVideo";
import { ShinyText } from "./ShinyText";

const HERO_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260619_191346_9d19d66e-86a4-47f7-8dc6-712c1788c3b2.mp4";
const CAPS_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260622_093722_ccfc7ebf-182f-419f-8a62-2dc02db7dd9d.mp4";
// The bed that runs behind the long scroll — pinned, dimmed, looping, so
// the roadmap reads over moving film instead of flat black.
const BED_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260328_105406_16f4600d-7a92-4292-b96e-b19156c7830a.mp4";

/* ── motion grammar ── */

const fadeUp = {
  initial: { opacity: 0, y: 28, filter: "blur(8px)" },
  whileInView: { opacity: 1, y: 0, filter: "blur(0px)" },
  viewport: { once: true, amount: 0.25 },
  transition: { duration: 0.7, ease: "easeOut" as const },
};

const pop = {
  initial: { opacity: 0, scale: 0.86, y: 24 },
  whileInView: { opacity: 1, scale: 1, y: 0 },
  viewport: { once: true, amount: 0.2 },
  transition: { type: "spring" as const, stiffness: 120, damping: 16, mass: 0.9 },
};

const slide = (from: "left" | "right") => ({
  initial: { opacity: 0, x: from === "left" ? -56 : 56, filter: "blur(6px)" },
  whileInView: { opacity: 1, x: 0, filter: "blur(0px)" },
  viewport: { once: true, amount: 0.25 },
  transition: { duration: 0.75, ease: "easeOut" as const },
});

const ArrowUpRight = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 17L17 7" />
    <path d="M7 7h10v10" />
  </svg>
);

/* ── the roadmap, phase by phase — honest status chips ── */

interface Phase {
  n: string;
  status: "live" | "next" | "planned";
  title: string;
  lede: string;
  features: string[];
  links?: { label: string; href: string }[];
}

const PHASES: Phase[] = [
  {
    n: "01",
    status: "live",
    title: "It understands the business",
    lede:
      "Fifteen minutes of plain questions become a profile where every fact carries its source, its confidence, and its history — and then a diagnosis with the arithmetic shown.",
    features: [
      "One-question-at-a-time interview — “I don’t know” is a real answer",
      "Fact sheet with provenance on every figure, and gaps listed as findings",
      "Findings that must cite their evidence — enforced in code, not prompts",
      "Recommendations with break-even proven: “sales can fall 35.7% before this costs you”",
      "A printable report with two equal buttons — declining teaches it",
    ],
    links: [
      { label: "Start the interview", href: "/intake" },
      { label: "See a fact sheet", href: "/profile" },
      { label: "See a report", href: "/report" },
    ],
  },
  {
    n: "02",
    status: "next",
    title: "Then it stops taking your word for it",
    lede:
      "Read-only connections to the places your numbers already live. What actually happened replaces what you estimated — and your original stays in the history, with your name on it.",
    features: [
      "Stripe first — payments are the most reliable truth about revenue",
      "Shopify / WooCommerce, GA4, Meta Ads, Google Ads follow",
      "Twelve months backfilled, kept current daily, by offer and by channel",
      "Read-only scopes, forever — a scope audit is part of the definition of done",
      "Anomaly detection that knows a weekend dip from a real 20% drop",
    ],
  },
  {
    n: "03",
    status: "planned",
    title: "Then it does the work — and asks first",
    lede:
      "Marketing arrives as proposals: what will happen, why, what it rests on, and what happens if you decline. Nothing executes without your yes, and a kill switch stops everything in seconds.",
    features: [
      "An approval queue where approve and decline carry equal visual weight",
      "Execution engine with idempotency — a proposal cannot run twice",
      "Hard limits honoured at generation: say “never discount” once, never see one",
      "Content from your own footage first, generation second",
      "Goals and content plans tied to what the numbers actually say",
    ],
  },
  {
    n: "04",
    status: "planned",
    title: "Then it takes the questions you answer twice a day",
    lede:
      "Support that knows your catalogue, your delivery times and your tone — and knows what it must not decide on its own.",
    features: [
      "Website chat that introduces itself as an AI, always",
      "Email support with escalation to you for anything that matters",
      "An FAQ that updates itself from the questions people actually ask",
      "Segmentation and lifecycle tracking, consent respected from the intake",
      "Outbound only with consent — unsubscribe honoured everywhere",
    ],
  },
  {
    n: "05",
    status: "planned",
    title: "Then it sees it coming",
    lede:
      "The compounding payoff of a profile that has watched your business for a year: it warns you before the numbers become a problem.",
    features: [
      "Inventory intelligence — the stockout it can see three weeks out",
      "Cash-flow scenarios and break-even from measured data, not estimates",
      "A site audit: speed, mobile, checkout friction",
      "Seasonal triggers — the rush that caught you last year, named this year",
      "A sales pipeline for the B2B side of the business",
    ],
  },
];

const STATUS_LABEL: Record<Phase["status"], string> = {
  live: "● LIVE TODAY",
  next: "BEING BUILT NEXT",
  planned: "PLANNED",
};

/* ── section shell with the shared heading grammar ── */

function SectionHead({
  kicker,
  title,
  lede,
}: {
  kicker: string;
  title: string;
  lede?: string;
}) {
  return (
    <header className="ep-head">
      <motion.p className="ep-kicker" {...fadeUp}>
        {kicker}
      </motion.p>
      <h2 className="ep-h2">
        <BlurText text={title} align="left" />
      </h2>
      {lede && (
        <motion.p className="ep-lede" {...fadeUp}>
          {lede}
        </motion.p>
      )}
    </header>
  );
}

/* ── one phase block, alternating slide, parallax numeral ── */

function PhaseBlock({ phase, index }: { phase: Phase; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], [70, -70]);
  const from = index % 2 === 0 ? "left" : "right";

  return (
    <div className={`ep-phase ${index % 2 === 1 ? "flip" : ""} st-${phase.status}`} ref={ref}>
      <motion.span
        className="ep-phase-n"
        style={reduced ? {} : { y }}
        aria-hidden="true"
      >
        {phase.n}
      </motion.span>

      <motion.div className="ep-phase-body" {...slide(from)}>
        <span className={`ep-status st-${phase.status}`}>{STATUS_LABEL[phase.status]}</span>
        <h3>{phase.title}</h3>
        <p>{phase.lede}</p>
        <ul>
          {phase.features.map((f, i) => (
            <motion.li
              key={f}
              initial={{ opacity: 0, x: from === "left" ? -18 : 18 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ duration: 0.45, delay: 0.15 + i * 0.09, ease: "easeOut" }}
            >
              {f}
            </motion.li>
          ))}
        </ul>
        {phase.links && (
          <div className="ep-phase-links">
            {phase.links.map((l) => (
              <Link key={l.href} className="ghost quiet" href={l.href}>
                {l.label} →
              </Link>
            ))}
          </div>
        )}
      </motion.div>
    </div>
  );
}

function Shell({
  id,
  children,
  wide,
  film,
}: {
  id?: string;
  children: ReactNode;
  wide?: boolean;
  /** Pins a dimmed looping film behind the whole section as it scrolls. */
  film?: boolean;
}) {
  return (
    <section id={id} className={`ep-sec${wide ? " wide" : ""}${film ? " filmed" : ""}`}>
      {film && (
        <div className="ep-bed" aria-hidden="true">
          <div className="ep-bed-pin">
            <FadingVideo src={BED_VIDEO} className="ep-video" loop />
            <div className="ep-bed-veil" />
          </div>
        </div>
      )}
      <div className="ep-sec-inner">{children}</div>
    </section>
  );
}

/* ── the page ── */

export function CineLanding() {
  return (
    <div className="ep">
      {/* ═ 1 · hero: the film, our voice ═ */}
      <section className="ep-hero">
        <FadingVideo src={HERO_VIDEO} className="ep-video" />
        <div className="ep-hero-veil" aria-hidden="true" />

        <nav className="ep-nav">
          <span className="wordmark">Ledgerline</span>
          <div className="ep-navpill">
            <a href="#demo">Demo</a>
            <a href="#phases">The five phases</a>
            <a href="#trust">Privacy</a>
            <Link className="ep-navcta" href="/intake">
              Start a diagnosis <ArrowUpRight />
            </Link>
          </div>
        </nav>

        <div className="ep-hero-main">
          <motion.div
            initial={{ opacity: 0, y: 18, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.8, delay: 0.4, ease: "easeOut" }}
          >
            <div className="ep-badge">
              <span>Pilot</span>
              Booking Q4 2026 diagnoses — limited capacity
            </div>
          </motion.div>

          <h1 className="ep-h1">
            <BlurText text="Most owners are wrong about" />
            <ShinyText
              className="ep-shine"
              text="which product makes them money."
              baseColor="#F59B4B"
              shineColor="#ffffff"
              speed={3}
              spread={100}
            />
          </h1>

          <motion.p
            className="ep-sub"
            initial={{ opacity: 0, y: 18, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.8, delay: 0.8, ease: "easeOut" }}
          >
            Not through carelessness — the numbers live in six places and none of them talk. This is
            an AI operating system for your business: it starts by proving where the money goes, and
            grows into the colleague who runs the parts you never had time for.
          </motion.p>

          <motion.div
            className="ep-ctas"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 1.1, ease: "easeOut" }}
          >
            <Link className="next ep-pulse" href="/intake">
              Start — about 15 minutes
            </Link>
            <a className="ep-quiet" href="#demo">
              Watch it work ↓
            </a>
          </motion.div>

          <motion.div
            className="ep-stats"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 1.3, ease: "easeOut" }}
          >
            <div className="ep-stat">
              <strong>15 min</strong>
              <span>from first question to first read</span>
            </div>
            <div className="ep-stat">
              <strong>140+</strong>
              <span>businesses read across four continents</span>
            </div>
            <div className="ep-stat">
              <strong>5 stages</strong>
              <span>one live today — and it says which</span>
            </div>
          </motion.div>
        </div>

        <motion.div
          className="ep-scrollhint"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.8, duration: 0.8 }}
          aria-hidden="true"
        >
          <i />
        </motion.div>
      </section>

      {/* ═ 2 · the live demo: answers become a diagnosis ═ */}
      <Shell id="demo">
        <SectionHead
          kicker="// The demo — this is the real interface, animated"
          title="Watch answers become a diagnosis"
          lede="Three plain answers, typed the way an owner types them — and the instrument cluster they turn into. No mockup: the same components render your real numbers inside."
        />
        <motion.div {...pop}>
          <MorphDemo />
        </motion.div>
      </Shell>

      {/* ═ 3 · the proof: the story that sells the product ═ */}
      <Shell>
        <SectionHead
          kicker="// The finding that started this product"
          title="Her best seller was her least profitable"
          lede="61% of everything she sold. The thinnest margin of five products. She had been pushing it for two years."
        />
        <motion.div className="scan ep-scan" {...pop} aria-label="Margin analysis across five products">
          <span className="scan-line" aria-hidden="true" />
          <header className="scan-head">
            <span>Analysis · 5 offers · margin per unit</span>
            <span>Szörp Kft. · 14 min</span>
          </header>
          <div className="scan-rows">
            {[
              { name: "Gift box", margin: 61, share: 9 },
              { name: "Winter spice", margin: 44, share: 11 },
              { name: "Sampler 3×0.1L", margin: 38, share: 5 },
              { name: "Szörp 1L", margin: 31, share: 14 },
              { name: "Szörp 0.5L", margin: 18, share: 61, critical: true },
            ].map((o, i) => {
              const lit = Math.round((o.margin / 61) * 26);
              return (
                <div className={o.critical ? "scan-row crit" : "scan-row"} key={o.name}>
                  <span className="scan-i">{String(i + 1).padStart(2, "0")}</span>
                  <span className="scan-name">{o.name}</span>
                  <span className="scan-meter" aria-hidden="true">
                    {Array.from({ length: 26 }, (_, c) => (
                      <motion.i
                        key={c}
                        className={c < lit ? "on" : ""}
                        initial={{ opacity: 0.15 }}
                        whileInView={{ opacity: 1 }}
                        viewport={{ once: true }}
                        transition={{ delay: 0.2 + i * 0.09 + c * 0.016 }}
                      />
                    ))}
                  </span>
                  <span className="scan-val">{o.margin}%</span>
                  <span className="scan-share">{o.share}% of volume</span>
                  {o.critical && <span className="scan-flag">◄ critical</span>}
                </div>
              );
            })}
          </div>
          <footer className="scan-foot">
            <span className="scan-verdict">
              <i className="scan-pip" />
              highest volume · lowest return
            </span>
            <span>Every figure above traces to an answer she gave — or to arithmetic shown on screen.</span>
          </footer>
        </motion.div>
      </Shell>

      {/* ═ 4 · what you get back: the reel ═ */}
      <Shell>
        <SectionHead
          kicker="// What you get back"
          title="Three instruments, one honest read"
          lede="Where the month goes. How wrong a recommendation can be before it hurts. What the system watched afterwards. Every one is arithmetic you can check."
        />
        <motion.div {...pop}>
          <Reel />
        </motion.div>
      </Shell>

      {/* ═ 5 · film interlude into the roadmap ═ */}
      <section className="ep-interlude">
        <FadingVideo src={CAPS_VIDEO} className="ep-video" />
        <div className="ep-interlude-veil" aria-hidden="true" />
        <div className="ep-interlude-copy">
          <h2 className="ep-h2 big">
            <BlurText text="Stage one is live. Here is the whole machine." />
          </h2>
          <motion.p {...fadeUp}>
            An operating system arrives in stages. Each one earns the next — and the page below
            tells you honestly which exist.
          </motion.p>
        </div>
      </section>

      {/* ═ 6 · the five phases, long-form ═ */}
      <Shell id="phases" wide film>
        <SectionHead
          kicker="// The roadmap — everything this becomes"
          title="Five phases, in the order they earn trust"
        />
        <div className="ep-phases">
          {PHASES.map((phase, i) => (
            <PhaseBlock key={phase.n} phase={phase} index={i} />
          ))}
        </div>
      </Shell>

      {/* ═ 7 · the rail: the roadmap as one instrument ═ */}
      <Shell>
        <SectionHead
          kicker="// The same five, as one instrument"
          title="Solid where built, dashed where not"
          lede="The spine runs solid through the stage that ships and dashed through the four that don't. The charge goes faint the moment it leaves built ground."
        />
        <motion.div {...pop}>
          <Arc />
        </motion.div>
      </Shell>

      {/* ═ 8 · trust ═ */}
      <Shell id="trust">
        <SectionHead
          kicker="// Before you tell me anything"
          title="What happens to your answers"
          lede="Two routes an answer takes. Three it never does — severed on the same diagram, with packets that die at the cut."
        />
        <motion.div {...pop}>
          <Trust />
        </motion.div>
      </Shell>

      {/* ═ 9 · the end ═ */}
      <section className="ep-end">
        <div className="ep-bed" aria-hidden="true">
          <div className="ep-bed-pin">
            <FadingVideo src={BED_VIDEO} className="ep-video" loop />
            <div className="ep-bed-veil strong" />
          </div>
        </div>
        <h2 className="ep-h2 center">
          <BlurText text="Fifteen minutes, and you'll know which line to stop pushing." />
        </h2>
        <motion.div {...fadeUp} className="ep-ctas center">
          <Link className="next ep-pulse" href="/intake">
            Start the questions
          </Link>
          <span className="ep-quiet">stop any time — it&rsquo;s saved</span>
        </motion.div>
        <footer className="ep-foot">
          Ledgerline · a read on the business, not a dashboard · answers never sold, never used to
          train models
        </footer>
      </section>
    </div>
  );
}
