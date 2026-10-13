"use client";

import { Menu, PanelLeftOpen, SquarePen } from "lucide-react";
import { usePathname } from "next/navigation";
import { Tooltip } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer, type ComposerHandle } from "@/components/chat/composer";
import { EmptyState } from "@/components/chat/empty-state";
import { Thread } from "@/components/chat/thread";
import { collectFindings, WorkPanel } from "@/components/chat/work-panel";
import { Sidebar } from "@/components/sidebar/sidebar";
import { IconButton, TooltipContent } from "@/components/ui/icon-button";
import { isMac, useMedia } from "@/components/ui/use-media";
import { ApiError, api, streamTurn } from "@/lib/client/api";
import type { AgentStatus, ChatMessage, ConversationSummary, StreamEvent, WorkspaceSummary } from "@/lib/types";

type ThreadState =
  | { status: "loading"; messages: ChatMessage[] }
  | { status: "ready"; messages: ChatMessage[] }
  | { status: "missing"; messages: ChatMessage[] }
  | { status: "error"; messages: ChatMessage[] };

export interface InitialThread {
  id: string;
  status: "ready" | "missing";
  messages: ChatMessage[];
}

interface Props {
  initialConversations: ConversationSummary[];
  initialThread: InitialThread | null;
  agent: AgentStatus;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  email: string | null;
}

const SIDEBAR_KEY = "lj.sidebar-collapsed";
const WORK_PANEL_KEY = "lj.work-panel";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function conversationIdFrom(pathname: string): string | null {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  return match && UUID.test(match[1]) ? match[1] : null;
}

function provisionalTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/**
 * Owns conversation state for the whole workspace: the conversation list, loaded threads,
 * and in-flight runs. Runs live here rather than in the thread view, so a conversation keeps
 * streaming while the user reads or starts another one.
 */
