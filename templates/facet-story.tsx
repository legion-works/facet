import { useEffect, useRef, useState, type CSSProperties } from "react";

type ArtifactType = "markdown" | "mermaid" | "svg" | "chart" | "html" | "tsx";
type Signal = "normal" | "divergence" | "barrier";

const sections = [
  ["origin", "01 / origin"],
  ["build", "02 / build"],
  ["defense", "03 / defense"],
  ["guards", "04 / guards"],
  ["shipping", "05 / shipping"],
  ["live", "06 / live demo"],
] as const;

const taskData = [
  ["01", "contracts", "canonical artifact and verdict contracts", "strict status enum"],
  ["02", "store", "revision-bound storage and migrations", "wire error mapping"],
  ["03", "sandbox", "no-egress worker boundaries", "channel-set assertion"],
  ["04", "evidence", "Tier 1 evidence retention", "owner-only directories"],
  ["05", "CLI", "typed envelopes and read-back", "raw errors rejected"],
  ["06", "router", "route guards and body limits", "acceptor removed with emitter"],
  ["07", "parity", "shared renderer expectations", "duplicate helper collapse"],
  ["08", "gallery", "frame lifecycle and interaction", "native scroll preserved"],
  ["09", "templates", "supported artifact examples", "neutral fixtures"],
  ["10", "Tier 1", "protocol observation and evidence", "lifecycle cleanup"],
  ["11", "HTML", "structural HTML rendering", "external-resource disclosure"],
  ["12", "TSX", "vendored React interactive mode", "capability boundary scan"],
  ["13", "opaque", "canvas-aware partial verdicts", "screenshot fallback"],
  ["14", "exports", "stored byte and evidence export", "atomic export pairs"],
  ["15", "insecure", "explicit validation relaxation", "loud disclosure"],
  ["16", "performance", "measured service budgets", "host-sensitive gates"],
  ["17", "CI", "isolated acceptance coverage", "one browser per process"],
  ["18", "release", "gallery hardening and release cadence", "render-count parity"],
] as const;

const releases = [
  ["v1.0.0", "foundation"],
  ["v1.1.0", "evidence + SVG zoom"],
  ["v1.2.0", "opaque canvas verdicts"],
  ["v1.3.0", "insecure disclosure"],
  ["v1.4.0", "revision-bound exports"],
  ["v1.5.0", "HTML + isolation"],
  ["v1.6.0", "TSX + sharded Tier 1"],
] as const;

const verdicts = [
  ["ok", "counts agree across independent channels"],
  ["error", "expectation mismatch or discriminative error"],
  ["partial:layout_unverified", "layout has no observable viewBox"],
  ["partial:opaque_content", "canvas or opaque region observed"],
  ["partial:external_resources", "external HTTPS image cannot be observed"],
  ["partial:unstable", "interactive structure changed after the barrier"],
  ["tampered", "page channel diverges from protocol authority"],
  ["timeout", "render barrier never completed"],
  ["shim_only", "only the renderer shim produced an observation"],
  ["probe_only", "only the isolated probe produced an observation"],
  ["insecure:unvalidated", "level 3 explicitly skipped validation"],
] as const;

function Metric({
  label,
  value,
  suffix,
  decimals = 0,
}: {
  label: string;
  value: number;
  suffix: string;
  decimals?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (node === null || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 900);
      setCurrent(value * (1 - (1 - progress) ** 3));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, visible]);

  return (
    <div className="story-metric" ref={ref}>
      <strong>
        {current.toFixed(decimals)}
        {suffix}
      </strong>
      <span>{label}</span>
    </div>
  );
}

