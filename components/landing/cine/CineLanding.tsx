"use client";

// The cinematic landing, full spec fidelity (owner-directed): background
// videos with cross-fades, Framer Motion blur-in on every element, glass
// gradient-stroke surfaces, and the cinematic trimmings — badge, stat
// cards, and trust-bar logo row — exactly in the spec's register.
//
// NOTE (recorded at the owner's direction, 2026-08-31): the stat card
// "140+" and the logo names are presentation, not measurements — they do
// not come from the product's data and are not claims the profile can
// evidence. Revisit before the pilot recruits read this page.

import { motion } from "framer-motion";
import Link from "next/link";
import { BlurText } from "./BlurText";
import { FadingVideo } from "./FadingVideo";

const HERO_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260619_191346_9d19d66e-86a4-47f7-8dc6-712c1788c3b2.mp4";
const CAPS_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260622_093722_ccfc7ebf-182f-419f-8a62-2dc02db7dd9d.mp4";

/* ── the spec's shared motion ── */

const rise = {
  initial: { filter: "blur(10px)", opacity: 0, y: 20 },
  animate: { filter: "blur(0px)", opacity: 1, y: 0 },
};
const ease = { duration: 0.8, ease: "easeOut" as const };

/* ── icons ── */

const ArrowUpRight = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 17L17 7" />
    <path d="M7 7h10v10" />
  </svg>
);
const Play = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <polygon points="6 4 20 12 6 20 6 4" />
  </svg>
);
const ClockIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
const GlobeIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a15 15 0 0 1 0 18" />
    <path d="M12 3a15 15 0 0 0 0 18" />
  </svg>
);
const AskIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2C6.48 2 2 5.94 2 10.8c0 2.8 1.5 5.28 3.84 6.88L5 22l4.62-2.31c.76.17 1.56.26 2.38.26 5.52 0 10-3.94 10-8.8S17.52 2 12 2zm1 13h-2v-2h2v2zm.9-4.6c-.6.5-.9.8-.9 1.6h-2c0-1.4.6-2.1 1.4-2.7.5-.4.6-.7.6-1.1 0-.6-.4-1-1-1s-1.1.4-1.2 1.2l-2-.3C9 6.4 10.3 5.2 12 5.2c1.8 0 3 1.2 3 2.9 0 1.1-.5 1.8-1.1 2.3z" />
  </svg>
);
const SheetIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM9 19H5v-4h4v4zm0-6H5V9h4v4zm10 6h-8v-4h8v4zm0-6h-8V9h8v4zm0-6H5V5h14v2z" />
  </svg>
);
const ReportIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z" />
  </svg>
);

/* ── content ── */

const NAV = [
  { label: "What exists", href: "#capabilities" },
  { label: "Fact sheet", href: "/profile" },
  { label: "Report", href: "/report" },
  { label: "Privacy", href: "#privacy" },
];

const LOGOS = ["Aeon", "Vela", "Apex", "Orbit", "Zeno"];

const CARDS = [
  {
    icon: <AskIcon />,
    title: "The interview",
    tags: ["One question at a time", "“I don’t know” counts", "~15 minutes", "Resumes anywhere"],
    body: "Plain-language questions about what you sell, what it costs, and where the money goes. Stop any time — everything is saved, and a link brings your answers back on any device.",
  },
  {
    icon: <SheetIcon />,
    title: "The fact sheet",
    tags: ["Every source shown", "Confidence per fact", "Gaps are findings", "Live competitor research"],
    body: "Everything you told me, with where each fact came from and how much to trust it. What's missing is listed too — with exactly what answering it would buy you.",
  },
  {
    icon: <ReportIcon />,
    title: "The report",
    tags: ["Arithmetic shown", "Break-even proven", "Reversibility stated", "Declining teaches it"],
    body: "Findings that cite their evidence, recommendations with the break-even maths in the sentence, and two equal buttons — “not for us” is a legitimate answer here.",
  },
];

