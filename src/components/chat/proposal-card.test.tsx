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

function render(proposal: AgentProposal, { response, mine = companion, canApply = !response }: { response?: UiResponse; mine?: Companion; canApply?: boolean } = {}) {
  return renderToStaticMarkup(
    <CompanionContext.Provider value={mine}>
      <VoicePreviews voice={MOCK_VOICE}>
        <ProposalCard proposal={proposal} response={response} canApply={canApply} onApply={async () => undefined} />
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
});
