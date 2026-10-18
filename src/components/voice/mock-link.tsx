"use client";

import { useEffect, useRef } from "react";
import { markerText, type LinkProps, type VoiceLink, type VoiceLinkEvents, type VoiceTools } from "./link";
import type { VoiceCue, VoiceGrant, VoiceStage } from "@/lib/voice/types";

// MOCK VOICE: the call's link for QA, labeled "Mock voice" on screen. It plays the provider's
// part: what the member types is taken as their speech, each turn goes to Studio's real voice
// front (sealed context and all), the voice's words show as captions with a speaking time
// instead of audio, and its tool calls run in the browser like the real provider's do.

type Message = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: unknown[]; tool_call_id?: string };
type Call = { id: string; name: string; args: string };

/** Text and tool calls from an OpenAI-style event stream. */
async function readReply(body: ReadableStream<Uint8Array>): Promise<{ text: string; calls: Call[] }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const calls: Call[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 2);
      if (!event.startsWith("data:")) continue;
      const data = event.slice(5).trim();
      if (data === "[DONE]") continue;
      const delta = (JSON.parse(data) as { choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] }).choices?.[0]?.delta;
      if (delta?.content) text += delta.content;
      for (const t of delta?.tool_calls ?? []) {
        const call = (calls[t.index] ??= { id: t.id ?? `call_${t.index}`, name: "", args: "" });
        if (t.function?.name) call.name = t.function.name;
        if (t.function?.arguments) call.args += t.function.arguments;
      }
    }
  }
  return { text: text.trim(), calls: calls.filter(Boolean) };
}

class MockLink implements VoiceLink {
  private history: Message[] = [];
  private chain: Promise<void> = Promise.resolve();
  private speaking: ReturnType<typeof setTimeout> | null = null;
  private muted = { mic: false, speaker: false };
  private ended = false;

  constructor(
    private grant: VoiceGrant,
    private events: () => VoiceLinkEvents,
    private tools: () => VoiceTools,
  ) {}

  start() {
    this.events().onStatus("connecting");
    setTimeout(() => !this.ended && this.events().onStatus("connected"), 300);
  }

  private turn(...messages: Message[]) {
    this.chain = this.chain.then(async () => {
      if (this.ended) return;
      this.history.push(...messages);
      await this.respond(0).catch(() => this.events().onStatus("error", "The mock voice couldn't reach Studio."));
    });
  }

  private async respond(depth: number): Promise<void> {
    const res = await fetch("/api/voice/llm/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Studio-Conversation": this.grant.conversationId, "X-Studio-Voice-Ctx": this.grant.context },
      body: JSON.stringify({ model: "studio-voice", stream: true, messages: this.history }),
    });
    if (!res.ok || !res.body) throw new Error(`voice front ${res.status}`);
    const { text, calls } = await readReply(res.body);
    if (this.ended) return;
    this.history.push({
      role: "assistant",
      content: text || null,
      ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })) } : {}),
    });
    if (text) this.speak(text);
    const results: Message[] = [];
    for (const call of calls) {
      if (call.name === "skip_turn") continue;
      if (call.name === "end_call") return this.end();
      const run = this.tools()[call.name as keyof VoiceTools];
      let args: Record<string, unknown> = {};
      try {
        args = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
      } catch {
        // malformed arguments: the tool sees none
      }
      const result = run ? await run(args) : `Refused: there's no ${call.name}.`;
      results.push({ role: "tool", tool_call_id: call.id, content: String(result) });
    }
    if (results.length && depth < 3) {
      this.history.push(...results);
      await this.respond(depth + 1);
    }
  }

  private speak(text: string) {
    this.events().onVoiceText(text);
    if (this.muted.speaker) return;
    this.stopSpeaking();
    this.events().onMode("speaking");
    this.speaking = setTimeout(() => {
      this.speaking = null;
      this.events().onMode("listening");
    }, Math.min(8000, Math.max(700, text.length * 45)));
  }

  private stopSpeaking(): boolean {
    if (!this.speaking) return false;
    clearTimeout(this.speaking);
    this.speaking = null;
    this.events().onMode("listening");
    return true;
  }

  say(lines: string[], stage: VoiceStage) {
    this.turn({ role: "user", content: markerText({ say: lines, stage }) });
  }

  stage(stage: VoiceStage) {
    this.history.push({ role: "system", content: markerText({ stage }) });
  }

  cue(cue: VoiceCue, stage: VoiceStage) {
    this.turn({ role: "user", content: markerText({ cue, stage }) });
  }

  type(text: string) {
    const said = text.trim();
    if (!said || this.ended) return;
    // Talking over the voice cuts it off; the words still count.
    if (this.stopSpeaking()) this.events().onInterrupted();
    this.events().onMemberText(said);
    this.turn({ role: "user", content: said });
  }

  setMuted(what: { mic?: boolean; speaker?: boolean }) {
    this.muted = { ...this.muted, ...what };
    if (what.speaker) this.stopSpeaking();
  }

  end() {
    if (this.close()) this.events().onStatus("ended");
  }

  /** Ends the call without telling the call screen (it's going away). */
  close(): boolean {
    if (this.ended) return false;
    this.ended = true;
    if (this.speaking) clearTimeout(this.speaking);
    return true;
  }
}

export default function MockVoiceLink({ grant, events, tools, onReady }: LinkProps) {
  const latest = useRef({ events, tools, onReady });
  latest.current = { events, tools, onReady };
  const link = useRef<MockLink | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // One link for the call's lifetime, even when React mounts this twice in development.
    if (closing.current) clearTimeout(closing.current);
    closing.current = null;
    if (!link.current) {
      link.current = new MockLink(grant, () => latest.current.events, () => latest.current.tools);
      latest.current.onReady(link.current);
      link.current.start();
    }
    return () => {
      closing.current = setTimeout(() => link.current?.close(), 0);
    };
  }, [grant]);
  return null;
}
