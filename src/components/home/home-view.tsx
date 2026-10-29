"use client";

import { ArrowRight, Plus, Settings2 } from "lucide-react";
import { useState } from "react";
import { MoveMark } from "@/components/ui/move-mark";
import { formatDay } from "@/components/tasks/shared";
import { BrandMark } from "@/components/ui/brand-mark";
import { Companion } from "@/components/ui/companion";
import type { AgentOverview } from "@/lib/home";
import { MAX_AGENTS, type Companion as CompanionInfo } from "@/lib/types";

/**
 * Every agent the person has, to pick which one to talk to. A card opens a new chat with that
 * agent; a chat on it opens that chat. Picking one makes it the agent this browser opens to.
 */
export function HomeView({
  agents,
  current,
  member,
  companions,
}: {
  agents: AgentOverview[];
  /** The agent this browser last opened. */
  current: string;
  member: string | null;
  companions: Record<string, CompanionInfo> | null;
}) {
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owned = agents.filter((a) => a.role === "owner").length;
  const waiting = agents.reduce((n, a) => n + a.counts.your_call, 0);

  async function open(agent: string, path: string) {
    if (opening) return;
    setOpening(agent);
    setError(null);
    try {
      if (agent !== current) {
        const res = await fetch("/api/workspaces/active", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: agent }),
        });
        if (!res.ok) throw new Error();
      }
      window.location.assign(path);
    } catch {
      setError("Couldn't open that agent. Try again.");
      setOpening(null);
    }
  }

  return (
    <div className="animate-fade-up">
      <h1 className="font-display text-[30px] leading-tight tracking-[-0.015em]">{member ? `Hi, ${member}` : "Your agents"}</h1>
      <p className="mt-1 text-[14px] text-fg-3">
        {waiting > 0 ? `${waiting} ${waiting === 1 ? "chat is" : "chats are"} waiting on you. ` : ""}
        Who do you want to talk to?
      </p>
      {error ? (
        <p role="alert" className="mt-4 text-[13px] text-danger">
          {error}
        </p>
      ) : null}

      <ul className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-[repeat(2,minmax(0,1fr))]">
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            companion={companions?.[agent.id] ?? null}
            last={agent.id === current}
            opening={opening === agent.id}
            disabled={opening !== null}
            onOpen={(path) => void open(agent.id, path)}
          />
        ))}
        {owned < MAX_AGENTS ? (
          <li>
            <a
              href="/onboarding?new=1"
              className="flex h-full min-h-[148px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong px-5 py-6 text-center text-fg-3 transition-colors hover:border-fg-4 hover:bg-hover hover:text-fg-2"
            >
              <Plus size={18} aria-hidden="true" />
              <span className="text-[14px] font-medium">New agent</span>
              <span className="text-[12.5px]">For a business, a job search, a project, or just you.</span>
            </a>
          </li>
        ) : null}
      </ul>

      <a
        href="/settings#agents"
        className="mt-6 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 -ml-2 text-[13px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
      >
        <Settings2 size={14} aria-hidden="true" />
        Manage agents
      </a>
    </div>
  );
}

function AgentCard({
  agent,
  companion,
  last,
  opening,
  disabled,
  onOpen,
}: {
  agent: AgentOverview;
  companion: CompanionInfo | null;
  /** The agent this browser last opened. */
  last: boolean;
  opening: boolean;
  disabled: boolean;
  onOpen: (path: string) => void;
}) {
  const name = companion?.name ?? agent.name;
  const working = agent.counts.working > 0;

  return (
    <li className="flex flex-col rounded-2xl border border-line bg-surface shadow-composer transition-colors has-[.card-open:hover]:border-line-strong">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onOpen("/")}
        aria-label={`Talk to ${name}`}
        className="card-open group flex w-full items-start gap-3 rounded-t-2xl px-4 pt-4 pb-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <span className={`mt-0.5 flex shrink-0 ${working && !companion ? "breathe-soft" : ""}`}>
          {companion ? (
            <Companion stage={companion.stage} look={companion.look} mood={working ? "working" : "idle"} size={36} seenKey={agent.id} />
          ) : (
            <BrandMark size={36} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-[15.5px] font-semibold tracking-[-0.01em]">{name}</span>
            {companion?.name ? <span className="min-w-0 truncate text-[12.5px] text-fg-3">{agent.name}</span> : null}
          </span>
          <span className="mt-0.5 block text-[12.5px] text-fg-3">
            <Status agent={agent} />
            {agent.role === "member" ? " · Shared with you" : last ? " · Last opened" : ""}
          </span>
          {agent.about ? <span className="mt-2 line-clamp-2 block text-[13.5px] leading-snug text-fg-2">{agent.about}</span> : null}
        </span>
        <span className="mt-1 flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-fg-3 transition-colors group-hover:text-fg">
          {opening ? "Opening…" : "Talk"}
          <ArrowRight size={14} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
        </span>
      </button>

      {agent.recent.length > 0 ? (
        <ul className="mx-2 mb-2 border-t border-line pt-1.5">
          {agent.recent.map((chat) => (
            <li key={chat.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onOpen(`/c/${chat.id}`)}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              >
                <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                <MoveMark move={chat.mark ?? undefined} />
                <span className="shrink-0 text-[12px] text-fg-4" suppressHydrationWarning>
                  {formatDay(chat.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Where things stand with the agent, from its chats' real state only. */
function Status({ agent }: { agent: AgentOverview }) {
  const { your_call, working, stuck } = agent.counts;
  if (your_call > 0) return <span className="font-medium text-accent">{your_call === 1 ? "Waiting on you" : `Waiting on you in ${your_call} chats`}</span>;
  if (working > 0) return <span className="text-fg-2">Working now</span>;
  if (stuck > 0) return <span className="text-danger">{stuck === 1 ? "A chat got stuck" : `${stuck} chats got stuck`}</span>;
  if (agent.lastActive === null) return <>No chats yet</>;
  return <span suppressHydrationWarning>Last chat {formatDay(agent.lastActive).replace(/^(Today|Yesterday)$/, (d) => d.toLowerCase())}</span>;
}
