// The landing page — P1-55, second attempt.
//
// The first version was a hero, three feature cards and a bullet list:
// the shape of every generated landing page on the internet, and it read
// like one. This one argues instead of describing.
//
// The product's whole claim is that owners are wrong about which product
// makes them money. So the page SHOWS that finding — the real chart, the
// bestseller as the shortest bar — above the fold, before asking anyone
// for fifteen minutes. Everything below it is hairline-ruled sequence and
// a plain ledger of what we do with their answers. No card grid anywhere.

import type { Metadata } from "next";
import Link from "next/link";
import { MorphDemo } from "@/components/landing/MorphDemo";
import { Reel } from "@/components/landing/Reel";

export const metadata: Metadata = {
  title: "Ledgerline — where your business actually leaks money",
  description:
    "Answer questions about your business for about fifteen minutes. Get back a read on where the money goes, with the arithmetic shown for every figure.",
};

/** The proof: five offers read out on a segmented meter, worst last. */
const CELLS = 26;
const SCAN = [
  { name: "Gift box", margin: 61, share: 9 },
  { name: "Winter spice", margin: 44, share: 11 },
  { name: "Sampler 3×0.1L", margin: 38, share: 5 },
  { name: "Szörp 1L", margin: 31, share: 14 },
  { name: "Szörp 0.5L", margin: 18, share: 61, critical: true },
];
const PEAK = 61;

const SEQUENCE = [
  {
    n: "01",
    t: "You answer questions",
    d: "One at a time, in plain language, for about fifteen minutes. “I don’t know” is a real answer — what you can’t say is worth knowing too.",
  },
  {
    n: "02",
    t: "Every answer keeps its source",
    d: "Whether you stated it, guessed it, or I worked it out. Change your mind later and the old answer stays in the history, with your reason.",
  },
  {
    n: "03",
    t: "You get a read on the business",
    d: "Where the margin actually is, what it costs you, and what would change if you moved a price — with the arithmetic shown, not asserted.",
  },
];

const LEDGER = [
  ["your answers", "stay yours — not sold, not shown to anyone else"],
  ["your account", "there isn’t one. an email and a link, no password"],
  ["stopping halfway", "everything is saved as you go"],
  ["what it changes", "nothing. this version reads and explains"],
];

export default function Home() {
  return (
    <main className="land">
      <header className="land-top">
        <span className="wordmark">Ledgerline</span>
        <Link className="ghost quiet" href="/intake">
          Continue where I left off
        </Link>
      </header>

      <section className="hero2">
        <div className="hero2-type">
          <p className="kicker">For people who run a small business</p>
          <h1>
            Most owners are wrong about which product{" "}
            <span className="hero2-mark">makes them money</span>.
          </h1>
          <p className="land-lede">
            Not through carelessness — the numbers live in six places and none of them talk. Answer
            some questions and I&rsquo;ll show you where the money actually goes, and the arithmetic
            behind every figure.
          </p>
          <div className="row">
            <Link className="next" href="/intake">
              Start — about 15 minutes
            </Link>
            <span className="hint">no account, no card</span>
          </div>
        </div>

        <div className="hero2-panel">
          <MorphDemo />
        </div>
      </section>

      {/* the proof: an instrument reading it out, not a chart of it */}
      <section className="scan" aria-label="Margin analysis across five products">
        <span className="scan-line" aria-hidden="true" />
        <header className="scan-head">
          <span>Analysis · 5 offers · margin per unit</span>
          <span>Szörp Kft. · 14 min</span>
        </header>

        <div className="scan-rows">
          {SCAN.map((o, i) => {
            const lit = Math.round((o.margin / PEAK) * CELLS);
            return (
              <div className={o.critical ? "scan-row crit" : "scan-row"} key={o.name}>
                <span className="scan-i">{String(i + 1).padStart(2, "0")}</span>
                <span className="scan-name">{o.name}</span>
                <span className="scan-meter" aria-hidden="true">
                  {Array.from({ length: CELLS }, (_, c) => (
                    <i
                      key={c}
                      className={c < lit ? "on" : ""}
                      style={{ transitionDelay: `${i * 90 + c * 16}ms` }}
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
          <span>
            Her best seller was her least profitable — 61% of everything she sold, the thinnest
            margin of the five. She had been pushing it for two years.
          </span>
        </footer>
      </section>

      <section className="land-seq">
        {SEQUENCE.map((s) => (
          <article key={s.n} className="land-row">
            <span className="land-n">{s.n}</span>
            <h2>{s.t}</h2>
            <p>{s.d}</p>
          </article>
        ))}
      </section>

      <section className="land-examples">
        <h2>What you get back</h2>
        <p className="land-lede" style={{ marginBottom: 34 }}>
          Three of the things the diagnosis produces. Every figure on them can say where it came
          from, and every one of them is arithmetic you can check.
        </p>
        <Reel />
      </section>

      <section className="land-ledger">
        <h2>Before you tell me anything</h2>
        <dl>
          {LEDGER.map(([k, v]) => (
            <div key={k} className="ledger-row">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="land-end">
        <h2>Fifteen minutes, and you’ll know which line to stop pushing.</h2>
        <div className="row">
          <Link className="next" href="/intake">
            Start the questions
          </Link>
          <span className="hint">stop any time — it’s saved</span>
        </div>
      </section>

      <footer className="land-foot">Ledgerline · a read on the business, not a dashboard</footer>
    </main>
  );
}
