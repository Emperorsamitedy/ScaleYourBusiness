// "My track record" on /history — idea 54 (I-54.4). SYB grading its own
// forecasts in public, beside the scorecard that grades its proposals. The
// view arrives in words from the server (lib/forecasts/view); this only
// lays it out. A miss gets the same word, box and type as a hit: the
// verdict is the content, not a colour.

import { useTranslations } from "next-intl";
import type { TrackView, TrackWord } from "../../lib/forecasts/view";
import { SegBar } from "../charts/Viz";
import { WhyFold } from "../report/WhyFold";
import { trackSegs } from "./track-segs";

const TONE: Record<TrackWord, string> = {
  inside: "ink",
  above: "ink",
  below: "ink",
  cant_tell: "",
  waiting: "",
};

export function TrackRecord({ track }: { track: TrackView }) {
  const t = useTranslations("history.track");
  const segs = trackSegs(track, (w) => t(`word.${w}`));
  return (
    <section className="cs hi-track" aria-labelledby="hi-track-title">
      <header className="cs-head">
        <div>
          <p className="cs-label">{t("label")}</p>
          <h2 className="cs-title" id="hi-track-title">
            {track.headline}
          </h2>
        </div>
      </header>
      {track.entries.length > 0 && (
        <div className="hi-track-body">
          {segs.length > 0 && (
            <div className="hi-track-bar">
              <SegBar segs={segs} label={track.headline} />
            </div>
          )}
          {track.kinds.length > 0 && (
            <ul className="hi-track-kinds">
              {track.kinds.map((k) => (
                <li key={k.kind}>{k.sentence}</li>
              ))}
            </ul>
          )}
          <ol className="hi-rows">
            {track.entries.map((e) => {
              const tone = TONE[e.word];
              return (
                <li key={e.id} className="hi-track-row">
                  <span className="hi-kind">
                    <span className={`word boxed ${tone}`}>{t(`word.${e.word}`)}</span>
                  </span>
                  <span className="hi-what">
                    <span className="hi-title">{e.claim}</span>
                    <span className="hi-ref">
                      {e.kind_label} · {e.said_on} · {t("range", { range: e.range })}
                    </span>
                    <span className="hi-detail">{t("basis", { basis: e.basis })}</span>
                    <span className="hi-detail hi-track-happened">
                      {t("happened", { happened: e.happened })}
                    </span>
                    {e.backdated && <span className="hi-detail">{e.backdated}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
          {track.older_line && <p className="hi-detail">{track.older_line}</p>}
        </div>
      )}
      <footer className="cs-foot hi-foot">
        <WhyFold>
          <p>{t("foot")}</p>
          <p>{t("cantTell")}</p>
        </WhyFold>
      </footer>
    </section>
  );
}