function StoryStyles() {
  return (
    <style>{`
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    .facet-story { --ink:#e8eef2; --muted:#9aaab6; --paper:#091116; --surface:#101d25; --surface-2:#142731; --line:#28404c; --cyan:#68d8e8; --lime:#b8e986; --amber:#ffd27a; --red:#ff8e99; color:var(--ink); background:radial-gradient(circle at 14% -10%,#163e4d 0,transparent 31rem),var(--paper); min-height:100vh; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; line-height:1.45; }
    .facet-story button { font:inherit; }
    .story-shell { width:min(1440px,100%); margin:0 auto; padding:28px 28px 96px; }
    .story-hero { min-height:530px; display:grid; align-content:center; grid-template-columns:minmax(0,1.1fr) minmax(330px,.9fr); gap:42px; border-bottom:1px solid var(--line); }
    .story-kicker { color:var(--cyan); font-size:12px; letter-spacing:.14em; text-transform:uppercase; }
    .story-hero h1 { margin:14px 0 18px; font-size:clamp(40px,7vw,88px); line-height:.95; letter-spacing:-.07em; max-width:760px; }
    .story-hero p { color:var(--muted); font-size:17px; max-width:650px; margin:0; }
    .story-badges { display:flex; flex-wrap:wrap; gap:8px; margin-top:24px; }
    .story-badge { border:1px solid var(--line); border-radius:999px; padding:5px 10px; color:var(--muted); font-size:11px; }
    .story-badge.good { border-color:#33736e; color:var(--cyan); background:#0e282d; }
    .story-signal { position:relative; border:1px solid var(--line); border-radius:18px; overflow:hidden; padding:20px; background:linear-gradient(145deg,#102630,#0c171e); box-shadow:0 24px 60px #0007; }
    .story-signal::before { content:""; position:absolute; inset:0; background:linear-gradient(110deg,transparent 25%,#68d8e812 45%,transparent 65%); transform:translateX(-100%); animation:scan 5s linear infinite; }
    .story-signal-top { display:flex; justify-content:space-between; color:var(--muted); font-size:11px; letter-spacing:.08em; }
    .story-signal-grid { display:grid; grid-template-columns:repeat(6,1fr); gap:7px; margin:22px 0; }
    .story-signal-grid span { height:42px; border-radius:4px; background:#18333d; animation:beat 2.4s ease-in-out infinite; }
    .story-signal-grid span:nth-child(2n) { animation-delay:.35s; background:#1d4852; } .story-signal-grid span:nth-child(3n) { animation-delay:.75s; background:#2c5960; }
    .story-signal strong { font-size:23px; display:block; } .story-signal small { color:var(--muted); }
    .story-nav { position:sticky; top:0; z-index:4; display:flex; gap:3px; overflow-x:auto; margin:0 -28px; padding:13px 28px; background:#091116ee; border-bottom:1px solid var(--line); backdrop-filter:blur(12px); }
    .story-nav a { white-space:nowrap; color:var(--muted); text-decoration:none; padding:8px 10px; border-radius:6px; font-size:11px; transition:background .2s,color .2s; }
    .story-nav a:hover,.story-nav a.active { color:var(--ink); background:var(--surface-2); }
    .story-section { padding:84px 0; border-bottom:1px solid var(--line); scroll-margin-top:58px; }
    .story-eyebrow { color:var(--cyan); font-size:11px; letter-spacing:.16em; text-transform:uppercase; margin-bottom:12px; }
    .story-section h2 { margin:0 0 12px; font-size:clamp(28px,4vw,48px); line-height:1; letter-spacing:-.055em; }
    .story-lede { color:var(--muted); max-width:760px; font-size:15px; margin:0 0 30px; }
    .story-panel { background:linear-gradient(145deg,#10202a,#0c161c); border:1px solid var(--line); border-radius:14px; padding:20px; }
    .story-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }
    .story-grid.three { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .story-panel h3 { margin:0 0 8px; font-size:14px; } .story-panel p { color:var(--muted); font-size:13px; margin:0; }
    .architecture { width:100%; min-height:330px; display:block; }
    .arch-node { fill:#112833; stroke:#3a6972; stroke-width:1.5; } .arch-node.final { fill:#173640; stroke:#68d8e8; }
    .arch-label { fill:var(--ink); font-size:13px; font-family:ui-monospace,monospace; } .arch-sub { fill:var(--muted); font-size:10px; font-family:ui-monospace,monospace; }
    .arch-edge { stroke:#3a6570; stroke-width:2; stroke-dasharray:7 9; animation:flow 2.2s linear infinite; } .arch-edge.hot { stroke:var(--cyan); }
    .architecture:hover .arch-edge { animation-duration:1.1s; }
    .story-statline { display:flex; justify-content:space-between; gap:18px; align-items:center; border-top:1px solid var(--line); margin-top:16px; padding-top:14px; color:var(--muted); font-size:12px; }
    .story-statline strong { color:var(--ink); font-size:14px; }
    .gantt { position:relative; display:grid; grid-template-columns:70px repeat(18,minmax(14px,1fr)); gap:3px; align-items:center; min-height:240px; overflow-x:auto; padding:16px 0; }
    .gantt-axis { color:var(--muted); font-size:10px; text-align:center; } .gantt-label { color:var(--muted); font-size:11px; }
    .task-rail { grid-column:2 / -1; display:grid; grid-template-columns:repeat(18,minmax(14px,1fr)); gap:3px; position:absolute; left:73px; right:0; height:100%; pointer-events:none; }
    .task-rail span { border-left:1px solid #27414b; }
    .task-button { min-width:0; border:1px solid #335b66; background:#173741; color:var(--ink); min-height:40px; border-radius:5px; cursor:pointer; transition:transform .18s, background .18s, box-shadow .18s; position:relative; z-index:1; }
    .task-button:hover,.task-button.selected { background:#24515d; transform:translateY(-3px); box-shadow:0 8px 20px #0007; } .task-button.revise { border-color:#96743b; background:#3a321f; }
    .task-button span { display:block; font-size:10px; color:var(--muted); } .task-button strong { font-size:13px; }
    .review-key { display:flex; gap:12px; flex-wrap:wrap; color:var(--muted); font-size:11px; margin-bottom:12px; } .review-dot { width:8px; height:8px; display:inline-block; border-radius:50%; margin-right:5px; background:var(--cyan); } .review-dot.revise { background:var(--amber); }
    .task-detail { min-height:170px; display:grid; grid-template-columns:110px 1fr; gap:18px; } .task-number { color:var(--cyan); font-size:42px; letter-spacing:-.08em; }
    .task-detail h3 { font-size:22px; margin:0 0 12px; } .task-detail dl { display:grid; grid-template-columns:100px 1fr; gap:8px; margin:0; font-size:12px; } .task-detail dt { color:var(--muted); } .task-detail dd { margin:0; }
    .funnel { display:grid; grid-template-columns:1fr 1fr; gap:24px; align-items:center; } .funnel svg { width:100%; min-height:310px; }
    .funnel-stage { fill:#18313a; stroke:#3d6b74; stroke-width:1; transition:fill .2s; } .funnel-stage:hover { fill:#23505a; } .funnel-text { fill:var(--ink); font:600 13px ui-monospace,monospace; } .funnel-small { fill:var(--muted); font:11px ui-monospace,monospace; }
    .trend-bars { display:flex; align-items:end; gap:12px; height:196px; padding:22px 8px 0; border-bottom:1px solid var(--line); } .trend-bar { flex:1; min-width:30px; background:linear-gradient(#69d8e8,#296675); border-radius:5px 5px 0 0; position:relative; animation:rise .9s ease-out both; } .trend-bar::after { content:attr(data-value); position:absolute; top:-21px; width:100%; text-align:center; color:var(--ink); font-size:11px; }
    .guard-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(260px,.75fr); gap:18px; } .guard-steps { display:flex; gap:7px; flex-wrap:wrap; margin-bottom:14px; }
    .guard-step { border:1px solid var(--line); color:var(--muted); background:#0a151b; padding:7px 9px; cursor:pointer; border-radius:5px; font-size:11px; } .guard-step.active { color:var(--ink); border-color:var(--cyan); background:#12343d; }
    .code-panel { background:#071015; border:1px solid #203a45; border-radius:8px; overflow:hidden; } .code-head { display:flex; justify-content:space-between; padding:9px 12px; color:var(--muted); border-bottom:1px solid #203a45; font-size:11px; } .code-panel pre { color:#b9d9df; margin:0; padding:18px; overflow:auto; font-size:12px; line-height:1.7; } .code-panel .bad { color:var(--amber); } .code-panel .good { color:var(--cyan); }
    .guard-result { padding:18px; border-radius:10px; background:#10202a; border:1px solid var(--line); } .guard-result strong { display:block; font-size:27px; margin-bottom:8px; } .guard-result.block strong { color:var(--cyan); } .guard-result.bypass strong { color:var(--amber); }
    .metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin:26px 0; } .story-metric { min-height:112px; padding:16px; border:1px solid var(--line); background:#0d1b22; border-radius:10px; display:flex; flex-direction:column; justify-content:space-between; } .story-metric strong { color:var(--cyan); font-size:clamp(23px,3vw,36px); letter-spacing:-.08em; white-space:nowrap; } .story-metric span { color:var(--muted); font-size:10px; }
    .release-timeline { display:flex; gap:0; overflow-x:auto; padding:18px 0; } .release { min-width:158px; padding:0 14px 13px; border-bottom:2px solid #315865; position:relative; } .release::before { content:""; position:absolute; bottom:-6px; left:14px; width:10px; height:10px; background:var(--cyan); border:2px solid var(--paper); border-radius:50%; } .release strong { display:block; font-size:12px; } .release span { display:block; color:var(--muted); font-size:10px; margin-top:8px; }
    .growth-chart { height:210px; display:flex; align-items:end; gap:28px; padding:20px 18px 0; border:1px solid var(--line); border-radius:10px; background:#0c181e; } .growth-column { flex:1; height:100%; display:flex; align-items:end; position:relative; } .growth-column span { display:block; width:100%; background:linear-gradient(180deg,#8ee6ef,#286170); border-radius:6px 6px 0 0; transition:height 1s cubic-bezier(.2,.8,.2,1); } .growth-column strong { position:absolute; bottom:calc(var(--height) + 7px); font-size:11px; color:var(--ink); } .growth-column small { position:absolute; bottom:-22px; color:var(--muted); font-size:10px; }
    .simulator { display:grid; grid-template-columns:.95fr 1.05fr; gap:18px; } .sim-controls { display:flex; flex-wrap:wrap; gap:8px; } .sim-controls button { cursor:pointer; border:1px solid var(--line); background:#10202a; color:var(--muted); border-radius:5px; padding:8px 10px; font-size:11px; } .sim-controls button.active { border-color:var(--cyan); color:var(--ink); background:#143944; } .sim-controls button:disabled { opacity:.45; cursor:not-allowed; }
    .tier-ladder { display:grid; gap:9px; margin-top:18px; } .tier-row { display:grid; grid-template-columns:52px 1fr auto; gap:10px; align-items:center; padding:11px; border:1px solid var(--line); border-radius:7px; color:var(--muted); font-size:12px; transition:background .35s,border-color .35s,color .35s,transform .35s; } .tier-row.active { border-color:var(--cyan); background:#10323a; color:var(--ink); transform:translateX(5px); } .tier-row.done { border-color:#39706c; color:#bdebf0; } .tier-index { color:var(--cyan); } .sim-result { min-height:258px; display:flex; flex-direction:column; justify-content:center; text-align:center; background:radial-gradient(circle,#153742,#0b161c 62%); } .sim-result .verdict { font-size:clamp(25px,4vw,46px); letter-spacing:-.07em; color:var(--cyan); margin:12px 0; } .sim-result.partial .verdict { color:var(--amber); } .sim-result.bad .verdict { color:var(--red); }
    .verdict-list { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; margin-top:18px; } .verdict-list div { padding:9px; border:1px solid var(--line); border-radius:6px; background:#0c181e; min-width:0; } .verdict-list strong { display:block; color:var(--ink); font-size:10px; overflow-wrap:anywhere; } .verdict-list span { color:var(--muted); font-size:9px; display:block; margin-top:5px; }
    .story-footer { padding-top:28px; color:var(--muted); font-size:11px; display:flex; justify-content:space-between; gap:12px; }
    @keyframes flow { to { stroke-dashoffset:-32; } } @keyframes scan { to { transform:translateX(100%); } } @keyframes beat { 50% { transform:translateY(-10px); opacity:.55; } } @keyframes rise { from { transform:scaleY(.05); transform-origin:bottom; } to { transform:scaleY(1); transform-origin:bottom; } }
    @media (max-width:800px) { .story-shell { padding:18px 16px 64px; } .story-hero,.story-grid,.story-grid.three,.funnel,.guard-grid,.simulator { grid-template-columns:1fr; } .story-hero { min-height:auto; padding:72px 0; } .story-nav { margin:0 -16px; padding-left:16px; padding-right:16px; } .metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } .verdict-list { grid-template-columns:repeat(2,minmax(0,1fr)); } .story-section { padding:56px 0; } }
    @media (prefers-reduced-motion:reduce) { *,*::before,*::after { animation-duration:.01ms !important; animation-iteration-count:1 !important; scroll-behavior:auto !important; transition-duration:.01ms !important; } }
  `}</style>
  );
}

