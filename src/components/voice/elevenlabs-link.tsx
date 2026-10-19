"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useMemo, useRef } from "react";
import { VOICE_TOOL_NAMES, type VoiceCue, type VoiceStage } from "@/lib/voice/types";
import { isMarker, markerText, type LinkProps, type VoiceLink } from "./link";

// The call's link to ElevenLabs Agents (WebRTC). The server minted a one-time conversation token
// for Studio's shared custom-LLM agent; the sealed voice context rides along as a secret__
// dynamic variable, which ElevenLabs sends only as a header to Studio's voice front, never to a
// model. The member's words come from ElevenLabs' final speech-to-text events, verbatim. Studio's
// lines (relay updates, cues) go as marked user messages, which the voice front says word for
// word; the stage goes as a contextual update. Only the voice id is set from here; every other
// override stays off on the agent.

const TYPED_ECHO_MS = 8000;

export default function ElevenLabsLink(props: LinkProps) {
  return (
    <ConversationProvider>
      <Session {...props} />
    </ConversationProvider>
  );
}

function Session({ grant, events, tools, onReady }: LinkProps) {
  const latest = useRef({ events, tools, onReady });
  latest.current = { events, tools, onReady };
  const closed = useRef(false);
  // What the member typed, so ElevenLabs' echo of it isn't taken as speech too.
  const typed = useRef<{ text: string; at: number } | null>(null);

  const clientTools = useMemo(
    () =>
      Object.fromEntries(
        VOICE_TOOL_NAMES.map((name) => [name, async (params: unknown) => String(await latest.current.tools[name]((params ?? {}) as Record<string, unknown>))]),
      ),
    [],
  );

  const conversation = useConversation({
    clientTools,
    onConnect: () => !closed.current && latest.current.events.onStatus("connected"),
    onDisconnect: () => !closed.current && latest.current.events.onStatus("ended"),
    onError: (message: string) => !closed.current && latest.current.events.onStatus("error", message || "The call dropped."),
    onModeChange: ({ mode }: { mode: "speaking" | "listening" }) => latest.current.events.onMode(mode),
    onInterruption: () => latest.current.events.onInterrupted(),
    onVadScore: ({ vadScore }: { vadScore: number }) => latest.current.events.onVoiceActivity?.(vadScore),
    onMessage: ({ message, role }: { message: string; role: "user" | "agent" }) => {
      if (role !== "user") return latest.current.events.onVoiceText(message);
      if (isMarker(message)) return;
      const echo = typed.current;
      if (echo && echo.text === message.trim() && Date.now() - echo.at < TYPED_ECHO_MS) {
        typed.current = null;
        return;
      }
      latest.current.events.onMemberText(message);
    },
  });
  const controls = useRef(conversation);
  controls.current = conversation;

  const started = useRef(false);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // One session per call: the token works once, and React may mount this twice in development.
    if (closing.current) clearTimeout(closing.current);
    closing.current = null;
    if (!started.current && grant.join.kind === "elevenlabs") {
      started.current = true;
      latest.current.events.onStatus("connecting");
      const c = controls.current;
      const link: VoiceLink = {
        say: (lines: string[], stage: VoiceStage) => controls.current.sendUserMessage(markerText({ say: lines, stage })),
        stage: (stage: VoiceStage) => controls.current.sendContextualUpdate(markerText({ stage })),
        cue: (cue: VoiceCue, stage: VoiceStage) => controls.current.sendUserMessage(markerText({ cue, stage })),
        type: (text: string) => {
          const said = text.trim();
          if (!said) return;
          typed.current = { text: said, at: Date.now() };
          latest.current.events.onMemberText(said);
          controls.current.sendUserMessage(said);
        },
        setMuted: ({ mic, speaker }) => {
          if (mic !== undefined) controls.current.setMuted(mic);
          if (speaker !== undefined) controls.current.setVolume({ volume: speaker ? 0 : 1 });
        },
        end: () => controls.current.endSession(),
      };
      latest.current.onReady(link);
      c.startSession({
        conversationToken: grant.join.conversationToken,
        connectionType: "webrtc",
        dynamicVariables: { secret__studio_voice_ctx: grant.context },
        ...(grant.persona.voiceId ? { overrides: { tts: { voiceId: grant.persona.voiceId } } } : {}),
      });
    }
    return () => {
      closing.current = setTimeout(() => {
        closed.current = true;
        controls.current.endSession();
      }, 0);
    };
  }, [grant]);
  return null;
}
