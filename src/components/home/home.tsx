"use client";

import { forwardRef, useEffect, useState } from "react";
import { Composer, type ComposerHandle } from "@/components/chat/composer";
import { Companion, companionHint } from "@/components/ui/companion";
import { MoveMark } from "@/components/ui/move-mark";
import type { Companion as CompanionInfo, HomeConversation, HomeData, WorkspaceSummary } from "@/lib/types";
import type { VoiceStatus } from "@/lib/voice/types";

// Home: one place to ask, across the member's agents. The ask goes to whichever agent fits
// (src/lib/route.ts), or to the one they pick; when the router isn't sure, the likeliest agent is
// held up for them to confirm with Enter, and any other chip sends it there instead. Below, their
// latest chats from every agent on Home, each wearing its agent. Files and skills are an agent's
// own, so they're attached once inside the chat.

/** How many recent chats Home lists. */
export const HOME_SHOWN = 12;

/** What an agent is called to this member: its companion's name once it has one, else the agent's. */
export function agentLabel(workspace: WorkspaceSummary, companions: Record<string, CompanionInfo> | null): string {
  return companions?.[workspace.id]?.name ?? workspace.name;
}

interface Props {
  data: HomeData | null;
  workspaces: WorkspaceSummary[];
  companions: Record<string, CompanionInfo> | null;
  /** The agent this tab is on: its chats open in place, the others' with a load. */
  current: string;
  draft: string;
  onDraftChange: (value: string) => void;
  /** The ask, and the agent the member picked for it (null: whichever fits). */
  onSubmit: (text: string, pick: string | null) => void;
  /** The router is deciding. */
  routing: boolean;
  /** The router wasn't sure: the text stays, and the suggested agent is held up to confirm. */
  ask: { text: string; suggested: string } | null;
  onCancelAsk: () => void;
  onOpen: (conversation: HomeConversation) => void;
  voice: VoiceStatus | null;
  footnote: React.ReactNode;
  /** Why the last ask couldn't go. */
  notice: string | null;
  /** List recent chats here: only where the sidebar, which lists the same chats, isn't on screen. */
  showRecent: boolean;
}

const chip =
  "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] transition-[border-color,background-color,color,box-shadow] duration-150 hover:bg-surface hover:text-fg";