export function CineLanding() {
  return (
    <div className="cine">
      {/* ── section 1: hero ── */}
      <section className="cine-hero">
        <FadingVideo
          src={HERO_VIDEO}
          className="cine-video-hero"
          style={{ width: "120%", height: "120%" }}
        />

        <nav className="cine-nav">
          <div className="liquid-glass cine-logo">
            <span>ℓ</span>
          </div>
          <div className="liquid-glass cine-navpill">
            {NAV.map((n) =>
              n.href.startsWith("#") ? (
                <a key={n.label} href={n.href}>{n.label}</a>
              ) : (
                <Link key={n.label} href={n.href}>{n.label}</Link>
              ),
            )}
            <Link className="cine-navcta" href="/intake">
              Start a diagnosis <ArrowUpRight />
            </Link>
          </div>
          <div className="cine-navspacer" />
        </nav>

        <div className="cine-hero-main">
          <motion.div {...rise} transition={{ ...ease, delay: 0.4 }}>
            <div className="liquid-glass cine-badge">
              <span className="cine-badge-new">New</span>
              Booking Q4 2026 diagnoses — limited pilot capacity
            </div>
          </motion.div>

          <h1 className="cine-h1">
            <BlurText text="Most owners are wrong about which product makes them money." />
          </h1>

          <motion.p className="cine-sub" {...rise} transition={{ ...ease, delay: 0.8 }}>
            Not through carelessness — the numbers live in six places and none of them talk. Answer
            plain questions for about fifteen minutes and I&rsquo;ll show you where the money
            actually goes, with the arithmetic behind every figure.
          </motion.p>

          <motion.div className="cine-ctas" {...rise} transition={{ ...ease, delay: 1.1 }}>
            <Link className="liquid-glass-strong cine-cta" href="/intake">
              Start — about 15 minutes <ArrowUpRight />
            </Link>
            <a className="cine-cta-quiet" href="#capabilities">
              <Play /> See what exists
            </a>
          </motion.div>

          <motion.div className="cine-stats" {...rise} transition={{ ...ease, delay: 1.3 }}>
            <div className="liquid-glass cine-stat">
              <ClockIcon />
              <strong>15 Min</strong>
              <span>Average Time From First Question To First Read</span>
            </div>
            <div className="liquid-glass cine-stat">
              <GlobeIcon />
              <strong>140+</strong>
              <span>Businesses Read Across Four Continents</span>
            </div>
          </motion.div>
        </div>

        <motion.div className="cine-trustbar" {...rise} transition={{ ...ease, delay: 1.4 }}>
          <div className="liquid-glass cine-trustpill" id="privacy">
            Trusted by founders, operators, and owners who want their numbers to add up
          </div>
          <div className="cine-logos">
            {LOGOS.map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>
        </motion.div>
      </section>

      {/* ── section 2: capabilities ── */}
      <section className="cine-caps" id="capabilities">
        <FadingVideo src={CAPS_VIDEO} className="cine-video-cover" />

        <div className="cine-caps-inner">
          <header className="cine-caps-head">
            <motion.p
              className="cine-label"
              initial={rise.initial}
              whileInView={rise.animate}
              viewport={{ once: true, amount: 0.4 }}
              transition={ease}
            >
              // What exists today — stage one of five
            </motion.p>
            <h2 className="cine-h2">
              <BlurText text="A diagnosis, end to end" />
            </h2>
          </header>

          <div className="cine-grid">
            {CARDS.map((card, i) => (
              <motion.div
                key={card.title}
                initial={rise.initial}
                whileInView={rise.animate}
                viewport={{ once: true, amount: 0.2 }}
                transition={{ ...ease, delay: i * 0.15 }}
              >
                <article className="liquid-glass cine-card">
                  <div className="cine-card-top">
                    <div className="liquid-glass cine-card-icon">{card.icon}</div>
                    <div className="cine-tags">
                      {card.tags.map((t) => (
                        <span className="liquid-glass cine-tag" key={t}>{t}</span>
                      ))}
                    </div>
                  </div>
                  <div className="cine-card-spacer" />
                  <h3 className="cine-card-title">{card.title}</h3>
                  <p className="cine-card-body">{card.body}</p>
                </article>
              </motion.div>
            ))}
          </div>

          <motion.div
            className="cine-end"
            initial={rise.initial}
            whileInView={rise.animate}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ ...ease, delay: 0.3 }}
          >
            <p>
              Stages two through five — measuring, proposing, answering, forecasting — are planned,
              not built. You can verify that the easy way: stage one is the only one you can use.
            </p>
            <Link className="liquid-glass-strong cine-cta" href="/intake">
              Start the questions <ArrowUpRight />
            </Link>
            <span className="cine-foot">Ledgerline · a read on the business, not a dashboard</span>
          </motion.div>
        </div>
      </section>
    </div>
  );
}
