"use client";

// The shared report — idea 51. What someone the owner sent a link to sees:
// the report body exactly as the owner's screen draws it (ReportBody), read
// only, under a masthead that names the business and says what this is.
// Nothing here leads into the account: no rail (AppFrame draws none on
// /shared), no sub-nav, no wordmark link, no answers to recommendations, no
// "Answer now". The data arrives from the server page already stripped of
// everything owner-only (lib/report/share.ts sharedView).

import "../../app/report.css";
import { ReportBody } from "./Report";
import { fmtDate } from "./figures";
import type { ReportView } from "./types";

export function SharedReportScreen({ report, sharedAt }: { report: ReportView; sharedAt: string }) {
  const map = report.fact_map;
  const business =
    map["identity.business_name"]?.value ?? map["identity.legal_name"]?.value ?? null;
  const platform = map["presence.platforms"]?.value ?? null;
  const context = [business, platform, report.unit_economics.currency].filter(
    (x): x is string => !!x,
  );
  return (
    <div className="rq rq-shared">
      <header className="rq-mast">
        <div className="rq-mast-l">
          <span className="rq-mark">SYB</span>
          {context.length > 0 && <span className="rq-ctx">{context.join(" · ")}</span>}
        </div>
        <div className="rq-mast-r">
          <span className="rq-ctx">Shared report · read only</span>
        </div>
      </header>
      <main className="rq-main rq-shared-main">
        <ReportBody
          report={report}
          readOnly
          onChanged={async () => {}}
          foot={
            <>
              This is a shared snapshot, made {fmtDate(sharedAt)}, of the report issued{" "}
              {fmtDate(report.generated_at)}. It shows the report as it was then and does not
              change; the business can withdraw it at any time.
            </>
          }
        />
      </main>
    </div>
  );
}