export const HomeView = forwardRef<ComposerHandle, Props>(function HomeView(
  { data, workspaces, companions, current, draft, onDraftChange, onSubmit, routing, ask, onCancelAsk, onOpen, voice, footnote, notice, showRecent },
  composerRef,
) {
  const composer = composerRef && typeof composerRef === "object" ? composerRef : null;
  const agents = workspaces.filter((w) => w.onHome);
  const [pick, setPick] = useState<string | null>(null);
  // What's in the box now, so a chip sends the words as the member last left them.
  const [text, setText] = useState(draft);
  const label = (w: WorkspaceSummary) => agentLabel(w, companions);
  const byId = (id: string) => workspaces.find((w) => w.id === id);
  const here = byId(current);

  // The composer clears on send; when Home asks instead, the words come back for the member.
  useEffect(() => {
    if (ask) {
      composer?.current?.setValue(ask.text);
      setText(ask.text);
    }
  }, [ask, composer]);

  // The composer clears as it submits; while the router is still deciding the last ask, the words stay.
  function submit(value: string, chosen: string | null) {
    if (routing) {
      composer?.current?.setValue(value);
      return;
    }
    onSubmit(value, chosen);
  }

  const suggested = ask ? byId(ask.suggested) : undefined;
  const picked = pick ? byId(pick) : undefined;
  const hint = routing
    ? "Finding the right agent…"
    : agents.length === 0
      ? `None of your agents is on Home yet, so this goes to ${here ? label(here) : "this agent"}.`
      : ask && suggested
        ? `Who should take this? Enter sends it to ${label(suggested)}, or pick another.`
        : picked
          ? `Going to ${label(picked)}.`
          : "Goes to whichever agent fits, or pick one.";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 md:px-8"
      onKeyDown={(e) => {
        if (e.key === "Escape" && ask) onCancelAsk();
      }}
    >
      <div className="flex flex-col items-center justify-center gap-4 pt-[8vh] md:pt-[14vh]">
        <h1 className="animate-fade-up text-center font-display text-[30px] leading-tight tracking-[-0.015em] text-fg md:text-[36px]">What should we work on?</h1>
      </div>

      <div className="mx-auto mt-6 w-full max-w-[44rem] md:mt-8">
        <div className="animate-fade-up [animation-delay:60ms]">
          <Composer
            ref={composerRef}
            variant="hero"
            initialValue={draft}
            onDraftChange={(value) => {
              setText(value);
              onDraftChange(value);
            }}
            onSubmit={(value) => submit(value, ask ? ask.suggested : pick)}
            onStop={() => {}}
            running={false}
            placeholder="Ask anything"
            skills={[]}
            autoFocus
            allowFiles={false}
            voice={voice}
          />
          <p role="status" aria-live="polite" className={`mt-2 min-h-[18px] px-1 text-center text-[12.5px] ${notice ? "text-danger" : ask ? "text-fg-2" : "text-fg-3"}`}>
            {notice ?? hint}
          </p>
        </div>
        <div role="group" aria-label="Which agent" className="mt-3 flex flex-wrap justify-center gap-1.5 animate-fade-up [animation-delay:90ms]">
          <button
            type="button"
            aria-pressed={!pick && !ask}
            onClick={() => {
              if (ask) onCancelAsk();
              setPick(null);
              composer?.current?.focus();
            }}
            className={`${chip} ${!pick && !ask ? "border-fg text-fg bg-surface" : "border-line text-fg-2"}`}
          >
            Auto
          </button>
          {agents.map((w) => {
            const c = companions?.[w.id];
            const isSuggested = ask?.suggested === w.id;
            const isPicked = !ask && pick === w.id;
            return (
              <button
                key={w.id}
                type="button"
                aria-pressed={isPicked}
                title={c ? companionHint(c.stage, c.name, c.toMeet) : undefined}
                onClick={() => {
                  if (ask) {
                    submit(text.trim() || ask.text, w.id);
                    return;
                  }
                  setPick(w.id);
                  composer?.current?.focus();
                }}
                className={`${chip} ${
                  isSuggested
                    ? "border-accent bg-accent-soft text-fg shadow-[0_0_0_3px_var(--accent-soft)]"
                    : isPicked
                      ? "border-fg bg-surface text-fg"
                      : "border-line text-fg-2"
                }`}
              >
                {c ? <Companion stage={c.stage} look={c.look} size={16} /> : null}
                <span>{label(w)}</span>
                {c?.name ? <span className="text-[12px] text-fg-3">{w.name}</span> : null}
                {isSuggested ? <kbd className="rounded border border-line-strong px-1 font-sans text-[11px] leading-4 text-fg-3">↵</kbd> : null}
              </button>
            );
          })}
        </div>

        {/* The sidebar lists the same chats; this list is for where it's hidden (a phone, a collapsed sidebar). */}
        {!showRecent ? (
          footnote ? <div className="mt-6 pb-[max(16px,env(safe-area-inset-bottom))] text-center md:mt-8">{footnote}</div> : null
        ) : (
        <section aria-labelledby="home-recent" className="mt-9 pb-[max(16px,env(safe-area-inset-bottom))] animate-fade-up [animation-delay:120ms]">
          <h2 id="home-recent" className="px-2.5 pb-1 text-[11.5px] font-medium tracking-[0.02em] text-fg-3 uppercase">
            Recent
          </h2>
          {data === null ? (
            <div className="flex h-20 items-center justify-center" aria-busy="true">
              <span className="spinner animate-fade-in [animation-delay:200ms]" aria-label="Loading" />
            </div>
          ) : data.conversations.length === 0 ? (
            <p className="px-2.5 py-2 text-[13px] text-fg-3">Chats with all your agents will show here.</p>
          ) : (
            <ul>
              {data.conversations.slice(0, HOME_SHOWN).map((conv) => {
                const w = byId(conv.workspaceId);
                const c = companions?.[conv.workspaceId];
                const move = data.moves[conv.id];
                return (
                  <li key={conv.id}>
                    <a
                      href={`/c/${conv.id}`}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        // Another agent's chat loads under that agent; this agent's opens in place.
                        if (conv.workspaceId !== current) return;
                        e.preventDefault();
                        onOpen(conv);
                      }}
                      className="flex h-10 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-fg transition-colors hover:bg-hover"
                    >
                      {c ? <Companion stage={c.stage} look={c.look} size={16} mood={move === "working" ? "working" : "idle"} /> : null}
                      <span className="min-w-0 flex-1 truncate">{conv.title}</span>
                      {w ? <span className="max-w-[36%] shrink-0 truncate text-[12px] text-fg-3">{label(w)}</span> : null}
                      <MoveMark move={move} />
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
          {footnote ? <div className="mt-6 text-center">{footnote}</div> : null}
        </section>
        )}
      </div>
    </div>
  );
});
