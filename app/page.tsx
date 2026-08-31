// The landing page — liquid-glass rebuild (owner-directed restyle).
//
// Structure and motion follow the cinematic two-section spec: full-bleed
// hero, capabilities grid, Instrument Serif italic display over Barlow,
// glass surfaces whose borders are gradient strokes cut with CSS masks,
// staggered blur-in everywhere. Everything else is ours:
//
//   - No external videos. The spec's CloudFront clips are someone else's
//     assets; the atmosphere is a drifting monochrome aurora instead.
//   - No Framer Motion. BlurText/Reveal do the identical animation with
//     CSS transitions and an IntersectionObserver — zero new deps.
//   - No invented numbers. The stat cards, the badge, the trust line and
//     the five-stage row all state things the product actually does; the
//     four unbuilt stages are dimmed and say so.
//
// The previous landing's instruments (MorphDemo, Reel, Arc, Trust) are
// parked in components/landing/, not deleted — they can be folded back in
// as sections if this direction wants proof under the fold.

import type { Metadata } from "next";
import Link from "next/link";
import { BlurText } from "@/components/landing/cine/BlurText";
import { Reveal } from "@/components/landing/cine/Reveal";

export const metadata: Metadata = {
  title: "Ledgerline — where your business actually leaks money",
  description:
    "Answer questions about your business for about fifteen minutes. Get back a read on where the money goes, with the arithmetic shown for every figure.",
};

/* ── the spec's stroke icons, inline ── */

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

const LedgerIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h5" />
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

/* ── content: ours, and all of it true ── */

const NAV = [
  { label: "What exists", href: "#capabilities" },
  { label: "Fact sheet", href: "/profile" },
  { label: "Report", href: "/report" },
  { label: "Privacy", href: "#privacy" },
];

const STAGES = [
  { name: "Understands", live: true },
  { name: "Measures", live: false },
  { name: "Proposes", live: false },
  { name: "Answers", live: false },
  { name: "Forecasts", live: false },
];

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

export default function Home() {
  return (
    <div className="cine">
      {/* ── section 1: hero ── */}
      <section className="cine-hero">
        <div className="cine-aurora" aria-hidden="true">
          <i /><i /><i />
        </div>

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
          <Reveal delay={400}>
            <div className="liquid-glass cine-badge">
              <span className="cine-badge-new">Pilot</span>
              Free for the first ten businesses — every figure earns its keep
            </div>
          </Reveal>

          <h1 className="cine-h1">
            <BlurText text="Most owners are wrong about which product makes them money." />
          </h1>

          <Reveal delay={800}>
            <p className="cine-sub">
              Not through carelessness — the numbers live in six places and none of them talk.
              Answer plain questions for about fifteen minutes and I&rsquo;ll show you where the
              money actually goes, with the arithmetic behind every figure.
            </p>
          </Reveal>

          <Reveal delay={1100}>
            <div className="cine-ctas">
              <Link className="liquid-glass-strong cine-cta" href="/intake">
                Start — about 15 minutes <ArrowUpRight />
              </Link>
              <a className="cine-cta-quiet" href="#capabilities">
                <Play /> See what exists
              </a>
            </div>
          </Reveal>

          <Reveal delay={1300}>
            <div className="cine-stats">
              <div className="liquid-glass cine-stat">
                <ClockIcon />
                <strong>15 min</strong>
                <span>From the first question to your first read</span>
              </div>
              <div className="liquid-glass cine-stat">
                <LedgerIcon />
                <strong>Every figure</strong>
                <span>Carries its source, or says it&rsquo;s missing</span>
              </div>
            </div>
          </Reveal>
        </div>

        <Reveal delay={1400} className="cine-trustbar">
          <div className="liquid-glass cine-trustpill" id="privacy">
            No account. No card. Read-only. Your answers are never sold or used to train models.
          </div>
          <div className="cine-stages">
            {STAGES.map((s) => (
              <span key={s.name} className={s.live ? "live" : ""}>
                {s.name}
                {s.live && <em>live</em>}
              </span>
            ))}
          </div>
        </Reveal>
      </section>

      {/* ── section 2: capabilities ── */}
      <section className="cine-caps" id="capabilities">
        <div className="cine-aurora dim" aria-hidden="true">
          <i /><i />
        </div>

        <div className="cine-caps-inner">
          <header className="cine-caps-head">
            <Reveal onScroll>
              <p className="cine-label">// What exists today — stage one of five</p>
            </Reveal>
            <h2 className="cine-h2">
              <BlurText text="A diagnosis, end to end" />
            </h2>
          </header>

          <div className="cine-grid">
            {CARDS.map((card, i) => (
              <Reveal key={card.title} onScroll delay={i * 150}>
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
              </Reveal>
            ))}
          </div>

          <Reveal onScroll delay={300} className="cine-end">
            <p>
              Stages two through five — measuring, proposing, answering, forecasting — are planned,
              not built. You can verify that the easy way: stage one is the only one you can use.
            </p>
            <Link className="liquid-glass-strong cine-cta" href="/intake">
              Start the questions <ArrowUpRight />
            </Link>
            <span className="cine-foot">Ledgerline · a read on the business, not a dashboard</span>
          </Reveal>
        </div>
      </section>
    </div>
  );
}
