// "My track record" on /history — idea 54 (I-54.4). SYB grading its own
// forecasts in public, beside the scorecard that grades its proposals. The
// view arrives in words from the server (lib/forecasts/view); this only
// lays it out. A miss gets the same word, box and type as a hit: the
// verdict is the content, not a colour.

import type { TrackView, TrackWord } from "../../lib/forecasts/view";

const WORD: Record<TrackWord, { word: string; tone: string }> = {
  inside: { word: "inside", tone: "ink" },
  above: { word: "above", tone: "ink" },
  below: { word: "below", tone: "ink" },
  cant_tell: { word: "can't tell", tone: "" },
  waiting: { word: "waiting", tone: "" },
};

export function TrackRecord({ track }: { track: TrackView }) {
  return (
    <section className="cs hi-track" aria-labelledby="hi-track-title">
      <header className="cs-head">
        <div>
          <p className="cs-label">My track record</p>
          <h2 className="cs-title" id="hi-track-title">
            {track.headline}
          </h2>
        </div>
      </header>
      {track.entries.length > 0 && (
        <div className="hi-track-body">
          {track.kinds.length > 0 && (
            <ul className="hi-track-kinds">
              {track.kinds.map((k) => (
                <li key={k.kind}>{k.sentence}</li>
              ))}
            </ul>
          )}
          <ol className="hi-rows">
            {track.entries.map((e) => {
              const w = WORD[e.word];
              return (
                <li key={e.id} className="hi-track-row">
                  <span className="hi-kind">
                    <span className={`word boxed ${w.tone}`}>{w.word}</span>
                  </span>
                  <span className="hi-what">
                    <span className="hi-title">{e.claim}</span>
                    <span className="hi-ref">
                      {e.kind_label} · {e.said_on} · range {e.range}
                    </span>
                    <span className="hi-detail">On what basis: {e.basis}</span>
                    <span className="hi-detail hi-track-happened">What happened: {e.happened}</span>
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
        <p>
          I record each forecast the moment I show it, with the range I gave, and grade it once its
          time has passed, from measured figures only. A grade can&rsquo;t be changed.
        </p>
        <p>
          &ldquo;Can&rsquo;t tell&rdquo; means the measured figures weren&rsquo;t there, or
          something I didn&rsquo;t forecast got in the way, such as a delivery. It never counts as
          right.
        </p>
      </footer>
    </section>
  );
}
