// The landing page — the owner's landing design (2026-10-17), built as
// app components: a hero with the product walkthrough, the store read as
// a candlestick chart, the nine panels, how it works, the price card,
// questions and the footer, alternating desk and paper bands.
//
// Placeholders the owner still has to supply print as the design's
// brackets — "[7]", "[3]", "[Company details]" — from
// lib/marketing/offer.ts, so nothing here invents a deadline or a
// promise. The price on every button is reportPrice(), the same value
// checkout charges. The store in the walkthrough and the chart is
// fictional and labelled as illustrative where it renders.

import Link from "next/link";
import { PANELS } from "../../lib/marketing/areas";
import { DELIVERY_DAYS, GUARANTEE } from "../../lib/marketing/offer";
import { moneyText } from "../sheet/num";
import { StoreChart } from "./StoreChart";
import { Walkthrough } from "./Walkthrough";

const STEPS = [
  { when: "Day 0 · 2 min", t: "Connect", d: "Read-only. Nothing changes." },
  {
    when: "Day 0 · 12 min",
    t: "Answer a few questions",
    d: "Only what your numbers can’t tell us.",
  },
  { when: "Day 7", t: "Get your results", d: "Every leak priced, charted, and three fixes first." },
] as const;

const INCLUDED = [
  ["36 markers, each priced", "✓"],
  ["Your revenue chart, leaks marked", "✓"],
  ["3 fixes, in order", "✓"],
  ["Signed, 30-min walkthrough", "✓"],
  ["Subscription", "none"],
] as const;

const FAQ = [
  ["Do you need my password?", "No. A read-only connection you can remove any time."],
  [
    "Will anything change in my accounts?",
    "No. We only read. Nothing ever runs without your approval.",
  ],
  [
    "Is my business big enough?",
    "Built for businesses doing about $10k–$50k a month. Too small to read? We tell you before you pay.",
  ],
] as const;

