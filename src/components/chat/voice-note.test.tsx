import { Tooltip } from "radix-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VoicePlayer } from "@/components/voice/player";
import type { ChatMessage } from "@/lib/types";
import type { VoiceStatus } from "@/lib/voice/types";
import { AssistantMessage, UserMessage } from "./message";
import { pointOutNote } from "./voice-note";

// A voice note is a tap to play with its words always on screen: under it (the reply) or as its
// caption (a run's report). The mock's tone is labeled, and a voice message says it was spoken.

const MOCK_VOICE: VoiceStatus = { provider: "mock", label: "Mock voice", live: false, speech: { tts: true, stt: true } };
const LIVE_VOICE: VoiceStatus = { provider: "elevenlabs", label: "ElevenLabs", live: true, speech: { tts: true, stt: true } };

const reply = (patch: Partial<ChatMessage>): ChatMessage => ({
  id: "6f1c1d1e-0000-4000-8000-000000000001",
  conversationId: "c1",
  role: "assistant",
  content: "Found three roles. The best is remote.",
  status: "complete",
  activity: [],
  artifacts: [],
  createdAt: 0,
  ...patch,
});

function render(message: ChatMessage, voice: VoiceStatus | null = MOCK_VOICE) {
  return renderToStaticMarkup(
    <Tooltip.Provider>
      <VoicePlayer voice={voice}>
        <AssistantMessage message={message} isLast onRetry={() => undefined} />
      </VoicePlayer>
    </Tooltip.Provider>,
  );
}

describe("a voice note", () => {
  it("plays from a tap above the reply, which stays as its text", () => {
    const html = render(reply({ voiceNote: { script: "Found three roles. The best is remote.", source: "reply" } }));
    expect(html).toContain("Play the voice note");
    expect(html).toContain("Voice note");
    expect(html.indexOf("Voice note")).toBeLessThan(html.indexOf("Found three roles"));
    // Said once on screen: the reply is the note's text.
    expect(html.match(/Found three roles/g)).toHaveLength(1);
    expect(html).toContain("Mock voice: plays a short tone, not a voice.");
    expect(render(reply({ voiceNote: { script: "Hi.", source: "reply" } }), LIVE_VOICE)).not.toContain("Mock voice");
  });

  it("shows a run's report as its caption, since the reply says more", () => {
    const html = render(reply({ content: "## Roles\n\n- Acme\n- Globex", voiceNote: { script: "Two roles cleared your bar.", source: "summary" } }));
    expect(html).toContain("Two roles cleared your bar.");
    expect(html).toContain("Acme");
  });

  it("isn't offered without voice, before the reply is saved, or before it's finished", () => {
    const note = { script: "Hi.", source: "reply" as const };
    expect(render(reply({ voiceNote: note }), null)).not.toContain("voice note");
    expect(render(reply({ id: "pending-assistant-1", voiceNote: note }))).not.toContain("voice note");
    expect(render(reply({ status: "streaming", voiceNote: note }))).not.toContain("voice note");
    expect(render(reply({}))).not.toContain("voice note");
  });
});

describe("a voice note a notification opened", () => {
  it("is brought into view with focus on its play button, so the keyboard and screen readers land on it, and never played", () => {
    const calls: string[] = [];
    const button = {
      scrollIntoView: (options: ScrollIntoViewOptions) => calls.push(`scroll:${options.block}`),
      focus: (options: FocusOptions) => calls.push(`focus:${options.preventScroll}`),
      click: () => calls.push("click"),
    };
    const page = { getElementById: (id: string) => (id === "voice-note-m1" ? (button as unknown as HTMLElement) : null) };
    expect(pointOutNote("m1", page)).toBe(true);
    expect(calls).toEqual(["scroll:center", "focus:true"]);
    expect(pointOutNote("m2", page)).toBe(false);
  });
});

describe("a voice message", () => {
  it("is labeled as spoken, apart from words said on a call", () => {
    const said = (origin: ChatMessage["origin"]) => renderToStaticMarkup(<UserMessage message={reply({ role: "user", content: "Find me roles", origin })} />);
    expect(said({ kind: "voice", via: "note" })).toContain("Voice message");
    expect(said({ kind: "voice" })).toContain("On a call");
    expect(said(null)).not.toMatch(/Voice message|On a call/);
  });
});