export default function FacetStory() {
  const nodes = useRef<Array<HTMLElement | null>>([]);
  const [active, setActive] = useState("origin");
  const [selectedTask, setSelectedTask] = useState(0);
  const [guard, setGuard] = useState(0);
  const [artifactType, setArtifactType] = useState<ArtifactType>("tsx");
  const [signal, setSignal] = useState<Signal>("normal");
  const [runStep, setRunStep] = useState(-1);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const nearest = entries
          .filter((entry) => entry.isIntersecting)
          .toSorted((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (nearest?.target.id) setActive(nearest.target.id);
      },
      { rootMargin: "-24% 0px -62% 0px", threshold: [0.1, 0.3, 0.6] },
    );
    nodes.current.forEach((node) => node && observer.observe(node));
    return () => observer.disconnect();
  }, []);

  const task = taskData[selectedTask];
  const guardCases = [
    [
      "gen 1",
      "import(specifier)",
      "dynamic import admitted a template literal",
      "BYPASS",
      "bypass",
    ],
    ["gen 2", "import(`react`)", "template-literal bypass found by swarm", "BLOCKED", "block"],
    [
      "gen 3",
      "import(\n  `react`\n)",
      "multiline bypass found by reviewer of the fix",
      "BLOCKED",
      "block",
    ],
    [
      "current",
      "const target = someRuntimeValue;\nimport(target)",
      "whole-file scan fails closed on unclassifiable dynamics",
      "BLOCKED",
      "block",
    ],
  ] as const;
  const guardCase = guardCases[guard];
  const normalVerdict: Record<ArtifactType, string> = {
    markdown: "ok",
    mermaid: "partial:layout_unverified",
    svg: "ok",
    chart: "partial:opaque_content",
    html: "partial:external_resources",
    tsx: "partial:unstable",
  };
  const result =
    signal === "barrier"
      ? "timeout"
      : signal === "divergence"
        ? "tampered"
        : normalVerdict[artifactType];
  const resultClass =
    result === "timeout" || result === "tampered"
      ? "bad"
      : result.startsWith("partial")
        ? "partial"
        : "";

  const runSimulation = () => {
    setRunStep(0);
    [1, 2, 3].forEach((step, index) => setTimeout(() => setRunStep(step), (index + 1) * 560));
    setTimeout(() => setRunStep(4), 2430);
  };

  return (
    <main className="facet-story">
      <StoryStyles />
      <div className="story-shell">
        <header className="story-hero">
          <div>
            <div className="story-kicker">Facet / development story / interactive TSX</div>
            <h1>Evidence is the product.</h1>
            <p>
              Facet stores bytes, tests render claims at independent boundaries, and refuses to call
              an artifact verified when the evidence cannot support it.
            </p>
            <div className="story-badges">
              <span className="story-badge good">✓ byte-dumb service</span>
              <span className="story-badge">six artifact types</span>
              <span className="story-badge">T0 → T1 → human browser</span>
              <span className="story-badge">no network</span>
            </div>
          </div>
          <aside className="story-signal" aria-label="Facet evidence stream">
            <div className="story-signal-top">
              <span>REVISION / OBSERVATION</span>
              <span>LIVE</span>
            </div>
            <div className="story-signal-grid">
              {Array.from({ length: 24 }, (_, index) => (
                <span key={index} />
              ))}
            </div>
            <strong>render claims meet evidence</strong>
            <small>Source remains immutable · verdict is revision-bound</small>
          </aside>
        </header>

        <nav className="story-nav" aria-label="Story sections">
          {sections.map(([id, label]) => (
            <a key={id} className={active === id ? "active" : ""} href={`#${id}`}>
              {label}
            </a>
          ))}
        </nav>

        <section
          className="story-section"
          id="origin"
          ref={(node) => {
            nodes.current[0] = node;
          }}
        >
          <div className="story-eyebrow">01 / what Facet is</div>
          <h2>Bytes in. Evidence out.</h2>
          <p className="story-lede">
            The service may hash, store, count lexically, and serve bytes. Parsers and renderers
            stay on the validation boundary, where a claim can be tested rather than merely
            repeated.
          </p>
          <div className="story-panel">
            <svg
              className="architecture"
              viewBox="0 0 960 330"
              role="img"
              aria-label="Facet validation architecture with animated flows"
            >
              <defs>
                <marker
                  id="story-arrow"
                  markerWidth="8"
                  markerHeight="8"
                  refX="7"
                  refY="4"
                  orient="auto"
                >
                  <path d="M0,0 L8,4 L0,8z" fill="#68d8e8" />
                </marker>
              </defs>
              {[
                [180, 115, 300, 115],
                [430, 115, 550, 115],
                [680, 115, 800, 115],
                [300, 225, 550, 225],
                [680, 225, 800, 150],
              ].map(([x1, y1, x2, y2], index) => (
                <line
                  key={index}
                  className={`arch-edge ${index === 3 ? "" : "hot"}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  markerEnd="url(#story-arrow)"
                />
              ))}
              <g>
                <rect className="arch-node" x="30" y="80" rx="10" width="150" height="74" />
                <text className="arch-label" x="50" y="111">
                  source bytes
                </text>
                <text className="arch-sub" x="50" y="133">
                  six artifact types
                </text>
              </g>
              <g>
                <rect className="arch-node" x="300" y="80" rx="10" width="130" height="74" />
                <text className="arch-label" x="320" y="111">
                  hash / store
                </text>
                <text className="arch-sub" x="320" y="133">
                  immutable revision
                </text>
              </g>
              <g>
                <rect className="arch-node" x="550" y="80" rx="10" width="130" height="74" />
                <text className="arch-label" x="570" y="111">
                  T0 / netns
                </text>
                <text className="arch-sub" x="570" y="133">
                  parse + policy
                </text>
              </g>
              <g>
                <rect className="arch-node" x="550" y="190" rx="10" width="130" height="74" />
                <text className="arch-label" x="570" y="221">
                  T1 / shell
                </text>
                <text className="arch-sub" x="570" y="243">
                  protocol probes
                </text>
              </g>
              <g>
                <rect className="arch-node final" x="800" y="80" rx="10" width="130" height="74" />
                <text className="arch-label" x="820" y="111">
                  gallery
                </text>
                <text className="arch-sub" x="820" y="133">
                  human browser
                </text>
              </g>
              <text className="arch-sub" x="300" y="214">
                Tier 0 predicts from bytes
              </text>
              <text className="arch-sub" x="300" y="231">
                Tier 1 observes rendered structure
              </text>
            </svg>
            <div className="story-statline">
              <span>Validation is layered by authority, not decoration.</span>
              <strong>unfakeable render verdicts</strong>
            </div>
          </div>
          <div className="story-grid three" style={{ marginTop: 18 }}>
            <article className="story-panel">
              <h3>T0 / constrained parse</h3>
              <p>Policy and lexical expectation run in a no-egress worker.</p>
            </article>
            <article className="story-panel">
              <h3>T1 / protocol authority</h3>
              <p>Pinned headless shell observes independent DOM structure.</p>
            </article>
            <article className="story-panel">
              <h3>T2 / human view</h3>
              <p>Gallery display is useful, but never substitutes for a verifier.</p>
            </article>
          </div>
        </section>

        <section
          className="story-section"
          id="build"
          ref={(node) => {
            nodes.current[1] = node;
          }}
        >
          <div className="story-eyebrow">02 / the build</div>
          <h2>18 tasks. Different eyes on every seam.</h2>
          <p className="story-lede">
            Legion distributed implementation across M3, Qwen, Kimi-K3, GPT-5.6 sol/luna/terra, and
            Sonnet. Every task received adversarial review from a different model family; fix rounds
            resumed the same session.
          </p>
          <div className="story-panel">
            <div className="review-key">
              <span>
                <i className="review-dot" />
                reviewed without a recorded fix round
              </span>
              <span>
                <i className="review-dot revise" />
                review surfaced a contract fix
              </span>
              <span>click any task for its seam</span>
            </div>
            <div className="gantt" aria-label="18 task development timeline">
              <div className="task-rail">
                {Array.from({ length: 18 }, (_, index) => (
                  <span key={index} />
                ))}
              </div>
              <div className="gantt-label">task</div>
              {taskData.map(([number], index) => (
                <button
                  key={number}
                  type="button"
                  className={`task-button ${index % 3 === 1 ? "revise" : ""} ${selectedTask === index ? "selected" : ""}`}
                  onClick={() => setSelectedTask(index)}
                  title={`Task ${number}: ${taskData[index][1]}`}
                >
                  <strong>{number}</strong>
                  <span>{index % 3 === 1 ? "REVISE" : "APPROVE"}</span>
                </button>
              ))}
              <div className="gantt-label">flow</div>
              {taskData.map(([number], index) => (
                <div key={`axis-${number}`} className="gantt-axis">
                  {index + 1}
                </div>
              ))}
            </div>
          </div>
          <article className="story-panel task-detail" style={{ marginTop: 18 }}>
            <div className="task-number">{task[0]}</div>
            <div>
              <div className="story-eyebrow">selected task / {task[1]}</div>
              <h3>{task[2]}</h3>
              <dl>
                <dt>review caught</dt>
                <dd>{task[3]}</dd>
                <dt>review mode</dt>
                <dd>
                  {selectedTask % 3 === 1
                    ? "REVISE → same-session fix round"
                    : "APPROVE → independent family review"}
                </dd>
                <dt>collective</dt>
                <dd>implementation and review never share the same model family</dd>
              </dl>
            </div>
          </article>
        </section>

        <section
          className="story-section"
          id="defense"
          ref={(node) => {
            nodes.current[2] = node;
          }}
        >
          <div className="story-eyebrow">03 / defense in depth</div>
          <h2>Defects should meet the cheapest honest gate.</h2>
          <p className="story-lede">
            Tests catch local behavior; cross-family review catches assumptions; drift passes catch
            repeated shape errors; swarm audits question the whole surface.
          </p>
          <div className="story-panel funnel">
            <svg viewBox="0 0 430 310" role="img" aria-label="Review funnel">
              <path className="funnel-stage" d="M20 24H410L357 85H73Z" />
              <text className="funnel-text" x="44" y="53">
                unit / integration / acceptance
              </text>
              <text className="funnel-small" x="310" y="53">
                1125 tests
              </text>
              <path className="funnel-stage" d="M73 101H357L315 162H115Z" />
              <text className="funnel-text" x="130" y="132">
                cross-family review
              </text>
              <text className="funnel-small" x="260" y="150">
                every task
              </text>
              <path className="funnel-stage" d="M115 178H315L278 239H152Z" />
              <text className="funnel-text" x="168" y="209">
                drift passes
              </text>
              <text className="funnel-small" x="189" y="226">
                0 → 8 → 1
              </text>
              <path className="funnel-stage" d="M152 255H278L250 294H180Z" />
              <text className="funnel-text" x="186" y="279">
                swarm
              </text>
            </svg>
            <div>
              <h3>Audit that keeps its rejects</h3>
              <p>
                Latest swarm: 8 luna platforms with a terra prime. 12 raw findings became 9 kept
                findings, including 1 P1; 3 were dropped with refutations.
              </p>
              <div className="trend-bars" aria-label="Drift findings trend">
                {[0, 8, 1, 2, 2].map((value, index) => (
                  <div
                    key={index}
                    className="trend-bar"
                    style={{ height: `${value === 0 ? 5 : value * 19}%` }}
                    data-value={value}
                    title={`drift pass ${index + 1}: ${value} valid findings`}
                  />
                ))}
              </div>
              <div className="story-statline">
                <span>drift findings / pass</span>
                <strong>0 → 8 → 1 → 2 → 2</strong>
              </div>
            </div>
          </div>
        </section>

        <section
          className="story-section"
          id="guards"
          ref={(node) => {
            nodes.current[3] = node;
          }}
        >
          <div className="story-eyebrow">04 / guard evolution</div>
          <h2>A scanner that can be bypassed is a story, not a boundary.</h2>
          <p className="story-lede">
            The boundary scanner progressed from denylist to allowlist, then survived two
            adversarial bypasses. The current rule scans the whole file and fails closed when
            dynamics cannot be classified.
          </p>
          <div className="guard-grid">
            <article className="story-panel">
              <div className="guard-steps">
                {guardCases.map(([name], index) => (
                  <button
                    className={`guard-step ${guard === index ? "active" : ""}`}
                    type="button"
                    key={name}
                    onClick={() => setGuard(index)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <div className="code-panel">
                <div className="code-head">
                  <span>boundary-scanner.tsx</span>
                  <span>{guardCase[0]}</span>
                </div>
                <pre>
                  <span className="bad">{guardCase[1]}</span>
                  {"\n\n"}
                  <span className="good">
                    {guardCase[4] === "block"
                      ? "→ statically denied before compilation"
                      : "→ admitted by the first guard"}
                  </span>
                </pre>
              </div>
            </article>
            <aside className={`guard-result ${guardCase[4]}`}>
              <span className="story-eyebrow">{guardCase[0]} / verdict</span>
              <strong>{guardCase[3]}</strong>
              <p>{guardCase[2]}</p>
            </aside>
          </div>
        </section>

        <section
          className="story-section"
          id="shipping"
          ref={(node) => {
            nodes.current[4] = node;
          }}
        >
          <div className="story-eyebrow">05 / shipping cadence</div>
          <h2>Measured paths. Explicit budgets.</h2>
          <p className="story-lede">
            Facet measures a publish path rather than wishing it were fast. Browser work is
            isolated, evidence is retained, and CI uses process boundaries where the runtime
            requires them.
          </p>
          <div className="metrics">
            <Metric label="publish → visible budget" value={300} suffix=" ms" />
            <Metric label="T0 warm p95" value={0.25} suffix=" ms" decimals={2} />
            <Metric label="browser exit" value={83} suffix=" ms" />
            <Metric label="RSS delta" value={23.6} suffix=" MiB" decimals={1} />
          </div>
          <div className="story-grid">
            <article className="story-panel">
              <h3>Release line / v1.0.0 → v1.6.0</h3>
              <div className="release-timeline">
                {releases.map(([version, theme]) => (
                  <div className="release" key={version}>
                    <strong>{version}</strong>
                    <span>{theme}</span>
                  </div>
                ))}
              </div>
            </article>
            <article className="story-panel">
              <h3>Test count growth</h3>
              <div className="growth-chart">
                <div className="growth-column" style={{ "--height": "43%" } as CSSProperties}>
                  <strong>486</strong>
                  <span style={{ height: "43%" }} />
                  <small>early</small>
                </div>
                <div className="growth-column" style={{ "--height": "100%" } as CSSProperties}>
                  <strong>1125</strong>
                  <span style={{ height: "100%" }} />
                  <small>today</small>
                </div>
              </div>
              <div className="story-statline">
                <span>CI matrix</span>
                <strong>50 jobs · 45+ legs · CDP shard per file</strong>
              </div>
            </article>
          </div>
          <div className="story-panel" style={{ marginTop: 18 }}>
            <h3>Why the process boundary exists</h3>
            <p>
              Tier 1 acceptance uses one file per browser process because the upstream Bun #37230
              CDP behavior makes repeated launches unreliable. The workaround is explicit, tested,
              and bounded.
            </p>
          </div>
        </section>

        <section
          className="story-section"
          id="live"
          ref={(node) => {
            nodes.current[5] = node;
          }}
        >
          <div className="story-eyebrow">06 / live reactivity demo</div>
          <h2>Drive a publish through the verdict ladder.</h2>
          <p className="story-lede">
            This artifact is interactive TSX. Pick the input shape and an observation condition,
            then run the same precedence lesson the verifier applies: timeout and channel divergence
            outrank single-snapshot claims.
          </p>
          <div className="simulator">
            <article className="story-panel">
              <h3>1. Artifact type</h3>
              <div className="sim-controls">
                {(["markdown", "mermaid", "svg", "chart", "html", "tsx"] as ArtifactType[]).map(
                  (type) => (
                    <button
                      key={type}
                      type="button"
                      className={artifactType === type ? "active" : ""}
                      onClick={() => setArtifactType(type)}
                    >
                      {type}
                    </button>
                  ),
                )}
              </div>
              <h3 style={{ marginTop: 22 }}>2. Observation condition</h3>
              <div className="sim-controls">
                {(
                  [
                    ["normal", "normal observation"],
                    ["divergence", "channel divergence"],
                    ["barrier", "missing barrier"],
                  ] as const
                ).map(([next, label]) => (
                  <button
                    key={next}
                    type="button"
                    className={signal === next ? "active" : ""}
                    onClick={() => setSignal(next)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="guard-step active"
                style={{ marginTop: 22 }}
                onClick={runSimulation}
                disabled={runStep >= 0 && runStep < 4}
              >
                {runStep >= 0 && runStep < 4 ? "running evidence path…" : "simulate publish →"}
              </button>
              <div className="tier-ladder">
                {[
                  ["T0", "policy + expectation"],
                  ["T1", "protocol observation"],
                  ["stable", "bounded re-check"],
                  ["verdict", "precedence resolution"],
                ].map(([name, label], index) => (
                  <div
                    key={name}
                    className={`tier-row ${runStep === index ? "active" : ""} ${runStep > index ? "done" : ""}`}
                  >
                    <span className="tier-index">{String(index + 1).padStart(2, "0")}</span>
                    <span>
                      {name} / {label}
                    </span>
                    <span>{runStep > index ? "✓" : runStep === index ? "→" : "·"}</span>
                  </div>
                ))}
              </div>
            </article>
            <aside className={`story-panel sim-result ${resultClass}`}>
              <span className="story-eyebrow">simulated render status</span>
              <div className="verdict">{runStep === 4 ? result : "awaiting run"}</div>
              <p>
                {runStep === 4
                  ? signal === "barrier"
                    ? "The lifecycle failed at the render barrier."
                    : signal === "divergence"
                      ? "Protocol authority contradicts the page channel."
                      : `${artifactType} resolves to ${result} under this observation.`
                  : "Run the tier ladder to produce a revision-bound verdict."}
              </p>
              <div className="story-badges" style={{ justifyContent: "center" }}>
                <span className="story-badge">closed enum</span>
                <span className="story-badge">evidence before claim</span>
              </div>
            </aside>
          </div>
          <div className="verdict-list" aria-label="Render status taxonomy">
            {verdicts.map(([name, description]) => (
              <div key={name}>
                <strong>{name}</strong>
                <span>{description}</span>
              </div>
            ))}
          </div>
        </section>
        <footer className="story-footer">
          <span>Facet story · interactive TSX · no external assets</span>
          <span>native scroll · reduced motion respected</span>
        </footer>
      </div>
    </main>
  );
}
