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
import { ExampleCharts } from "@/components/landing/ExampleCharts";

export const metadata: Metadata = {
  title: "Ledgerline — where your business actually leaks money",
  description:
    "Answer questions about your business for about fifteen minutes. Get back a read on where the money goes, with the arithmetic shown for every figure.",
};

/** The proof, with real shape: the bestseller is the shortest bar. */
const BARS = [
  { name: "Gift box", pct: 61, w: 100 },
  { name: "Winter spice", pct: 44, w: 72 },
  { name: "Sampler", pct: 38, w: 62 },
  { name: "Szörp 1L", pct: 31, w: 51 },
  { name: "Szörp 0.5L", pct: 18, w: 30, hot: true },
];

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

      <section className="land-hero">
        <p className="kicker">For people who run a small business</p>
        <h1>
          Most owners are wrong about which product makes them money.
        </h1>
        <p className="land-lede">
          Not through carelessness — the numbers live in six places and none of them talk. Answer
          some questions and I’ll show you where the money actually goes, and the arithmetic
          behind every figure.
        </p>
        <div className="row">
          <Link className="next" href="/intake">
            Start — about 15 minutes
          </Link>
          <span className="hint">no account, no card</span>
        </div>
        <MorphDemo />
      </section>

      {/* the proof: the finding itself, not a description of it */}
      <section className="land-proof">
        <div className="land-proof-head">
          <span className="label">What one owner found in fourteen minutes</span>
          <span className="mono-note">margin per unit sold</span>
        </div>
        <div className="pbars">
          {BARS.map((b) => (
            <div key={b.name} className={b.hot ? "pbar hot" : "pbar"}>
              <span className="pname">{b.name}</span>
              <span className="ptrack">
                <span className="pfill" style={{ width: `${b.w}%` }} />
              </span>
              <span className="pval">{b.pct}%</span>
            </div>
          ))}
        </div>
        <p className="land-proof-note">
          <strong>Her best-selling product was her least profitable.</strong> It was 61% of
          everything she sold and returned the thinnest margin of the five. She had been pushing it
          for two years.
        </p>
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
        <ExampleCharts />
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
