import type { StepAction } from "@/lib/types";

// Small animated vignettes for what the agent is doing right now. Each one shows the *kind*
// of step that is actually running (searching, reading, writing, …), never progress or
// results, so it can't misstate anything. Pure SVG + CSS; still under reduced motion.

const TINTS: Record<string, string> = {
  gmail: "text-[#c5432f]",
  outlook: "text-[#2f6cc5]",
  sheets: "text-[#2f7a4c]",
  docs: "text-[#3a64a8]",
  drive: "text-[#b0862a]",
  calendar: "text-[#3a64a8]",
  shopify: "text-[#5e8e3e]",
  granola: "text-[#4f7a3a]",
  web: "text-[#3a64a8]",
  browser: "text-[#3a7a8a]",
  memory: "text-accent",
  quickbooks: "text-[#2f7a4c]",
  stripe: "text-[#5b4fc4]",
  slack: "text-[#7a3f7a]",
};

type Scene = "search" | "read" | "grid" | "write" | "run" | "remember" | "browse" | "connect" | "think";

function sceneFor(action: StepAction | undefined, app: string | undefined): Scene {
  switch (action) {
    case "search":
      return "search";
    case "read":
      return "read";
    case "write":
      return app === "sheets" ? "grid" : "write";
    case "run":
      return "run";
    case "remember":
      return "remember";
    case "browse":
      return "browse";
    case "connect":
      return "connect";
    default:
      return app === "code" ? "run" : app === "memory" ? "remember" : app === "browser" ? "browse" : "think";
  }
}

export function WorkAnimation({ action, app }: { action?: StepAction; app?: string }) {
  const scene = sceneFor(action, app);
  const tint = (app && TINTS[app]) || "text-fg-3";
  return (
    <span key={scene} aria-hidden="true" className={`wa inline-flex h-5 w-7 shrink-0 items-center justify-center animate-fade-in ${tint}`}>
      <svg viewBox="0 0 28 20" width="28" height="20" fill="none">
        {SCENES[scene]}
      </svg>
    </span>
  );
}

const line = (y: number, w: number, extra = "") => <rect x="3" y={y} width={w} height="2" rx="1" className={`fill-current opacity-25 ${extra}`} />;

const SCENES: Record<Scene, React.ReactNode> = {
  // A magnifier sweeping across lines of text.
  search: (
    <>
      {line(5, 20)}
      {line(9, 16)}
      {line(13, 18)}
      <g className="wa-sweep">
        <circle cx="8" cy="9" r="4" className="stroke-current" strokeWidth="1.6" />
        <path d="M11 12l3 3" className="stroke-current" strokeWidth="1.6" strokeLinecap="round" />
      </g>
    </>
  ),
  // A stack of cards; the top one slides off to be read.
  read: (
    <>
      <rect x="7" y="6" width="14" height="10" rx="2" className="fill-current opacity-20" />
      <rect x="5" y="4" width="14" height="10" rx="2" className="fill-current opacity-35" />
      <g className="wa-deal">
        <rect x="3" y="2" width="14" height="10" rx="2" className="fill-bg stroke-current" strokeWidth="1.4" />
        <path d="M6 6h8M6 9h5" className="stroke-current" strokeWidth="1.2" strokeLinecap="round" />
      </g>
    </>
  ),
  // Spreadsheet cells filling in, one after another.
  grid: (
    <>
      {[0, 1, 2].flatMap((r) =>
        [0, 1, 2, 3].map((c) => (
          <rect
            key={`${r}-${c}`}
            x={3 + c * 6}
            y={3 + r * 5}
            width="5"
            height="4"
            rx="0.8"
            className="wa-cell fill-current"
            style={{ animationDelay: `${(r * 4 + c) * 0.12}s` }}
          />
        )),
      )}
    </>
  ),
  // Lines being written out.
  write: (
    <>
      {[5, 9, 13].map((y, i) => (
        <rect key={y} x="3" y={y} width={[20, 15, 18][i]} height="2" rx="1" className="wa-ink fill-current" style={{ animationDelay: `${i * 0.35}s` }} />
      ))}
    </>
  ),
  // Little chart bars rising and falling.
  run: (
    <>
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={i} x={4 + i * 4.4} y="3" width="2.6" height="14" rx="1.2" className="wa-bar fill-current" style={{ animationDelay: `${i * 0.13}s` }} />
      ))}
    </>
  ),
  // A notebook with a bookmark dropping in.
  remember: (
    <>
      <rect x="6" y="2" width="16" height="16" rx="2" className="stroke-current opacity-60" strokeWidth="1.4" />
      <path d="M10 7h8M10 10h6M10 13h7" className="stroke-current opacity-40" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M17 2v6l1.6-1.4L20 8V2z" className="wa-drop fill-current" />
    </>
  ),
  // A browser window loading a page.
  browse: (
    <>
      <rect x="3" y="2" width="22" height="16" rx="2.5" className="stroke-current opacity-60" strokeWidth="1.4" />
      <path d="M3 6h22" className="stroke-current opacity-40" strokeWidth="1.2" />
      <rect x="5" y="9" width="18" height="2" rx="1" className="fill-current opacity-15" />
      <rect x="5" y="9" width="18" height="2" rx="1" className="wa-load fill-current" />
      {line(13, 12, "translate-x-[2px]")}
    </>
  ),
  // Two dots linking up.
  connect: (
    <>
      <circle cx="6" cy="10" r="3" className="fill-current opacity-70" />
      <circle cx="22" cy="10" r="3" className="fill-current opacity-70" />
      <path d="M9 10h10" className="wa-link stroke-current" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="2 2.5" />
    </>
  ),
  // Deciding what to do next.
  think: (
    <>
      {[0, 1, 2].map((i) => (
        <circle key={i} cx={8 + i * 6} cy="10" r="2" className="wa-dot fill-current" style={{ animationDelay: `${i * 0.16}s` }} />
      ))}
    </>
  ),
};
