// The landing page — ux-spec §7.1. It sells the sheet itself: the hero
// is a sample diagnosis page, and the body follows the report's own
// numbered sections, set like a table of contents.
//
// Every claim on this page is something the code does. The check counts
// come from lib/marketing/checks.ts (held to the validation rules by a
// test); the price is the one checkout charges; the examiner and the
// guarantee blocks appear only once the owner has supplied them.

import Link from "next/link";
import { CHECKS, CHECK_AREAS } from "../../lib/marketing/checks";
import type { CheckKind } from "../../lib/marketing/checks";
import { EXAMINER, GUARANTEE } from "../../lib/marketing/offer";
import { moneyText } from "../sheet/num";
import { SampleSheet } from "./SampleSheet";

const KIND_WORD: Record<CheckKind, string> = {
  consistency: "Consistency",
  arithmetic: "Arithmetic",
  measured: "Measured",
};

const AREA_WORD: Record<string, string> = {
  finance: "Money",
  sales: "Sales",
  marketing: "Marketing",
  operations: "Operations",
  customers: "Customers",
  product: "Product",
};

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
const say = (n: number) => NUMBER_WORDS[n] ?? String(n);

interface Section {
  id: string;
  title: string;
}

export function Landing({ price }: { price: { amount_minor: number; currency: string } }) {
  const priceText = moneyText(price.amount_minor, price.currency);
  const sections: Section[] = [
    { id: "sample", title: "A sample page" },
    { id: "checked", title: "What is checked" },
    { id: "method", title: "How the numbers are made" },
    ...(EXAMINER ? [{ id: "examiner", title: "Who examines it" }] : []),
    { id: "price", title: "Price" },
    { id: "faq", title: "Questions" },
  ];
  const n = (id: string) => sections.findIndex((s) => s.id === id) + 1;
  const guarantee = GUARANTEE
    ? `If I don't find ${say(GUARANTEE.min_findings)} fixable leaks worth more than ${priceText} together, you get a full refund.`
    : null;

  return (
    <div className="desk lp">
      <a className="lp-skip" href="#main">
        Skip to content
      </a>
      <header className="mast">
        <div className="mast-in">
          <Link href="/" className="mast-mark">
            Ledgerline
          </Link>
          <nav className="mast-nav" aria-label="Site">
            <a href="#sample">Sample</a>
            <a href="#checked">What is checked</a>
            <a href="#price">Price</a>
            <Link href="/login">Sign in</Link>
          </nav>
        </div>
      </header>

      <main id="main">
        <section className="lp-hero on-desk" aria-labelledby="lp-h1">
          <div className="lp-hero-copy">
            <p className="label lp-kicker">A diagnosis for online shops</p>
            <h1 id="lp-h1" className="display lp-h1">
              Find out where your shop loses money.
            </h1>
            <p className="lp-lede">
              Answer questions about your shop. I run <span className="fig">{CHECKS.length}</span>{" "}
              checks across <span className="fig">{CHECK_AREAS.length}</span> areas of the business
              and give you a report like the sample below. Every number on it says where it came
              from.
            </p>
            <div className="lp-cta">
              <Link className="act solid lp-cta-btn" href="/intake">
                Get your diagnosis — {priceText}, once →
              </Link>
              <p className="lp-cta-note">
                {guarantee ?? "The questions are free. You pay once, before I write the report."}
              </p>
            </div>
            <p className="mono lp-works">
              Works with Shopify, WooCommerce, Square, Stripe and Meta Ads. Connecting them is
              optional, and read-only.
            </p>
          </div>
          <nav className="toc" aria-label="Contents">
            <p className="label">Contents</p>
            <ol>
              {sections.map((s, i) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>
                    <span className="toc-n fig">§{i + 1}</span>
                    <span className="toc-t">{s.title}</span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </section>

        <section id="sample" className="lp-sec" aria-labelledby="h-sample">
          <h2 id="h-sample" className="lp-sec-h on-desk">
            <span className="fig">§{n("sample")}</span> A sample page
          </h2>
          <p className="lp-sec-note on-desk">
            A made-up shop. Your report has the same parts, with your numbers.
          </p>
          <SampleSheet />
        </section>

        <section id="checked" className="lp-sec" aria-labelledby="h-checked">
          <h2 id="h-checked" className="lp-sec-h on-desk">
            <span className="fig">§{n("checked")}</span> What is checked
          </h2>
          <div className="sheet lp-sheet">
            <p className="lp-p">
              <span className="fig">{CHECKS.length}</span> checks across{" "}
              <span className="fig">{CHECK_AREAS.length}</span> areas. Consistency checks compare
              your answers with each other. Arithmetic checks work out a number from the ones you
              gave. Measured checks compare your answers with a connected account.
            </p>
            <div className="ds-scroll">
              <table className="ds-table ds-table-tight lp-checks">
                <caption className="vh">Every check the diagnosis runs</caption>
                <thead>
                  <tr>
                    <th scope="col">Area</th>
                    <th scope="col">What I check</th>
                    <th scope="col">Kind</th>
                  </tr>
                </thead>
                <tbody>
                  {CHECKS.map((c) => (
                    <tr key={c.source}>
                      <td className="mono">{AREA_WORD[c.area] ?? c.area}</td>
                      <th scope="row">{c.what}</th>
                      <td className="label">{KIND_WORD[c.kind]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section id="method" className="lp-sec" aria-labelledby="h-method">
          <h2 id="h-method" className="lp-sec-h on-desk">
            <span className="fig">§{n("method")}</span> How the numbers are made
          </h2>
          <div className="sheet lp-sheet">
            <dl className="lp-bases">
              <div>
                <dt className="label">Observed</dt>
                <dd>Read from an account you connected, such as Shopify or Meta Ads.</dd>
              </div>
              <div>
                <dt className="label">Derived</dt>
                <dd>Worked out by arithmetic from other facts. The sum is shown.</dd>
              </div>
              <div>
                <dt className="label">Estimated</dt>
                <dd>Your own estimate. The report says when a finding leans on one.</dd>
              </div>
              <div>
                <dt className="label">Assumed</dt>
                <dd>An input to a forecast, stated so you can disagree with it.</dd>
              </div>
            </dl>
            <ul className="lp-rules">
              <li>
                Every fact keeps its source and its date. A new answer is added on top of the old
                one, never written over it, so you can see what changed.
              </li>
              <li>
                A finding has to point at the facts it rests on. One that can&rsquo;t is thrown out,
                not patched up.
              </li>
              <li>
                Margins, break-even and return on ad spend are worked out by code, not guessed.
              </li>
              <li>Forecasts are ranges, and they name the inputs that are assumptions.</li>
              <li>
                &ldquo;I don&rsquo;t know&rdquo; is a real answer. Gaps are listed in the report,
                not filled in.
              </li>
            </ul>
          </div>
        </section>

        {EXAMINER && (
          <section id="examiner" className="lp-sec" aria-labelledby="h-examiner">
            <h2 id="h-examiner" className="lp-sec-h on-desk">
              <span className="fig">§{n("examiner")}</span> Who examines it
            </h2>
            <div className="sheet lp-sheet lp-examiner">
              <img src={EXAMINER.photo} alt={EXAMINER.name} width={120} height={150} />
              <div>
                <p className="label">Examined by</p>
                <p className="lp-examiner-name">{EXAMINER.name}</p>
                <p className="mono">{EXAMINER.role}</p>
                <p className="lp-p">{EXAMINER.note}</p>
              </div>
            </div>
          </section>
        )}

        <section id="price" className="lp-sec" aria-labelledby="h-price">
          <h2 id="h-price" className="lp-sec-h on-desk">
            <span className="fig">§{n("price")}</span> Price
          </h2>
          <div className="sheet lp-sheet lp-price">
            <div>
              <p className="display lp-price-fig">{priceText}</p>
              <p className="mono">once · not a subscription</p>
            </div>
            <div>
              <p className="label">What you get</p>
              <ul className="lp-rules">
                <li>
                  The report: results against a range, findings with their evidence, and what fixing
                  them could recover.
                </li>
                <li>Your fact sheet: every answer you gave, with its source and date.</li>
                <li>A list of the gaps that would sharpen the report if you filled them.</li>
                <li>A printable copy.</li>
              </ul>
              <Link className="act solid" href="/intake">
                Get your diagnosis — {priceText}, once →
              </Link>
              <p className="lp-cta-note lp-cta-note-sheet">
                {guarantee ?? "The questions are free. You pay before I write the report."}
              </p>
            </div>
          </div>
        </section>

        <section id="faq" className="lp-sec" aria-labelledby="h-faq">
          <h2 id="h-faq" className="lp-sec-h on-desk">
            <span className="fig">§{n("faq")}</span> Questions
          </h2>
          <div className="sheet lp-sheet">
            <dl className="lp-faq">
              <dt>What do I have to do?</dt>
              <dd>
                Answer questions about your shop. The first 25 are enough to start. You can stop and
                come back at any time; your answers are kept.
              </dd>
              <dt>What if I don&rsquo;t know a number?</dt>
              <dd>
                Say so. &ldquo;I don&rsquo;t know&rdquo; is recorded as an answer, and the report
                lists it as a gap instead of guessing.
              </dd>
              <dt>Will Ledgerline change anything in my shop?</dt>
              <dd>
                No. The diagnosis only reads. Connected accounts are read-only, and nothing runs
                without your approval.
              </dd>
              <dt>What happens to my answers?</dt>
              <dd>
                They are used for your report. They are never sold, and never used to train models.
              </dd>
              <dt>When do I pay?</dt>
              <dd>The questions are free. You pay {priceText}, once, before I write the report.</dd>
            </dl>
          </div>
        </section>
      </main>

      <footer className="lp-foot on-desk">
        <p className="mono">
          Ledgerline · a diagnosis of your shop, with the arithmetic shown ·{" "}
          <Link href="/login">Sign in</Link>
        </p>
      </footer>
    </div>
  );
}
