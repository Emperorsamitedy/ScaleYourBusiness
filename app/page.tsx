// The landing page — P1-55. What a stranger meets before deciding to
// spend fifteen minutes on their own numbers.
//
// Four things it has to answer, in this order, because they are the
// order the questions actually arrive in someone's head: what is this,
// what do I get, how long does it take, and what happens to what I tell
// you. No pricing, no testimonials we don't have, no claims the product
// can't currently keep.

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Ledgerline — find out where your business leaks money",
  description:
    "Answer questions about your business for about fifteen minutes. Get back a read on where the money is going, with every number showing where it came from.",
};

const STEPS = [
  {
    n: "01",
    t: "You answer questions",
    d: "One at a time, in plain language. About fifteen minutes. “I don’t know” is a real answer — the gaps are useful too.",
  },
  {
    n: "02",
    t: "It builds a profile",
    d: "Every answer is kept with its source and how sure you were. Nothing is overwritten; change your mind and the old answer stays in the history.",
  },
  {
    n: "03",
    t: "You get a read on the business",
    d: "Where the margin actually is, what’s costing you, and what would change if you moved a price. Every figure shows the arithmetic behind it.",
  },
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
        <p className="kicker">For people who run small businesses</p>
        <h1>Most owners are wrong about which product makes them money.</h1>
        <p className="land-lede">
          Not because they’re careless — because the numbers live in six places and none of them
          talk. Answer some questions about your business and I’ll tell you where the money is
          actually going, and show you the arithmetic for every part of it.
        </p>
        <div className="row">
          <Link className="next" href="/intake">
            Start — about 15 minutes
          </Link>
          <span className="hint">no account needed</span>
        </div>
      </section>

      <section className="land-steps">
        {STEPS.map((s) => (
          <article key={s.n} className="land-step">
            <span className="land-n">{s.n}</span>
            <h2>{s.t}</h2>
            <p>{s.d}</p>
          </article>
        ))}
      </section>

      <section className="land-honest">
        <h2>What happens to what you tell me</h2>
        <ul>
          <li>
            <strong>It stays yours.</strong> Your answers are used to build your profile and your
            report. They are not sold, and they are not shown to anyone else.
          </li>
          <li>
            <strong>No password.</strong> At the end you can leave an email and I’ll give you a
            link that reopens your profile on any device. That’s the whole account system.
          </li>
          <li>
            <strong>You can stop anywhere.</strong> Everything you’ve answered is saved as you go.
          </li>
          <li>
            <strong>Nothing happens without you.</strong> This version reads and explains. It
            doesn’t change prices, post anything, or touch any of your other tools.
          </li>
        </ul>
        <div className="row">
          <Link className="next" href="/intake">
            Start the questions
          </Link>
        </div>
      </section>

      <footer className="land-foot">
        <span>Ledgerline · a business read, not a dashboard</span>
      </footer>
    </main>
  );
}
