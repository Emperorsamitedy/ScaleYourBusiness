"use client";

// "Before you tell me anything" — P1-55.
//
// A list of four privacy promises is the least convincing way to make a
// privacy promise. So this draws the actual data posture instead: an
// answer travels from the owner into their profile, and on into their
// report — and the three routes it never takes are on the same diagram,
// visibly severed, with packets that set off down them and die at the cut.
//
// Every claim here is one the product currently keeps. Nothing on this
// panel describes an intention.

const BLOCKED = [
  { label: "sold to anyone", x: 232, y: 268 },
  { label: "used to train models", x: 430, y: 292 },
  { label: "shown to other users", x: 628, y: 268 },
];

export function Trust() {
  return (
    <div className="trust">
      <header className="trust-head">
        <span>What happens to what you tell me</span>
        <span className="trust-mono">read-only · no third parties</span>
      </header>

      <svg
        viewBox="0 0 860 340"
        className="trust-svg"
        role="img"
        aria-label="Your answers travel into your profile and into your report. They are never sold, never used to train models, and never shown to other users."
      >
        <defs>
          <linearGradient id="tLive" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#e1560f" />
            <stop offset="100%" stopColor="#f59b4b" />
          </linearGradient>
        </defs>

        {/* the two routes an answer actually takes */}
        <line
          className="t-live"
          x1="128"
          y1="150"
          x2="336"
          y2="150"
          stroke="url(#tLive)"
          strokeWidth="1.6"
        />
        <line
          className="t-live"
          x1="524"
          y1="150"
          x2="700"
          y2="150"
          stroke="url(#tLive)"
          strokeWidth="1.6"
        />

        {/* the three it never takes */}
        {BLOCKED.map((b) => (
          <g key={b.label}>
            <line
              x1="430"
              y1="200"
              x2={b.x}
              y2={b.y - 16}
              stroke="rgba(255,255,255,.13)"
              strokeWidth="1.2"
              strokeDasharray="3 5"
            />
            <g className="t-cut" style={{ transform: `translate(${b.x}px, ${b.y}px)` }}>
              <circle r="13" fill="rgba(255,122,114,.07)" stroke="rgba(255,122,114,.4)" />
              <path
                d="M-5,-5 L5,5 M5,-5 L-5,5"
                stroke="#ff7a72"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </g>
            <text x={b.x} y={b.y + 32} textAnchor="middle" className="t-blocked">
              never {b.label}
            </text>
          </g>
        ))}

        {/* you */}
        <circle
          cx="86"
          cy="150"
          r="30"
          fill="rgba(255,255,255,.05)"
          stroke="rgba(255,255,255,.18)"
        />
        <circle cx="86" cy="150" r="7" fill="#eef0f2" />
        <text x="86" y="204" textAnchor="middle" className="t-label">
          you
        </text>

        {/* your profile — the sealed middle */}
        <g className="t-vault">
          <rect
            x="336"
            y="104"
            width="188"
            height="96"
            rx="10"
            fill="rgba(245,155,75,.07)"
            stroke="rgba(245,155,75,.42)"
          />
          <path
            d="M424,142 v-9 a6,6 0 0 1 12,0 v9"
            fill="none"
            stroke="#f59b4b"
            strokeWidth="1.6"
          />
          <rect
            x="420"
            y="142"
            width="20"
            height="15"
            rx="2.5"
            fill="none"
            stroke="#f59b4b"
            strokeWidth="1.6"
          />
          <text x="430" y="180" textAnchor="middle" className="t-label hot">
            your profile
          </text>
          <text x="430" y="196" textAnchor="middle" className="t-blocked">
            214 facts · yours
          </text>
        </g>

        {/* your report */}
        <rect
          x="700"
          y="112"
          width="120"
          height="76"
          rx="8"
          fill="rgba(255,255,255,.05)"
          stroke="rgba(255,255,255,.18)"
        />
        <line x1="722" y1="140" x2="798" y2="140" stroke="rgba(255,255,255,.3)" strokeWidth="1.4" />
        <line
          x1="722"
          y1="154"
          x2="778"
          y2="154"
          stroke="rgba(255,255,255,.18)"
          strokeWidth="1.4"
        />
        <line
          x1="722"
          y1="168"
          x2="790"
          y2="168"
          stroke="rgba(255,255,255,.18)"
          strokeWidth="1.4"
        />
        <text x="760" y="210" textAnchor="middle" className="t-label">
          your report
        </text>

        {/* packets: two that arrive, three that die at the cut */}
        <circle className="t-pkt t-p1" r="4.5" fill="#f59b4b" />
        <circle className="t-pkt t-p2" r="4.5" fill="#f59b4b" />
        <circle className="t-pkt t-b1" r="3.5" fill="#ff7a72" />
        <circle className="t-pkt t-b2" r="3.5" fill="#ff7a72" />
        <circle className="t-pkt t-b3" r="3.5" fill="#ff7a72" />
      </svg>

      <footer className="trust-foot">
        <div>
          <span className="trust-k">your account</span>
          <p>There isn&rsquo;t one. An email and a link — no password to forget or leak.</p>
        </div>
        <div>
          <span className="trust-k">stopping halfway</span>
          <p>Everything is saved as you go, and the link brings it back on any device.</p>
        </div>
        <div>
          <span className="trust-k">what it changes</span>
          <p>Nothing. This version reads and explains; it touches none of your other tools.</p>
        </div>
      </footer>
    </div>
  );
}