export function Workspace({ initialConversations, initialThread, agent, workspace, workspaces, email }: Props) {
  // Navigation is client-side history only. The path lives in local state so a switch
  // renders immediately (Next applies pushState-driven pathname updates as a transition).
  const [pathname, setPathname] = useState(usePathname());
  const activeId = conversationIdFrom(pathname);

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const [conversations, setConversations] = useState(initialConversations);
  const [threads, setThreads] = useState<Record<string, ThreadState>>(() =>
    initialThread ? { [initialThread.id]: { status: initialThread.status, messages: initialThread.messages } } : {},
  );
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
  const [sendCount, setSendCount] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** Message shown in the work panel; "latest" follows the newest reply. null = closed. */
  const [panel, setPanel] = useState<string | null>(null);
  const panelAuto = useRef(true);

  const controllers = useRef(new Map<string, AbortController>());
  /** Sends that never reached the server, keyed by placeholder id, so Retry can resend them. */
  const unsent = useRef(new Map<string, string>());
  const drafts = useRef(new Map<string, string>());
  const composer = useRef<ComposerHandle>(null);
  const search = useRef<HTMLInputElement>(null);

  const desktop = useMedia("(min-width: 768px)", true);
  const [mod, setMod] = useState("Ctrl+");
  useEffect(() => setMod(isMac() ? "⌘" : "Ctrl+"), []);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
      panelAuto.current = localStorage.getItem(WORK_PANEL_KEY) !== "off";
    } catch {
      // storage unavailable; keep the default
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    if (!window.matchMedia("(min-width: 768px)").matches) {
      setDrawerOpen((v) => !v);
      return;
    }
    setCollapsed((v) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, v ? "0" : "1");
      } catch {
        // ignore
      }
      return !v;
    });
  }, []);

  const navigate = useCallback((path: string) => {
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setPathname(path);
    setDrawerOpen(false);
  }, []);

  // ---------------------------------------------------------------------------------------
  // State helpers

  const patchMessages = useCallback((conversationId: string, fn: (messages: ChatMessage[]) => ChatMessage[]) => {
    setThreads((all) => {
      const thread = all[conversationId];
      if (!thread) return all;
      return { ...all, [conversationId]: { ...thread, messages: fn(thread.messages) } };
    });
  }, []);

  const patchMessage = useCallback(
    (conversationId: string, messageId: string, fn: (m: ChatMessage) => ChatMessage) =>
      patchMessages(conversationId, (messages) => messages.map((m) => (m.id === messageId ? fn(m) : m))),
    [patchMessages],
  );

  const upsertConversation = useCallback((summary: ConversationSummary) => {
    setConversations((list) => [summary, ...list.filter((c) => c.id !== summary.id)].sort((a, b) => b.updatedAt - a.updatedAt));
  }, []);

  const setRunState = useCallback((id: string, on: boolean) => {
    setRunning((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // ---------------------------------------------------------------------------------------
  // Load a conversation when navigating to one that isn't in memory.

  const activeThread = activeId ? threads[activeId] : undefined;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  useEffect(() => {
    if (!activeId) return;
    const existing = threadsRef.current[activeId];
    if (existing && existing.status !== "error") return;
    const controller = new AbortController();
    setThreads((all) => ({ ...all, [activeId]: { status: "loading", messages: [] } }));
    api
      .getConversation(activeId, controller.signal)
      .then(({ messages }) => setThreads((all) => ({ ...all, [activeId]: { status: "ready", messages } })))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status = error instanceof ApiError && error.status === 404 ? "missing" : "error";
        setThreads((all) => ({ ...all, [activeId]: { status, messages: [] } }));
      });
    return () => {
      controller.abort();
      setThreads((all) => {
        if (all[activeId]?.status !== "loading") return all;
        const { [activeId]: _, ...rest } = all;
        return rest;
      });
    };
  }, [activeId]);

  const activeTitle = useMemo(
    () => (activeId ? conversations.find((c) => c.id === activeId)?.title : undefined),
    [activeId, conversations],
  );

  useEffect(() => {
    document.title = activeTitle ? `${activeTitle} · Studio` : `${workspace.name} · Studio`;
  }, [activeTitle, workspace.name]);

  // ---------------------------------------------------------------------------------------
  // Running turns

  const runTurn = useCallback(
    async (
      conversationId: string,
      body: { kind: "send"; text: string } | { kind: "retry" },
      placeholderIds: { user?: string; assistant: string },
    ) => {
      const controller = new AbortController();
      controllers.current.set(conversationId, controller);
      setRunState(conversationId, true);

      let assistantId = placeholderIds.assistant;
      let started = false;
      let buffered = "";
      let frame = 0;

      // Coalesce text deltas into one render per animation frame.
      const flush = () => {
        frame = 0;
        if (!buffered) return;
        const delta = buffered;
        buffered = "";
        patchMessage(conversationId, assistantId, (m) => ({ ...m, content: m.content + delta }));
      };

      const onEvent = (event: StreamEvent) => {
        switch (event.type) {
          case "start": {
            started = true;
            const previousId = assistantId;
            assistantId = event.assistantMessage.id;
            patchMessages(conversationId, (messages) =>
              messages.map((m) =>
                m.id === previousId
                  ? event.assistantMessage
                  : event.userMessage && m.id === placeholderIds.user
                    ? event.userMessage
                    : m,
              ),
            );
            upsertConversation(event.conversation);
            break;
          }
          case "text":
            buffered += event.delta;
            if (!frame) frame = requestAnimationFrame(flush);
            break;
          case "text-replace":
            buffered = "";
            patchMessage(conversationId, assistantId, (m) => ({ ...m, content: event.text }));
            break;
          case "activity":
            patchMessage(conversationId, assistantId, (m) => {
              const exists = m.activity.some((s) => s.id === event.step.id);
              return {
                ...m,
                activity: exists ? m.activity.map((s) => (s.id === event.step.id ? event.step : s)) : [...m.activity, event.step],
              };
            });
            break;
          case "artifact":
            patchMessage(conversationId, assistantId, (m) => ({ ...m, artifacts: [...m.artifacts, event.artifact] }));
            break;
          case "end":
            cancelAnimationFrame(frame);
            buffered = "";
            patchMessage(conversationId, assistantId, () => event.message);
            upsertConversation(event.conversation);
            break;
        }
      };

      try {
        await streamTurn(conversationId, body, onEvent, controller.signal);
      } catch (error) {
        cancelAnimationFrame(frame);
        flush();
        const aborted = controller.signal.aborted;
        if (!started && body.kind === "send") unsent.current.set(assistantId, body.text);
        patchMessage(conversationId, assistantId, (m) =>
          m.status !== "streaming"
            ? m
            : aborted
              ? { ...m, status: "stopped" }
              : {
                  ...m,
                  status: "error",
                  error:
                    error instanceof ApiError
                      ? error.message
                      : "Couldn't reach the workspace server. Check your connection and try again.",
                },
        );
      } finally {
        controllers.current.delete(conversationId);
        setRunState(conversationId, false);
      }
    },
    [patchMessage, patchMessages, setRunState, upsertConversation],
  );

  const sendTo = useCallback(
    (conversationId: string, text: string, isNew: boolean) => {
      const now = Date.now();
      const base = { conversationId, activity: [], artifacts: [], createdAt: now };
      const user: ChatMessage = { ...base, id: `pending-user-${now}`, role: "user", content: text, status: "complete" };
      const assistant: ChatMessage = {
        ...base,
        id: `pending-assistant-${now}`,
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: now + 1,
      };
      setThreads((all) => ({
        ...all,
        [conversationId]: { status: "ready", messages: [...(all[conversationId]?.messages ?? []), user, assistant] },
      }));
      setConversations((list) => {
        const existing = list.find((c) => c.id === conversationId);
        const summary = existing
          ? { ...existing, updatedAt: now }
          : { id: conversationId, title: provisionalTitle(text), createdAt: now, updatedAt: now };
        return [summary, ...list.filter((c) => c.id !== conversationId)];
      });
      if (isNew) navigate(`/c/${conversationId}`);
      setSendCount((n) => n + 1);
      void runTurn(conversationId, { kind: "send", text }, { user: user.id, assistant: assistant.id });
    },
    [navigate, runTurn],
  );

  const send = useCallback(
    (text: string) => {
      if (activeId) {
        if (running.has(activeId)) return;
        drafts.current.delete(activeId);
        sendTo(activeId, text, false);
      } else {
        drafts.current.delete("new");
        sendTo(crypto.randomUUID(), text, true);
      }
    },
    [activeId, running, sendTo],
  );

  const retry = useCallback(
    (messageId: string) => {
      if (!activeId || running.has(activeId)) return;
      const conversationId = activeId;
      const unsentText = unsent.current.get(messageId);
      if (unsentText !== undefined) {
        // The original send never reached the server: drop both placeholders and resend.
        unsent.current.delete(messageId);
        patchMessages(conversationId, (messages) => {
          const index = messages.findIndex((m) => m.id === messageId);
          return index > 0 ? messages.slice(0, index - 1) : messages.filter((m) => m.id !== messageId);
        });
        sendTo(conversationId, unsentText, false);
        return;
      }
      const now = Date.now();
      const assistant: ChatMessage = {
        id: `pending-assistant-${now}`,
        conversationId,
        role: "assistant",
        content: "",
        status: "streaming",
        activity: [],
        artifacts: [],
        createdAt: now,
      };
      patchMessages(conversationId, (messages) => [...messages.filter((m) => m.id !== messageId), assistant]);
      setSendCount((n) => n + 1);
      void runTurn(conversationId, { kind: "retry" }, { assistant: assistant.id });
    },
    [activeId, patchMessages, runTurn, running, sendTo],
  );

  // Stopping is a request to the server: closing the tab doesn't stop the agent, Stop does.
  const stop = useCallback(() => {
    if (!activeId) return;
    const id = activeId;
    api.stopRun(id).catch(() => controllers.current.get(id)?.abort());
  }, [activeId]);

  // Follow a run this tab didn't start (e.g. after a reload) until it finishes.
  const followingRemote = activeThread?.status === "ready" && activeThread.messages.some((m) => m.status === "streaming") && !controllers.current.has(activeId ?? "");
  useEffect(() => {
    if (!activeId || !followingRemote) return;
    const id = activeId;
    let cancelled = false;
    setRunState(id, true);
    const tick = async () => {
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, 1500));
        if (cancelled || controllers.current.has(id)) return;
        try {
          const { messages, conversation } = await api.getConversation(id);
          if (cancelled) return;
          setThreads((all) => ({ ...all, [id]: { status: "ready", messages } }));
          if (!messages.some((m) => m.status === "streaming")) {
            upsertConversation(conversation);
            return;
          }
        } catch {
          // keep trying while the conversation is open
        }
      }
    };
    void tick().finally(() => {
      // A cancelled follower leaves the flag to whichever effect replaced it.
      if (!cancelled && !controllers.current.has(id)) setRunState(id, false);
    });
    return () => {
      cancelled = true;
      if (!controllers.current.has(id)) setRunState(id, false);
    };
  }, [activeId, followingRemote, setRunState, upsertConversation]);

  // ---------------------------------------------------------------------------------------
  // Conversation management

  const newChat = useCallback(() => {
    navigate("/");
    requestAnimationFrame(() => composer.current?.focus());
  }, [navigate]);

  const rename = useCallback(
    (id: string, title: string) => {
      const previous = conversations.find((c) => c.id === id);
      setConversations((list) => list.map((c) => (c.id === id ? { ...c, title } : c)));
      api.renameConversation(id, title).catch(() => {
        if (previous) setConversations((list) => list.map((c) => (c.id === id ? { ...c, title: previous.title } : c)));
      });
    },
    [conversations],
  );

  const remove = useCallback(
    (id: string) => {
      controllers.current.get(id)?.abort();
      const snapshot = conversations;
      setConversations((list) => list.filter((c) => c.id !== id));
      if (id === activeId) navigate("/");
      api
        .deleteConversation(id)
        .then(() =>
          setThreads((all) => {
            const { [id]: _, ...rest } = all;
            return rest;
          }),
        )
        .catch(() => setConversations(snapshot));
    },
    [activeId, conversations, navigate],
  );

  // The panel opens on its own once a running reply has found something worth showing.
  const latestReply = activeThread?.status === "ready" ? activeThread.messages.findLast((m) => m.role === "assistant") : undefined;
  const latestHasFindings = latestReply?.status === "streaming" && collectFindings(latestReply).length > 0;
  useEffect(() => {
    if (latestHasFindings && panelAuto.current) setPanel((current) => current ?? "latest");
  }, [latestHasFindings]);

  // Switching to a conversation that isn't working closes the panel.
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    if (activeId && runningRef.current.has(activeId)) return;
    setPanel(null);
  }, [activeId]);

  const openPanel = useCallback((messageId: string) => {
    panelAuto.current = true;
    try {
      localStorage.setItem(WORK_PANEL_KEY, "auto");
    } catch {
      // ignore
    }
    setPanel(messageId);
  }, []);

  const closePanel = useCallback(() => {
    panelAuto.current = false;
    try {
      localStorage.setItem(WORK_PANEL_KEY, "off");
    } catch {
      // ignore
    }
    setPanel(null);
  }, []);

  // ---------------------------------------------------------------------------------------
  // Keyboard shortcuts

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const modKey = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (modKey && event.shiftKey && key === "o") {
        event.preventDefault();
        newChat();
      } else if (modKey && !event.shiftKey && key === "k") {
        event.preventDefault();
        const wide = window.matchMedia("(min-width: 768px)").matches;
        if (wide && !collapsed) {
          search.current?.focus();
        } else {
          if (wide) setCollapsed(false);
          else setDrawerOpen(true);
          // The sidebar is inert until it opens; focus once it has rendered.
          requestAnimationFrame(() => requestAnimationFrame(() => search.current?.focus()));
        }
      } else if (modKey && !event.shiftKey && key === "b") {
        event.preventDefault();
        toggleSidebar();
      } else if (key === "escape" && drawerOpen) {
        setDrawerOpen(false);
      } else if (key === "escape" && activeId && running.has(activeId) && document.activeElement === document.body) {
        stop();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, collapsed, drawerOpen, newChat, running, stop, toggleSidebar]);

  // ---------------------------------------------------------------------------------------

  const isRunning = activeId ? running.has(activeId) : false;
  const sidebarHidden = desktop ? collapsed : !drawerOpen;
  const draftKey = activeId ?? "new";

  const footnote =
    agent.mode === "mock" ? (
      <p className="text-[12px] text-fg-3">
        Mock agent — responses are simulated. Connect the agent API to work with real data.
      </p>
    ) : agent.mode === "unavailable" ? (
      <p className="text-[12px] text-fg-3">The agent isn&apos;t enabled for this workspace yet.</p>
    ) : null;

  return (
    <Tooltip.Provider delayDuration={500} skipDelayDuration={200}>
      <div className="flex h-dvh overflow-hidden bg-bg">
        {/* Mobile drawer backdrop */}
        <div
          aria-hidden="true"
          onClick={() => setDrawerOpen(false)}
          className={`fixed inset-0 z-30 bg-black/25 transition-opacity duration-300 md:hidden ${
            drawerOpen ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        />

        <aside
          aria-label="Sidebar"
          inert={sidebarHidden || undefined}
          className={`z-40 h-full shrink-0 overflow-hidden border-r border-line bg-sidebar transition-[margin,transform] duration-300 ease-out-soft max-md:fixed max-md:inset-y-0 max-md:left-0 ${
            drawerOpen ? "max-md:translate-x-0 max-md:shadow-pop" : "max-md:-translate-x-full"
          } ${collapsed ? "md:-ml-[265px]" : "md:ml-0"}`}
        >
          <Sidebar
            ref={search}
            conversations={conversations}
            activeId={activeId}
            running={running}
            agent={agent}
            workspace={workspace}
            workspaces={workspaces}
            email={email}
            mod={mod}
            onSelect={(id) => navigate(`/c/${id}`)}
            onNew={newChat}
            onCollapse={toggleSidebar}
            onRename={rename}
            onDelete={remove}
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-1 px-3 md:px-4">
            <IconButton label="Open sidebar" className="md:hidden" onClick={() => setDrawerOpen(true)}>
              <Menu size={18} strokeWidth={1.75} />
            </IconButton>
            {collapsed ? (
              <div className="hidden items-center gap-0.5 md:flex">
                <IconButton label="Open sidebar" shortcut={`${mod}B`} onClick={toggleSidebar}>
                  <PanelLeftOpen size={17} strokeWidth={1.75} />
                </IconButton>
                <IconButton label="New chat" shortcut={`${mod}⇧O`} onClick={newChat}>
                  <SquarePen size={16} strokeWidth={1.75} />
                </IconButton>
              </div>
            ) : null}
            <h1 className="min-w-0 flex-1 truncate px-1.5 text-[14px] font-medium text-fg-2 max-md:text-center">
              {activeTitle ?? ""}
            </h1>
            {agent.mode === "mock" ? (
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <span
                    tabIndex={0}
                    className="hidden h-6 items-center gap-1.5 rounded-full border border-line px-2.5 text-[12px] text-fg-2 md:inline-flex"
                  >
                    <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
                    Mock agent
                  </span>
                </Tooltip.Trigger>
                <TooltipContent label="The agent API isn't connected. Responses are simulated." />
              </Tooltip.Root>
            ) : null}
            <IconButton label="New chat" className="md:hidden" onClick={newChat}>
              <SquarePen size={17} strokeWidth={1.75} />
            </IconButton>
          </header>

          {!activeId ? (
            <EmptyState
              key="new"
              ref={composer}
              draft={drafts.current.get("new") ?? ""}
              onDraftChange={(v) => drafts.current.set("new", v)}
              onSubmit={send}
              footnote={footnote}
            />
          ) : activeThread?.status === "missing" || activeThread?.status === "error" ? (
            <Unavailable missing={activeThread.status === "missing"} onNew={newChat} />
          ) : activeThread?.status === "ready" ? (
            <Thread
              key={activeId}
              messages={activeThread.messages}
              onRetry={retry}
              onOpenPanel={openPanel}
              sendCount={sendCount}
              footer={
                <div className="mx-auto w-full max-w-[46rem] px-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-6 md:pb-5">
                  <Composer
                    key={draftKey}
                    ref={composer}
                    initialValue={drafts.current.get(draftKey) ?? ""}
                    onDraftChange={(v) => drafts.current.set(draftKey, v)}
                    onSubmit={send}
                    onStop={stop}
                    running={isRunning}
                    placeholder="Reply…"
                    autoFocus={desktop}
                  />
                  {footnote ? <div className="mt-2 text-center max-md:hidden">{footnote}</div> : null}
                </div>
              }
            />
          ) : (
            <div className="flex flex-1 items-center justify-center" aria-busy="true">
              <span className="spinner animate-fade-in [animation-delay:200ms]" aria-label="Loading conversation" />
            </div>
          )}
        </main>

        {panel && activeId && activeThread?.status === "ready" ? (
          <WorkPanel
            message={
              panel === "latest"
                ? (activeThread.messages.findLast((m) => m.role === "assistant") ?? null)
                : (activeThread.messages.find((m) => m.id === panel) ?? null)
            }
            onClose={closePanel}
          />
        ) : null}
      </div>
    </Tooltip.Provider>
  );
}

function Unavailable({ missing, onNew }: { missing: boolean; onNew: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[10vh] text-center animate-fade-up">
      <h2 className="font-display text-[24px] tracking-[-0.01em]">
        {missing ? "This conversation isn't here" : "Couldn't load this conversation"}
      </h2>
      <p className="mt-2 max-w-sm text-[14px] text-fg-3">
        {missing ? "It may have been deleted." : "Check your connection and reload the page."}
      </p>
      <button
        type="button"
        onClick={onNew}
        className="mt-6 inline-flex h-9 items-center gap-2 rounded-lg bg-inverse px-3.5 text-[13.5px] font-medium text-on-inverse transition-opacity hover:opacity-90"
      >
        <SquarePen size={15} strokeWidth={1.75} />
        New chat
      </button>
    </div>
  );
}
