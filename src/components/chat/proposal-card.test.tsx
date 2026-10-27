import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompanionContext } from "@/components/ui/companion";
import { VoicePreviews } from "@/components/voice/voice-preview";
import type { AgentProposal, Companion, UiResponse } from "@/lib/types";
import type { VoiceStatus } from "@/lib/voice/types";
import { ProposalCard } from "./ui-cards";

// The proposal card shows only what took effect: one manner (the one stored, or the one that
// would be), and wherever a voice can be played, the note that labels the mock.

const MOCK_VOICE: VoiceStatus = { provider: "mock", label: "Mock voice", live: false, speech: { tts: true, stt: true } };
const companion: Companion = { workspaceId: "ws", stage: "ready", name: null, manner: null, voice: null, look: { shape: "classic", tint: "chart-1", seed: 1 } };
const base: AgentProposal = { kind: "proposal", id: "p1", summary: "How I'd work.", skills: [], tasks: [], memories: [] };
const named = { ...base, identity: { name: "Wren", manner: "I'm brief." } };
const both = { ...named, sound: [{ voice: "warm" as const, manner: "I take it slowly." }] };
const none = { profile: false, instructions: false, skills: [], tasks: [], memories: [] };

function applied(picks: Partial<Extract<UiResponse, { status: "applied" }>["picks"]>, extra: Partial<Extract<UiResponse, { status: "applied" }>["applied"]>): UiResponse {
  return { status: "applied", at: 1, picks: { ...none, ...picks }, applied: { settings: false, skills: 0, tasks: 0, memories: 0, skipped: 0, ...extra } };
}

function render(
  proposal: AgentProposal,
  { response, mine = companion, canApply = !response, runs = false, fix = false }: { response?: UiResponse; mine?: Companion; canApply?: boolean; runs?: boolean; fix?: boolean } = {},
) {
  const run = { ...(runs ? { onRunTask: async () => undefined, onFirstRun: async () => undefined } : {}), ...(fix ? { onFix: () => undefined } : {}) };
  return renderToStaticMarkup(
    <CompanionContext.Provider value={mine}>
      <VoicePreviews voice={MOCK_VOICE}>
        <ProposalCard proposal={proposal} response={response} canApply={canApply} onApply={async () => undefined} {...run} />
      </VoicePreviews>
    </CompanionContext.Provider>,
  );
}

describe("ProposalCard", () => {
  it("shows the picked option's manner, not the one offered with the name it replaced", () => {
    const html = render(both, { response: applied({ identity: true, sound: 0 }, { name: "Wren", voice: "warm", manner: "I take it slowly." }) });
    expect(html).toContain("You call me");
    expect(html).toContain("I take it slowly.");
    expect(html).not.toContain("I&#x27;m brief.");
  });

  it("shows the manner the server kept with a name, and the offered one only on cards applied before it was reported", () => {
    const kept = render(named, { response: applied({ identity: true }, { name: "Wren", manner: "I lead with what I found." }) });
    expect(kept).toContain("I lead with what I found.");
    expect(kept).not.toContain("I&#x27;m brief.");
    expect(render(named, { response: applied({ identity: true }, { name: "Wren", manner: null }) })).not.toContain("I&#x27;m brief.");
    expect(render(named, { response: applied({ identity: true }, { name: "Wren" }) })).toContain("I&#x27;m brief.");
  });

  it("before it's kept, shows the manner they already have, which keeping a name doesn't replace", () => {
    expect(render(named, { mine: { ...companion, manner: "I take it slowly." } })).toContain("I take it slowly.");
    expect(render(named, { mine: { ...companion, manner: "I take it slowly." } })).not.toContain("I&#x27;m brief.");
    expect(render(named)).toContain("I&#x27;m brief.");
  });

  it("labels the mock wherever a voice can be played, applied or not", () => {
    const label = "Mock voice: previews play a short tone, not a voice.";
    expect(render(both)).toContain(label);
    expect(render(both, { response: applied({ sound: 0 }, { voice: "warm", manner: "I take it slowly." }) })).toContain(label);
    expect(render(both, { canApply: false })).toContain(label);
  });

  it("offers the first task now or later, and shows what the member chose", () => {
    const tasked = { ...base, tasks: [{ title: "Summarize a video", instructions: "Do it.", schedule: null }] };
    const ran = (firstRun?: "started" | "later") => ({ ...applied({ tasks: [0] }, { tasks: 1 }), taskIds: ["t1"], ...(firstRun ? { firstRun } : {}) }) as UiResponse;
    const open = render(tasked, { response: ran(), runs: true });
    expect(open).toContain("Do the first one now");
    expect(open).toContain("Not now");
    const later = render(tasked, { response: ran("later"), runs: true });
    expect(later).toContain("All set.");
    expect(later).not.toContain("Do the first one now");
    const started = render(tasked, { response: ran("started"), runs: true });
    expect(started).toContain("Started. It&#x27;s running in its own chat.");
    expect(started).not.toContain("Not now");
  });

  it("shows a new skill to read and its guesses to fix, as a suggested skill", () => {
    const taught: AgentProposal = {
      ...base,
      summary: "A skill for what you showed me.",
      skills: [{ name: "Reorder the beans", description: "When we're low.", instructions: "1. Open the shop.\n2. Pick the 5 lb bag." }],
      assumptions: ["I assumed you always want the 5 lb bag."],
    };
    const html = render(taught, { fix: true });
    expect(html).toContain("Suggested skill");
    expect(html).toContain("2. Pick the 5 lb bag.");
    expect(html).toContain("My guesses");
    expect(html).toContain("Not quite");
    // Without a way to send fixes (an older reply), the guesses are only shown.
    const old = render(taught, { canApply: false });
    expect(old).toContain("I assumed you always want the 5 lb bag.");
    expect(old).not.toContain("Not quite");
    expect(render(taught, { response: applied({ skills: [0] }, { skills: 1 }) })).toContain("Added skill");
  });

  it("lists each item on one line, its guesses first, and folds the items away once applied", () => {
    const full: AgentProposal = {
      ...base,
      profile: "Tracks the market.",
      tasks: [{ title: "Weekly brief", instructions: "Read the week's news and summarize it.", schedule: null }],
      skills: [{ name: "Teardown", description: "One competitor.", instructions: "Compare features." }],
      memories: ["Prefers short answers."],
      assumptions: ["I assumed weekly is enough."],
    };
    const html = render(full, { fix: true });
    expect(html).toContain("Weekly brief");
    expect(html).toContain("When you ask");
    // Details open on a tap, not up front.
    expect(html).not.toContain("Read the week&#x27;s news");
    expect(html).not.toContain("Compare features.");
    expect(html.indexOf("My guesses")).toBeLessThan(html.indexOf("Weekly brief"));

    const done = render(full, { response: applied({ profile: true, tasks: [0], skills: [0], memories: [0] }, { settings: true, tasks: 1, skills: 1, memories: 1 }) });
    expect(done).toContain("Applied setup");
    expect(done).toContain("Show details (4)");
    expect(done).not.toContain("Weekly brief");
    expect(done).not.toContain("My guesses");
  });
});
