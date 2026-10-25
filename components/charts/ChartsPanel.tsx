"use client";

// The charts on the first screen after sign-in (the fact sheet, /profile):
// the market chart, and beneath it the bookings and ads charts where the
// business has that data. Reads GET /api/charts once. While it reads, it
// says so in words; if the read fails, it says that and the rest of the
// screen carries on — a chart is never what stands between the owner and
// their record.

import "../../app/charts.css";
import { useEffect, useState } from "react";
import type { ChartsBundle } from "../../lib/charts/load";
import { MarketChart } from "./MarketChart";
import { AdsChart, BookingsChart } from "./SmallCharts";

export function ChartsPanel() {
  const [bundle, setBundle] = useState<ChartsBundle | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/charts", { cache: "no-store" })
      .then((r) =>
        r.ok ? (r.json() as Promise<ChartsBundle>) : Promise.reject(new Error(String(r.status))),
      )
      .then((b) => {
        if (alive) setBundle(b);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (failed) {
    return (
      <section className="cs mk" aria-label="Your numbers as a chart">
        <div className="cs-body">
          <p className="mk-sub" role="alert">
            I couldn&rsquo;t read your numbers for the chart just now. Refresh to try again —
            nothing is lost.
          </p>
        </div>
      </section>
    );
  }
  if (bundle === null) {
    return (
      <section className="cs mk" aria-label="Your numbers as a chart" aria-busy="true">
        <div className="cs-body">
          <p className="mk-sub" role="status">
            Reading your measured days…
          </p>
        </div>
      </section>
    );
  }
  const small = [
    bundle.bookings ? <BookingsChart key="bookings" model={bundle.bookings} /> : null,
    bundle.ads ? <AdsChart key="ads" model={bundle.ads} /> : null,
  ].filter(Boolean);
  return (
    <>
      <MarketChart model={bundle.market} />
      {small.length > 0 && <div className="sc-grid">{small}</div>}
    </>
  );
}
