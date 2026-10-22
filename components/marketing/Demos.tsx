"use client";

// Which illustrative business the landing shows: the webshop (the
// default) or the salon. One choice, held here, drives both the hero's
// walkthrough and the revenue chart, so the two switches on the page (in
// the hero and above the chart) always agree. A plain segmented control:
// worded buttons in a group, aria-pressed on the one showing, reachable
// by Tab like any button. Local state only — nothing is stored or sent.

import { createContext, useContext, useState, type ReactNode } from "react";
import { CHART_SERIES, SHOP_CHART, type ChartSeries } from "../../lib/marketing/sample-chart";
import { DEMO_SAMPLES, SHOP_SAMPLE, type DemoSample } from "../../lib/marketing/sample-diagnosis";

type DemoId = DemoSample["id"];

const DemoContext = createContext<{ id: DemoId; choose: (id: DemoId) => void }>({
  id: SHOP_SAMPLE.id,
  choose: () => undefined,
});

export function DemoProvider({ children }: { children: ReactNode }) {
  const [id, choose] = useState<DemoId>(SHOP_SAMPLE.id);
  return <DemoContext.Provider value={{ id, choose }}>{children}</DemoContext.Provider>;
}

/** The chosen demo's diagnosis and chart; the webshop outside a provider. */
export function useDemo(): { sample: DemoSample; chart: ChartSeries } {
  const { id } = useContext(DemoContext);
  return {
    sample: DEMO_SAMPLES.find((s) => s.id === id) ?? SHOP_SAMPLE,
    chart: CHART_SERIES.find((c) => c.id === id) ?? SHOP_CHART,
  };
}

export function DemoSwitch({ className }: { className?: string }) {
  const { id, choose } = useContext(DemoContext);
  return (
    <div
      className={className ? `ll-demo ${className}` : "ll-demo"}
      role="group"
      aria-label="Demo business"
    >
      <span className="ll-k ll-demo-k" aria-hidden="true">
        Demo
      </span>
      {DEMO_SAMPLES.map((s) => (
        <button
          key={s.id}
          type="button"
          className={s.id === id ? "ll-demo-b on" : "ll-demo-b"}
          aria-pressed={s.id === id}
          onClick={() => choose(s.id)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