export function Landing({ price }: { price: { amount_minor: number; currency: string } }) {
  const priceText = moneyText(price.amount_minor, price.currency);
  const days = DELIVERY_DAYS === null ? "[7]" : String(DELIVERY_DAYS);
  const leaks = GUARANTEE === null ? "[3]" : String(GUARANTEE.min_findings);
  // The last step's day is the delivery promise, so it follows DELIVERY_DAYS too.
  const steps = STEPS.map((s, i) => (i === STEPS.length - 1 ? { ...s, when: `Day ${days}` } : s));

  return (
    <div className="ll">
      <header className="ll-head">
        <div className="ll-w ll-head-in">
          <a href="#top" className="ll-s ll-logo">
            Ledgerline
          </a>
          <nav aria-label="Main" className="ll-nav">
            <a className="ll-nl" href="#chart">
              The chart
            </a>
            <a className="ll-nl" href="#panels">
              What we test
            </a>
            <a className="ll-nl" href="#price">
              Price
            </a>
            <Link className="ll-nl" href="/login">
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section id="top" className="ll-w ll-hero" aria-labelledby="ll-h1">
          <div className="ll-hero-copy">
            <div className="ll-m ll-pill">
              <span className="ll-beat" aria-hidden="true" />A blood test for your business
            </div>
            <h1 id="ll-h1" className="ll-s ll-hd">
              Your business looks healthy.
              <br />
              <span style={{ fontStyle: "italic", color: "#FF9C8F" }}>Its numbers</span> might not.
            </h1>
            <p className="ll-lede">
              We run 36 checks on your sales, bookings, payments and ads, price every leak in euros,
              and hand you a signed report in {days} days.
            </p>
            <div className="ll-ctas">
              <Link className="ll-go" href="/signup">
                Book your test — {priceText} <span aria-hidden="true">→</span>
              </Link>
              <a className="ll-go line" href="#chart">
                See what we find
              </a>
            </div>
            <div className="ll-m ll-trust">
              <span>
                <span style={{ color: "#9FD7B3" }}>✓</span> Read-only
              </span>
              <span>
                <span style={{ color: "#9FD7B3" }}>✓</span> Signed by a person
              </span>
              <span>
                <span style={{ color: "#9FD7B3" }}>✓</span> Refund if we find nothing
              </span>
            </div>
          </div>
          <Walkthrough />
        </section>

        <section id="chart" className="ll-band-deep" aria-labelledby="ll-h-chart">
          <div className="ll-w ll-pad-chart">
            <div className="ll-sec-top">
              <div>
                <div className="ll-k" style={{ color: "#8FA8FF" }}>
                  The chart
                </div>
                <h2 id="ll-h-chart" className="ll-s ll-h2" style={{ maxWidth: "13em" }}>
                  Your business, read like a stock.
                </h2>
              </div>
              <p className="ll-sec-aside">
                We mark the day each leak started — and shade what it cost you.
              </p>
            </div>
            <StoreChart />
          </div>
        </section>

        <section id="panels" className="ll-paper" aria-labelledby="ll-h-panels">
          <div className="ll-w ll-pad-96">
            <div className="ll-k" style={{ color: "#3E5248" }}>
              What we test
            </div>
            <h2 id="ll-h-panels" className="ll-s ll-h2" style={{ maxWidth: "14em" }}>
              Nine panels. Everything that moves your profit.
            </h2>
            <ol className="ll-panels">
              {PANELS.map((p) => (
                <li key={p.no} className="ll-panel">
                  <span className="ll-m ll-panel-no">{p.no}</span>
                  <span className="ll-s ll-panel-name">{p.name}</span>
                  <span className="ll-m ll-panel-markers">{p.markers}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="read" className="ll-w ll-pad-104" aria-labelledby="ll-h-read">
          <div className="ll-k" style={{ color: "#A9BDB2" }}>
            How it works
          </div>
          <h2 id="ll-h-read" className="ll-s ll-h2" style={{ maxWidth: "13em" }}>
            Fifteen minutes from you.
          </h2>
          <ol className="ll-steps">
            {steps.map((s) => (
              <li key={s.t} className="ll-step">
                <div className="ll-m ll-step-when">{s.when}</div>
                <h3 className="ll-s ll-step-t">{s.t}</h3>
                <p className="ll-step-d">{s.d}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="price" className="ll-paper" aria-labelledby="ll-h-price">
          <div className="ll-w ll-pad-96 ll-price">
            <div className="ll-price-head">
              <div className="ll-k" style={{ color: "#3E5248" }}>
                Price
              </div>
              <h2 id="ll-h-price" className="ll-s ll-h2">
                One test.
                <br />
                One price.
              </h2>
            </div>
            <div className="ll-price-card">
              <div className="ll-price-top">
                <span className="ll-s" style={{ fontSize: 24, fontWeight: 600 }}>
                  Full business panel
                </span>
                <span>
                  <span className="ll-s ll-price-fig">{priceText}</span>{" "}
                  <span className="ll-m" style={{ fontSize: 13, color: "#3E5248" }}>
                    once
                  </span>
                </span>
              </div>
              <ul className="ll-m ll-included">
                {INCLUDED.map(([what, mark]) => (
                  <li key={what}>
                    <span>{what}</span>
                    <span>{mark}</span>
                  </li>
                ))}
              </ul>
              <Link className="ll-go ink ll-go-full" href="/signup">
                Book your test <span aria-hidden="true">→</span>
              </Link>
              <p className="ll-refund">Fewer than {leaks} fixable leaks? Full refund.</p>
            </div>
          </div>
        </section>

        <section className="ll-w ll-faq" aria-labelledby="ll-h-faq">
          <h2 id="ll-h-faq" className="ll-s ll-faq-h">
            Questions
          </h2>
          <div className="ll-faq-list">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>
                  {q}
                  <span className="ll-pm" aria-hidden="true">
                    +
                  </span>
                </summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="ll-foot">
        <div className="ll-w ll-foot-in">
          <span className="ll-s" style={{ fontSize: 20, fontWeight: 700 }}>
            Ledgerline
          </span>
          <Link className="ll-go line" href="/signup" style={{ minHeight: 46 }}>
            Book your test — {priceText} →
          </Link>
          <span className="ll-m" style={{ fontSize: 11.5, color: "#A9BDB2" }}>
            [Company details] · <Link href="/terms">Terms</Link> ·{" "}
            <Link href="/privacy">Privacy</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
