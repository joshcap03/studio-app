"use client";

import { AudioLines, ChevronRight, Menu, PanelLeftOpen, Paperclip, SquarePen } from "lucide-react";
import { usePathname } from "next/navigation";
import { DropdownMenu, Tooltip } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CardDraftsProvider } from "@/components/chat/card-drafts";
import { Composer, type ComposerHandle } from "@/components/chat/composer";
import { EmptyState } from "@/components/chat/empty-state";
import { HomeView, agentLabel } from "@/components/home/home";
import { DictationContext } from "@/components/chat/mic";
import { Thread } from "@/components/chat/thread";
import { collectFindings, WorkPanel } from "@/components/chat/work-panel";
import { ProjectView } from "@/components/project/project-view";
import { Sidebar } from "@/components/sidebar/sidebar";
import { LibraryView } from "@/components/library/library-view";
import { TrackerPage } from "@/components/library/tracker-page";
import { TaskDetail } from "@/components/tasks/task-detail";
import { collectionName } from "@/components/tasks/tracker";
import { TasksView } from "@/components/tasks/tasks-view";
import { Companion as CompanionMark, CompanionContext } from "@/components/ui/companion";
import { IconButton, TooltipContent } from "@/components/ui/icon-button";
import { Journey } from "@/components/ui/journey";
import { isMac, useKeyboardHeight, useMedia } from "@/components/ui/use-media";
import { Call, type CallLayout, type OpenResult } from "@/components/voice/call";
import { VoicePlayer } from "@/components/voice/player";
import { ScreenButtonsContext, type ScreenButtons } from "@/components/voice/screen";
import { followAnchor, followEvents, joinedEvents, keepEarlier, mergeSince } from "@/lib/chat/follow";
import { callOf, originFor } from "@/lib/chat/modality";
import { markOf, moveOf, type MarkedMove, type WhoseMove } from "@/lib/chat/move";
import { ApiError, api, streamTurn, type SpokenDecision, type TurnBody } from "@/lib/client/api";
import { openRequest, reopening } from "@/lib/client/open";
import { stashPendingSend, takePendingSend } from "@/lib/client/pending-send";
import { registerServiceWorker } from "@/lib/client/push";
import { INTRODUCE_SKILL_ID, INTRODUCE_SKILL_NAME } from "@/lib/skills/introduce";
import { SETUP_SKILL_ID, SETUP_SKILL_NAME } from "@/lib/skills/setup";
import { TIDY_SKILL_NAME, tidyRequest, tidySkillId } from "@/lib/skills/tidy";
import type {
  AgentStatus,
  Attachment,
  CallSummary,
  ChatMessage,
  Companion,
  ConversationSummary,
  HomeConversation,
  HomeData,
  Journey as JourneyInfo,
  MemoryProposal,
  MessageFeedback,
  MessageSkill,
  Modality,
  Project,
  ProjectSummary,
  RouteResult,
  ScreenRef,
  SetupSummary,
  StreamEvent,
  UiResponse,
  WorkspaceSkill,
  WorkspaceSummary,
} from "@/lib/types";
import { MEMORY_CATEGORIES } from "@/lib/types";
import { resolvePlace } from "@/lib/voice/places";
import type { RecapCall } from "@/lib/voice/recap";
import { waitsOnMember } from "@/lib/voice/relay";
import { SETUP_JOURNEY_TITLE, type CallPurpose, type CallScreen, type ScreenAction, type ScreenView, type DictationStatus, type VoiceGrant, type VoiceStatus } from "@/lib/voice/types";

/** How long a reply waiting on a request the member's standing OK covers is followed for the run to carry on. */
const GOING_AHEAD_MS = 20_000;
/** When each such request was first seen here, by id. */
/** The calls a page knows of, with the server's latest word on each. */
function mergedCalls(known: CallSummary[] | undefined, latest: CallSummary[] | undefined): CallSummary[] {
  return [...new Map([...(known ?? []), ...(latest ?? [])].map((c) => [c.id, c])).values()];
}

const goingAheadSince = new Map<string, number>();

/**
 * Whether the latest reply waits on a request the member's standing OK covers (`auto`): the run
 * approves it itself and carries on in a moment, so the page follows it rather than stopping.
 * Only for a while: should the run not carry on, the request is theirs to answer.
 */
function goingAhead(messages: ChatMessage[]): boolean {
  const last = messages.at(-1);
  const covered = last?.status === "awaiting" ? last.approvals?.find((a) => a.status === "pending" && a.auto) : undefined;
  if (!covered) return false;
  const since = goingAheadSince.get(covered.id) ?? Date.now();
  goingAheadSince.set(covered.id, since);
  return Date.now() - since < GOING_AHEAD_MS;
}

/** What the composer says while the reply above waits on the member (src/lib/chat/move.ts). */
function composerHint(move: WhoseMove | null): string | undefined {
  if (move?.move !== "your_call") return undefined;
  switch (move.reason) {
    case "approval":
      return "Approve or decline above, or reply to change course";
    case "form":
    case "question":
      return "Answer above, or type your own";
    case "proposal":
      return "Apply what fits above, or reply to change it";
    case "merge":
      return "Merge what fits above, or reply";
    case "browser":
      return "Use the browser card above, or reply";
    default:
      return undefined;
  }
}

/**
 * The journey to show over a thread: the plan of the work in it while it's the work in front of
 * the member. Once they've written since it last changed, a conversation's own finished plan is
 * done with, and any other goes when the reply leaves it as it was (it no longer says what's
 * happening, however its steps read); while that reply runs it may carry the plan on, and a plan
 * it changes shows again. The setup interview's is shown from the setup's own summary instead.
 */
function shownJourney(thread: ThreadState | undefined, running: boolean): JourneyInfo | null {
  const journey = thread?.status === "ready" ? (thread.journey ?? null) : null;
  if (!journey || journey.kind === "setup") return null;
  if (!thread!.messages.some((m) => m.role === "user" && m.createdAt > journey.updatedAt)) return journey;
  const finished = journey.steps.every((s) => s.status === "done");
  return running && !(journey.kind === "conversation" && finished) ? journey : null;
}

/** The setup summary as a journey, for a call about it. */
function setupAsJourney(setup: SetupSummary): JourneyInfo {
  return { kind: "setup", goal: setup.goal, steps: setup.plan, updatedAt: 0 };
}

/**
 * What a message is sent with besides its text, and how (on a call or held to the mic, the member
 * spoke it); on a call, which call (for its recap, once the server has checked it's theirs).
 */
type SendExtras = { skill: MessageSkill | null; attachments: Attachment[]; modality?: Modality; voiceSessionId?: string; screen?: ScreenRef };
const NO_EXTRAS: SendExtras = { skill: null, attachments: [] };

interface ThreadState {
  status: "loading" | "ready" | "missing" | "error";
  /** The newest messages, and as many earlier ones as the member read back to. */
  messages: ChatMessage[];
  /** Whether the server has messages before these. */
  earlier?: boolean;
  /** The plan of the work here, as the server last reported it; null or absent when there's none. */
  journey?: JourneyInfo | null;
  /** The calls messages here were said on, as the server last reported them (for their recaps). */
  calls?: CallSummary[];
}

export interface InitialThread {
  id: string;
  status: "ready" | "missing";
  messages: ChatMessage[];
  earlier: boolean;
  journey: JourneyInfo | null;
  calls: CallSummary[];
}

/** A conversation as the server returned it, for the thread's state. */
const loaded = ({ messages, earlier, journey, calls }: { messages: ChatMessage[]; earlier?: boolean; journey: JourneyInfo | null; calls?: CallSummary[] }): ThreadState => ({
  status: "ready",
  messages,
  earlier: Boolean(earlier),
  journey,
  calls: calls ?? [],
});

/**
 * The conversation's newest page loaded again over what the page has, keeping the earlier messages
 * the member read back to, and the calls they were said on.
 */
const reloaded = (
  before: ThreadState | undefined,
  latest: { messages: ChatMessage[]; earlier?: boolean; journey: JourneyInfo | null; calls?: CallSummary[] },
): ThreadState => {
  const ready = before?.status === "ready" ? before : undefined;
  const kept = keepEarlier(ready, latest);
  // Calls said on the earlier messages kept stay with them.
  return loaded({ ...latest, ...kept, calls: kept.messages.length > latest.messages.length ? mergedCalls(ready?.calls, latest.calls) : (latest.calls ?? []) });
};

/**
 * A voice call in progress: the conversation it's in now (it moves when it follows a task's run,
 * and to whichever chat the member opens while it's docked), when it started here, whether it's
 * the setup interview's, and whether it's docked over the app or full screen.
 */
interface CallState {
  grant: VoiceGrant;
  conversationId: string;
  waitForTap: boolean;
  startedAt: number;
  setup: boolean;
  layout: CallLayout;
}


/**
 * Where a call followed a task's run ("Do the first one now"): the run's conversation, the one
 * it left, the run's first message there, and the task's title. Known only to this tab.
 */
interface CallFollow {
  conversationId: string;
  leftFrom: string;
  firstMessage: string;
  title: string;
}

type ProjectState = { status: "loading" } | { status: "ready"; project: Project } | { status: "missing" } | { status: "error" };

export interface InitialProject {
  id: string;
  project: Project | null;
}

interface Props {
  initialConversations: ConversationSummary[];
  /** Whose move it is in the latest conversations, where it's worth a mark in the sidebar. */
  initialMoves: Record<string, MarkedMove>;
  initialThread: InitialThread | null;
  initialProjects: ProjectSummary[];
  /** The project page being loaded, if any. */
  initialProject: InitialProject | null;
  agent: AgentStatus;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  email: string | null;
  /** The workspace's skills, offered in the composer ("/") and on the new-chat screen. */
  skills: WorkspaceSkill[];
  /** A skill to attach on load (from "Use" on the skills page). */
  initialSkillId: string | null;
  /** The owner's setup interview for this agent; null for other members. */
  setup: SetupSummary | null;
  /** Voice (a preview), when this member has it: voice messages, voice notes, and calls. */
  voice: VoiceStatus | null;
  /** Dictation into the message box (the mic), for every member wherever there's speech to text. */
  dictation: DictationStatus | null;
  /** What the member goes by, for the agent's greeting. */
  member: string | null;
  /** The voice's name, when the member has calls ("it's Rowan"). */
  greeter: string | null;
  /** Who each of the member's agents is to them, by agent id (a preview); null to show none. */
  companions: Record<string, Companion> | null;
  /** Home across their agents (the page at "/" with several), as the server loaded it; null elsewhere. */
  home: HomeData | null;
  /** Home across agents is a preview: off, "/" is the agent's own new-chat screen and nothing names agents. */
  homeEnabled: boolean;
}

const SIDEBAR_KEY = "lj.sidebar-collapsed";
/** Conversations whose moves the sidebar asks about: the most recent ones (the server caps it too). */
const MAX_MOVE_IDS = 100;
/** How often to ask again while a run is going out of view. */
const MOVES_POLL_MS = 20_000;
const WORK_PANEL_KEY = "lj.work-panel";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function conversationIdFrom(pathname: string): string | null {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  return match && UUID.test(match[1]) ? match[1] : null;
}

function projectIdFrom(pathname: string): string | null {
  const match = /^\/p\/([^/]+)\/?$/.exec(pathname);
  return match && UUID.test(match[1]) ? match[1] : null;
}

/** "/tasks" gives "list", "/tasks/<id>" the task's id, anything else null. */
function taskPathFrom(pathname: string): string | null {
  if (/^\/tasks\/?$/.test(pathname)) return "list";
  const match = /^\/tasks\/([^/]+)\/?$/.exec(pathname);
  return match && UUID.test(match[1]) ? match[1] : null;
}

/** "/library" gives "home", "/library/<collection>" that tracker's collection, anything else null. */
function libraryPathFrom(pathname: string): string | null {
  if (/^\/library\/?$/.test(pathname)) return "home";
  const match = /^\/library\/([a-z0-9][a-z0-9_-]{0,39})\/?$/.exec(pathname);
  return match ? match[1] : null;
}

function provisionalTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/**
 * Owns conversation state for the whole workspace: the conversation list, loaded threads,
 * and in-flight runs. Runs live here rather than in the thread view, so a conversation keeps
 * streaming while the user reads or starts another one. What's filled in on the agent's cards
 * lives here too (CardDrafts), shared by the thread and a call's stage.
 */
export function Workspace(props: Props) {
  // Who each agent is to the member, shared with the thread's marks through context.
  const [companions, setCompanions] = useState(props.companions);
  const updateCompanion = useCallback((next: Companion) => setCompanions((all) => (all ? { ...all, [next.workspaceId]: next } : all)), []);
  // Voice notes and voices offered (a proposed setup) play one at a time, but never over a call.
  const [onCall, setOnCall] = useState(false);
  return (
    <CardDraftsProvider>
      <CompanionContext.Provider value={companions?.[props.workspace.id] ?? null}>
        <VoicePlayer voice={props.voice} onCall={onCall}>
          <DictationContext.Provider value={props.dictation}>
            <WorkspaceShell {...props} companions={companions} onCompanion={updateCompanion} onCallChange={setOnCall} />
          </DictationContext.Provider>
        </VoicePlayer>
      </CompanionContext.Provider>
    </CardDraftsProvider>
  );
}

function WorkspaceShell({
  initialConversations,
  initialMoves,
  initialThread,
  initialProjects,
  initialProject,
  agent,
  workspace,
  workspaces: initialWorkspaces,
  email,
  skills,
  initialSkillId,
  setup: initialSetup,
  voice,
  member,
  greeter,
  companions,
  home: initialHome,
  homeEnabled,
  onCompanion,
  onCallChange,
}: Props & { onCompanion: (companion: Companion) => void; onCallChange: (live: boolean) => void }) {
  // Navigation is client-side history only. The path lives in local state so a switch
  // renders immediately (Next applies pushState-driven pathname updates as a transition).
  const [pathname, setPathname] = useState(usePathname());
  const activeId = conversationIdFrom(pathname);
  /** The project page on screen (not the project of an open conversation). */
  const activeProjectId = activeId ? null : projectIdFrom(pathname);
  /** The Tasks page on screen: "list", or the id of the open task. */
  const activeTask = taskPathFrom(pathname);
  /** The Library on screen: "home", or the collection of the open tracker. */
  const libraryPath = libraryPathFrom(pathname);
  const libraryActive = libraryPath !== null;
  const [taskTitle, setTaskTitle] = useState<string | null>(null);
  // The member's agents, and which are on Home ("Put it on Home" on a draft's screen updates it here).
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  /** Several agents, with the Home preview on: Home takes "/", and every chat names its agent. */
  const several = homeEnabled && workspaces.length > 1;
  /** Home across agents: "/" with several agents. With one, "/" is that agent's own new-chat screen. */
  const atHome = several && /^\/?$/.test(pathname);
  /** The agent's own new-chat screen: "/new", or "/" with one agent. */
  const atNew = !atHome && /^\/(new\/?)?$/.test(pathname);

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const [conversations, setConversations] = useState(initialConversations);
  const [threads, setThreads] = useState<Record<string, ThreadState>>(() =>
    initialThread
      ? { [initialThread.id]: { status: initialThread.status, messages: initialThread.messages, earlier: initialThread.earlier, journey: initialThread.journey, calls: initialThread.calls } }
      : {},
  );
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const [projects, setProjects] = useState(initialProjects);
  const [projectDetails, setProjectDetails] = useState<Record<string, ProjectState>>(() =>
    initialProject
      ? { [initialProject.id]: initialProject.project ? { status: "ready", project: initialProject.project } : { status: "missing" } }
      : {},
  );
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
  /** Whose move it is in conversations this tab isn't running or showing, as the server last said. */
  const [serverMoves, setServerMoves] = useState(initialMoves);
  // The owner's setup interview (null for other members); see "The agent's setup interview" below.
  const [setup, setSetup] = useState(initialSetup);
  const [sendCount, setSendCount] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** Whether the Results panel is open, and which reply to bring into view in it. */
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelFocus, setPanelFocus] = useState<string | null>(null);
  const panelAuto = useRef(true);

  const controllers = useRef(new Map<string, AbortController>());
  /** Who's listening to runs' events as they stream (a call narrating progress). */
  const streamListeners = useRef(new Set<(conversationId: string, event: StreamEvent) => void>());
  /** Replies whose start the listeners have heard, streamed here or followed from the server. */
  const announced = useRef(new Set<string>());
  /**
   * For a run this tab isn't streaming: what changed between two loads of its conversation, told
   * to the listeners as the stream would have (src/lib/chat/follow.ts), so a call narrating it
   * hears its steps and its end.
   */
  const tell = useCallback((conversationId: string, events: StreamEvent[]) => {
    for (const event of events) {
      if (event.type === "start") announced.current.add(event.assistantMessage.id);
      for (const listener of streamListeners.current) listener(conversationId, event);
    }
  }, []);
  const tellFollowed = useCallback(
    (conversationId: string, before: ChatMessage[], after: ChatMessage[], conversation: ConversationSummary) => {
      if (streamListeners.current.size) tell(conversationId, followEvents(before, after, conversation, announced.current));
    },
    [tell],
  );
  const subscribe = useCallback((listener: (conversationId: string, event: StreamEvent) => void) => {
    streamListeners.current.add(listener);
    return () => {
      streamListeners.current.delete(listener);
    };
  }, []);
  /** A voice call in progress, and the conversation it's in. */
  const [call, setCall] = useState<CallState | null>(null);
  const callRef = useRef(call);
  callRef.current = call;
  /** Calls on this page, as this tab knows them: when each started and (once hung up) ended, before the server says. */
  const [localCalls, setLocalCalls] = useState<Record<string, CallSummary>>({});
  /** Where each call on this page followed a task's run, by call, for their recaps. */
  const [follows, setFollows] = useState<Record<string, CallFollow[]>>({});
  /** A call that just followed a task's run into its conversation, until that conversation's first copy is in. */
  const callMovedInto = useRef<{ conversationId: string; sessionId: string; from: string } | null>(null);
  /**
   * The first copy of a conversation a call just followed a task's run into: the call hears the
   * run from its start (it may be over already: one that failed at once, or reached an approval
   * first, which no follower would see go), and the recaps know where the call went. The run
   * started before its conversation loaded, so it's the latest reply there.
   */
  const callArrived = useCallback(
    (id: string, latest: { messages: ChatMessage[]; conversation: ConversationSummary }) => {
      const moved = callMovedInto.current;
      if (moved?.conversationId !== id) return;
      callMovedInto.current = null;
      const at = latest.messages.findLastIndex((m) => m.role === "assistant");
      if (at < 0) return;
      const brief = latest.messages[at - 1]?.role === "user" ? latest.messages[at - 1] : latest.messages[at];
      const title = brief.origin?.kind === "task" ? brief.origin.title : latest.conversation.title;
      const follow: CallFollow = { conversationId: id, leftFrom: moved.from, firstMessage: brief.id, title };
      setFollows((all) => ({ ...all, [moved.sessionId]: [...(all[moved.sessionId] ?? []), follow] }));
      if (callRef.current?.conversationId === id && !controllers.current.has(id)) tell(id, joinedEvents(latest.messages, latest.conversation, announced.current));
    },
    [tell],
  );
  const callLive = Boolean(call);
  useEffect(() => onCallChange(callLive), [callLive, onCallChange]);
  /** Where a docked call goes in the layout, under the header. */
  const [dock, setDock] = useState<HTMLElement | null>(null);
  /** The buttons the page on screen offers a call ("pause it"), as that page registered them. */
  const [buttons, setButtons] = useState<ScreenButtons | null>(null);
  const buttonsRef = useRef(buttons);
  buttonsRef.current = buttons;
  const [calling, setCalling] = useState(false);
  const [callNotice, setCallNotice] = useState<string | null>(null);
  // The call couldn't start for a reason the mic doesn't share (not today's voice time, which it charges too).
  const [micInstead, setMicInstead] = useState(false);
  // Streams this tab let go of while the run kept going on the server (the app was hidden).
  const detached = useRef(new WeakSet<AbortController>());
  // Streams whose run the server has taken (its "start" arrived), so its copy has the message.
  const confirmed = useRef(new WeakSet<AbortController>());
  /** Sends that never reached the server, keyed by placeholder id, so Retry can resend them. */
  const unsent = useRef(new Map<string, { text: string; extras: SendExtras }>());
  /** What each pending reply's message was sent with, keyed by its placeholder id. */
  const sentExtras = useRef(new Map<string, SendExtras>());
  /** A short explanation when the server turned an action down. */
  const [notice, setNotice] = useState<string | null>(null);
  const drafts = useRef(new Map<string, string>());
  const composer = useRef<ComposerHandle>(null);
  /** Whether files are being dragged over the chat; nested enter/leave events are counted. */
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const search = useRef<HTMLInputElement>(null);

  const desktop = useMedia("(min-width: 768px)", true);
  const keyboardHeight = useKeyboardHeight();
  const [mod, setMod] = useState("Ctrl+");
  useEffect(() => setMod(isMac() ? "⌘" : "Ctrl+"), []);

  // A file dropped outside the chat would otherwise open in the tab and lose the page.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const reset = () => {
      dragDepth.current = 0;
      setDropping(false);
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, []);

  /** Files can be dropped while a composer is on screen and the agent can read them. */
  const acceptsDrop = (e: React.DragEvent) => agent.attachments && composer.current !== null && e.dataTransfer.types.includes("Files");

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
      .then((latest) => {
        setThreads((all) => ({ ...all, [activeId]: loaded(latest) }));
        callArrived(activeId, latest);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status = error instanceof ApiError && error.status === 404 ? "missing" : "error";
        // Not this agent's chat: with several agents it may be another's (a push tapped while this
        // window was open). One full load renders it under the agent that owns it, or says it's gone.
        if (status === "missing" && several && !reloadedFor.current.has(activeId)) {
          reloadedFor.current.add(activeId);
          window.location.assign(`/c/${activeId}`);
          return;
        }
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
  }, [activeId, callArrived, several]);
  const reloadedFor = useRef(new Set<string>());

  // Earlier messages, a page at a time, as the member reads back.
  const loadingEarlier = useRef<string | null>(null);
  const loadEarlier = useCallback(async () => {
    const id = activeId;
    const thread = id ? threadsRef.current[id] : undefined;
    const first = thread?.status === "ready" && thread.earlier ? thread.messages.find((m) => !m.id.startsWith("pending-")) : undefined;
    if (!id || !first || loadingEarlier.current === id) return;
    loadingEarlier.current = id;
    try {
      const page = await api.earlierMessages(id, first.id);
      setThreads((all) => {
        const now = all[id];
        // Only onto the thread it was asked for, while it still starts there.
        if (now?.status !== "ready" || now.messages[0]?.id !== first.id) return all;
        return { ...all, [id]: { ...now, messages: [...page.messages, ...now.messages], earlier: page.earlier, calls: mergedCalls(page.calls, now.calls) } };
      });
    } catch {
      // The button stays, to try again.
    } finally {
      loadingEarlier.current = null;
    }
  }, [activeId]);

  const activeConversation = useMemo(() => (activeId ? conversations.find((c) => c.id === activeId) : undefined), [activeId, conversations]);
  const activeTitle = activeConversation?.title;
  /** The project the open conversation is in, for the header. */
  const conversationProject = activeConversation?.projectId ? projects.find((p) => p.id === activeConversation.projectId) : undefined;

  // Load a project page that isn't in memory.
  const activeProject = activeProjectId ? projectDetails[activeProjectId] : undefined;
  const projectDetailsRef = useRef(projectDetails);
  projectDetailsRef.current = projectDetails;
  useEffect(() => {
    if (!activeProjectId) return;
    const existing = projectDetailsRef.current[activeProjectId];
    if (existing && existing.status !== "error") return;
    const controller = new AbortController();
    setProjectDetails((all) => ({ ...all, [activeProjectId]: { status: "loading" } }));
    api
      .getProject(activeProjectId, controller.signal)
      .then(({ project }) => setProjectDetails((all) => ({ ...all, [activeProjectId]: { status: "ready", project } })))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status = error instanceof ApiError && error.status === 404 ? "missing" : "error";
        setProjectDetails((all) => ({ ...all, [activeProjectId]: { status } }));
      });
    return () => {
      controller.abort();
      setProjectDetails((all) => {
        if (all[activeProjectId]?.status !== "loading") return all;
        const { [activeProjectId]: _, ...rest } = all;
        return rest;
      });
    };
  }, [activeProjectId]);

  const activeProjectName = activeProject?.status === "ready" ? activeProject.project.name : undefined;
  const tasksTitle = activeTask === "list" ? "Tasks" : activeTask ? (taskTitle ?? undefined) : undefined;
  useEffect(() => {
    const title = activeTitle ?? activeProjectName ?? tasksTitle ?? (libraryPath === "home" ? "Library" : libraryPath ? collectionName(libraryPath) : undefined);
    document.title = title ? `${title} · Studio` : atHome ? "Studio" : `${workspace.name} · Studio`;
  }, [activeTitle, activeProjectName, tasksTitle, libraryPath, workspace.name, atHome]);

  /**
   * Opens a task's conversation (or one a notification is about). A run may have just created it
   * or added to it on the server, so the copy loaded earlier is loaded again (src/lib/client/open.ts)
   * and the conversation list refreshed.
   */
  const openTaskConversation = useCallback(
    (conversationId: string) => {
      const how = reopening(conversationId, { onScreen: conversationIdFrom(window.location.pathname), streaming: controllers.current.has(conversationId) });
      if (how === "drop") {
        setThreads((all) => {
          if (!all[conversationId]) return all;
          const { [conversationId]: _, ...rest } = all;
          return rest;
        });
      } else if (how === "refresh") {
        // Going where the page already is loads nothing, so it's loaded here, keeping what's on
        // screen until the new copy is in.
        api
          .getConversation(conversationId)
          .then((latest) => {
            if (controllers.current.has(conversationId)) return;
            setThreads((all) => ({ ...all, [conversationId]: reloaded(all[conversationId], latest) }));
            callArrived(conversationId, latest);
          })
          .catch(() => undefined);
      }
      navigate(`/c/${conversationId}`);
      api
        .listConversations()
        .then(({ conversations }) => setConversations(conversations))
        .catch(() => undefined);
    },
    [callArrived, navigate],
  );

  /**
   * A task's run started from a card in `from` (the first win after setup): run it, then follow it
   * there. A call in `from` (the card is on its stage) follows it too, and narrates the run.
   */
  const runTaskNow = useCallback(
    async (taskId: string, from: string | null) => {
      const { conversationId } = await api.runTask(taskId);
      const following = callRef.current;
      if (following && from && following.conversationId === from && conversationId !== from) {
        callMovedInto.current = { conversationId, sessionId: following.grant.sessionId, from };
      }
      setCall((current) => (current && current.conversationId === from ? { ...current, conversationId, setup: false } : current));
      openTaskConversation(conversationId);
    },
    [openTaskConversation],
  );

  // ---------------------------------------------------------------------------------------
  // Running turns

  const runTurn = useCallback(
    async (conversationId: string, body: TurnBody, placeholderIds: { user?: string; assistant: string }) => {
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
        if (event.type === "start") announced.current.add(event.assistantMessage.id);
        for (const listener of streamListeners.current) listener(conversationId, event);
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
            confirmed.current.add(controller);
            // Hidden before the server took it: let go now that its copy has the message.
            if (detached.current.has(controller)) controller.abort();
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
          case "approval":
            patchMessage(conversationId, assistantId, (m) => ({ ...m, approvals: [...(m.approvals ?? []), event.approval] }));
            break;
          case "memory-proposal":
            patchMessage(conversationId, assistantId, (m) => {
              const list = m.memoryProposals ?? [];
              const known = list.some((p) => p.id === event.proposal.id);
              return { ...m, memoryProposals: known ? list.map((p) => (p.id === event.proposal.id ? event.proposal : p)) : [...list, event.proposal] };
            });
            break;
          case "timeline":
            patchMessage(conversationId, assistantId, (m) => ({ ...m, timeline: event.timeline }));
            break;
          case "citations":
            patchMessage(conversationId, assistantId, (m) => ({ ...m, citations: event.citations }));
            break;
          case "questions":
            patchMessage(conversationId, assistantId, (m) => ({ ...m, questions: event.questions }));
            break;
          case "ui":
            patchMessage(conversationId, assistantId, (m) => ({ ...m, ui: event.ui }));
            break;
          case "file":
            patchMessage(conversationId, assistantId, (m) =>
              (m.attachments ?? []).some((a) => a.id === event.attachment.id) ? m : { ...m, attachments: [...(m.attachments ?? []), event.attachment] },
            );
            break;
          case "journey": {
            const { journey } = event;
            setThreads((all) => (all[conversationId] ? { ...all, [conversationId]: { ...all[conversationId], journey } } : all));
            // The setup's rail (the banner, the call) fills in as the agent goes too.
            if (journey.kind === "setup") {
              setSetup((current) =>
                current
                  ? {
                      ...current,
                      conversationId: current.conversationId ?? conversationId,
                      plan: journey.steps,
                      goal: journey.goal,
                      done: journey.steps.filter((s) => s.status === "done").length,
                      total: journey.steps.length,
                    }
                  : current,
              );
            }
            break;
          }
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
        // The app was hidden (or the connection dropped) after the server took the run: it keeps
        // going there. Show what the server has; a reply still running is followed until it ends.
        if (detached.current.has(controller) || (started && !controller.signal.aborted && !(error instanceof ApiError))) {
          const latest = await api.getConversation(conversationId).catch(() => null);
          if (latest) {
            const before = threadsRef.current[conversationId]?.messages ?? [];
            setThreads((all) => ({ ...all, [conversationId]: reloaded(all[conversationId], latest) }));
            upsertConversation(latest.conversation);
            // A call narrating it hears what happened meanwhile (and the end, if it's over).
            tellFollowed(conversationId, before, latest.messages, latest.conversation);
            return;
          }
          if (started) return;
        }
        const aborted = controller.signal.aborted;
        if (!started && (body.kind === "decide" || body.kind === "edit" || body.kind === "continue") && error instanceof ApiError) {
          // The server refused (e.g. already answered, or carried on, elsewhere): show its state, not
          // a guess. A job the background worker carried on first is followed from there.
          await api
            .getConversation(conversationId)
            .then((latest) => setThreads((all) => ({ ...all, [conversationId]: reloaded(all[conversationId], latest) })))
            .catch(() => undefined);
          if (body.kind !== "continue") setNotice(error.message);
          return;
        }
        if (!started && body.kind === "send") {
          unsent.current.set(assistantId, { text: body.text, extras: sentExtras.current.get(assistantId) ?? { skill: null, attachments: [] } });
        }
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
                      : "Couldn't reach Studio. Check your connection and try again.",
                },
        );
      } finally {
        // A redirect may have started the next run here already; that one owns the state.
        if (controllers.current.get(conversationId) === controller) {
          controllers.current.delete(conversationId);
          setRunState(conversationId, false);
        }
      }
    },
    [patchMessage, patchMessages, setRunState, skills, tellFollowed, upsertConversation],
  );

  const sendTo = useCallback(
    (conversationId: string, text: string, isNew: boolean, extras: SendExtras = NO_EXTRAS, steer = false, projectId: string | null = null) => {
      const { skill, attachments } = extras;
      const now = Date.now();
      const base = { conversationId, activity: [], artifacts: [], createdAt: now };
      // Labeled at once the way the server will label it ("Voice message", "On a call").
      const origin = originFor(extras.modality, text, extras.voiceSessionId);
      const user: ChatMessage = { ...base, id: `pending-user-${now}`, role: "user", content: text, status: "complete", skill, attachments, ...(origin ? { origin } : {}) };
      const assistant: ChatMessage = {
        ...base,
        id: `pending-assistant-${now}`,
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: now + 1,
      };
      setThreads((all) => {
        let messages = all[conversationId]?.messages ?? [];
        // Writing instead of answering the agent's request declines it.
        if (steer && messages.at(-1)?.status === "awaiting") {
          const paused = messages.at(-1)!;
          messages = [
            ...messages.slice(0, -1),
            { ...paused, status: "stopped", approvals: paused.approvals?.map((a) => (a.status === "pending" ? { ...a, status: "declined" } : a)) },
          ];
        }
        return { ...all, [conversationId]: { ...all[conversationId], status: "ready", messages: [...messages, user, assistant] } };
      });
      setConversations((list) => {
        const existing = list.find((c) => c.id === conversationId);
        const summary = existing
          ? { ...existing, updatedAt: now }
          : {
              id: conversationId,
              title: provisionalTitle(skill ? [skill.name, text].filter(Boolean).join(" — ") : text),
              projectId,
              createdAt: now,
              updatedAt: now,
            };
        return [summary, ...list.filter((c) => c.id !== conversationId)];
      });
      if (isNew) navigate(`/c/${conversationId}`);
      setSendCount((n) => n + 1);
      setNotice(null);
      sentExtras.current.set(assistant.id, extras);
      const attachmentIds = attachments.map((a) => a.id);
      void runTurn(
        conversationId,
        {
          kind: "send",
          text,
          skillId: skill?.id,
          ...(attachmentIds.length ? { attachmentIds } : {}),
          ...(steer ? { steer } : {}),
          ...(extras.modality ? { modality: extras.modality } : {}),
          ...(extras.voiceSessionId ? { voiceSessionId: extras.voiceSessionId } : {}),
          ...(extras.screen ? { screen: extras.screen } : {}),
          // Only creates it there; the server ignores it for a conversation that already exists.
          ...(projectId ? { projectId } : {}),
        },
        { user: user.id, assistant: assistant.id },
      );
    },
    [navigate, runTurn],
  );

  // ---------------------------------------------------------------------------------------
  // Home: one place to ask across the member's agents (src/lib/route.ts decides which takes it).

  /** What Home shows across agents, kept fresh while it's on screen. */
  const [homeData, setHomeData] = useState<HomeData | null>(initialHome);
  const refreshHome = useCallback(() => {
    api.home().then(setHomeData, () => undefined);
  }, []);
  // What the server rendered is fresh; later arrivals on Home ask again.
  const homeFresh = useRef(initialHome !== null);
  useEffect(() => {
    if (!atHome) return;
    if (homeFresh.current) homeFresh.current = false;
    else refreshHome();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshHome();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [atHome, refreshHome]);
  const homeWorking = atHome && Object.values(homeData?.moves ?? {}).includes("working");
  useEffect(() => {
    if (!homeWorking) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshHome();
    }, MOVES_POLL_MS);
    return () => clearInterval(timer);
  }, [homeWorking, refreshHome]);

  const [routing, setRouting] = useState(false);
  /** Home wasn't sure who should take the ask: the text stays, and the likeliest agent is held up to confirm. */
  const [homeAsk, setHomeAsk] = useState<{ text: string; suggested: string } | null>(null);
  const [homeNotice, setHomeNotice] = useState<string | null>(null);
  /** A chat Home sent to an agent, for the "Sent to …" line under its first reply. */
  const [routed, setRouted] = useState<{ conversationId: string; workspaceId: string } | null>(null);

  /**
   * Sends an ask to another agent than this tab's: the ask waits for that agent's own new-chat
   * screen, which sends it there as if it had been typed there (one page load; the agent becomes
   * the one new tabs open on).
   */
  const sendElsewhere = useCallback(async (workspaceId: string, text: string, by: RouteResult["by"], sure: boolean) => {
    const conversationId = crypto.randomUUID();
    if (!stashPendingSend({ workspaceId, conversationId, text, routed: { sure, by } })) {
      setHomeNotice("Couldn't hand that to the other agent from here. Pick it in the agent menu and send again.");
      return;
    }
    try {
      await api.setActiveAgent(workspaceId);
    } catch {
      takePendingSend(workspaceId);
      setHomeNotice("Couldn't reach that agent. Try again.");
      return;
    }
    window.location.assign("/new");
  }, []);

  /** An ask from Home: to the agent the member picked, else to whichever fits; when that isn't clear, Home asks. */
  const sendFromHome = useCallback(
    async (text: string, pick: string | null) => {
      const trimmed = text.trim();
      if (!trimmed || routing) return;
      setHomeNotice(null);
      const onHome = (id: string) => workspaces.some((w) => w.id === id && w.onHome);
      const fallback = onHome(workspace.id) ? workspace.id : (workspaces.find((w) => w.onHome)?.id ?? workspace.id);
      let target: RouteResult;
      if (pick && onHome(pick)) {
        target = { workspaceId: pick, sure: true, by: "last" };
      } else if (!workspaces.some((w) => w.onHome)) {
        // Nothing on Home to choose between: the ask goes to this agent, as the hint says.
        target = { workspaceId: workspace.id, sure: true, by: "last" };
      } else {
        setRouting(true);
        try {
          target = await api.route(trimmed);
        } catch {
          target = { workspaceId: fallback, sure: false, by: "last" };
        } finally {
          setRouting(false);
        }
        if (!onHome(target.workspaceId)) target = { workspaceId: fallback, sure: false, by: "last" };
        if (!target.sure) {
          setHomeAsk({ text: trimmed, suggested: target.workspaceId });
          return;
        }
      }
      setHomeAsk(null);
      drafts.current.delete("home");
      if (target.workspaceId === workspace.id) {
        const conversationId = crypto.randomUUID();
        setRouted({ conversationId, workspaceId: workspace.id });
        sendTo(conversationId, trimmed, true);
        return;
      }
      await sendElsewhere(target.workspaceId, trimmed, target.by, target.sure);
    },
    [routing, workspace.id, workspaces, sendTo, sendElsewhere],
  );

  /** "Ask another agent instead": the same first message, as a new chat with that agent (a chat never moves). */
  const askAnother = useCallback(
    (workspaceId: string) => {
      if (!activeId) return;
      const first = threadsRef.current[activeId]?.messages.find((m) => m.role === "user")?.content ?? "";
      if (first.trim()) void sendElsewhere(workspaceId, first, "last", true);
    },
    [activeId, sendElsewhere],
  );

  /** The owner puts a draft agent on Home from its own new-chat screen. */
  const putOnHome = useCallback(() => {
    api.setOnHome(true).then(
      () => setWorkspaces((list) => list.map((w) => (w.id === workspace.id ? { ...w, onHome: true } : w))),
      () => undefined,
    );
  }, [workspace.id]);

  /** A chat on Home: this agent's opens in place (another agent's is a link, loaded under that agent). */
  const openFromHome = useCallback((conversation: HomeConversation) => navigate(`/c/${conversation.id}`), [navigate]);

  const send = useCallback(
    (text: string, extras: Partial<SendExtras> = {}) => {
      const full: SendExtras = { skill: extras.skill ?? null, attachments: extras.attachments ?? [], ...(extras.modality ? { modality: extras.modality } : {}) };
      if (activeId) {
        // Sending while the agent works (or waits for an approval) redirects it.
        const awaitingHere = threadsRef.current[activeId]?.messages.at(-1)?.status === "awaiting";
        drafts.current.delete(activeId);
        // Once the member carries on here, the chat is theirs with this agent; the "Sent to" line has done its job.
        setRouted((r) => (r?.conversationId === activeId ? null : r));
        sendTo(activeId, text, false, full, running.has(activeId) || awaitingHere);
      } else {
        drafts.current.delete(activeProjectId ? `project:${activeProjectId}` : "new");
        sendTo(crypto.randomUUID(), text, true, full, false, activeProjectId);
      }
    },
    [activeId, activeProjectId, running, sendTo],
  );

  /**
   * Answers the agent's pending request in `conversationId` (the open one, or a call's) and
   * continues the same reply. `spoken`: said on a call, with the words the member was heard to
   * say; the server checks them and refuses what doesn't hold up (the request comes back).
   * `always`: a tapped approval that also OKs its kind for good on this conversation's task.
   */
  const decide = useCallback(
    (conversationId: string, approvalId: string, decision: "approve" | "reject", spoken?: SpokenDecision, always?: boolean) => {
      if (running.has(conversationId)) return;
      const reply = threadsRef.current[conversationId]?.messages.find((m) => m.approvals?.some((a) => a.id === approvalId));
      if (!reply) return;
      setNotice(null);
      patchMessage(conversationId, reply.id, (m) => ({
        ...m,
        status: "streaming",
        approvals: m.approvals?.map((a) =>
          a.id === approvalId
            ? { ...a, status: decision === "approve" ? "approved" : "declined", decidedVia: spoken ? "voice" : "tap", ...(spoken ? { decidedWords: spoken.heard } : {}) }
            : a,
        ),
      }));
      const body: TurnBody = spoken
        ? { kind: "decide", approvalId, decision, ...spoken }
        : { kind: "decide", approvalId, decision, ...(always && decision === "approve" ? { always: true as const } : {}) };
      void runTurn(conversationId, body, { assistant: reply.id });
    },
    [patchMessage, runTurn, running],
  );

  /** Replaces the latest message and answers it again. */
  const edit = useCallback(
    (messageId: string, text: string) => {
      if (!activeId || running.has(activeId)) return;
      const conversationId = activeId;
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
      setNotice(null);
      patchMessages(conversationId, (messages) => {
        const index = messages.findIndex((m) => m.id === messageId);
        if (index < 0) return messages;
        return [...messages.slice(0, index), { ...messages[index], content: text }, assistant];
      });
      setSendCount((n) => n + 1);
      void runTurn(conversationId, { kind: "edit", messageId, text }, { user: messageId, assistant: assistant.id });
    },
    [activeId, patchMessages, runTurn, running],
  );

  /** Undoes a memory the agent saved, or saves or dismisses one that wasn't saved. */
  const answerProposal = useCallback(
    (messageId: string, proposalId: string, decision: "save" | "dismiss" | "undo") => {
      if (!activeId) return;
      const conversationId = activeId;
      const previous = threadsRef.current[conversationId]?.messages.find((m) => m.id === messageId)?.memoryProposals?.find((p) => p.id === proposalId);
      if (!previous) return;
      const put = (proposal: MemoryProposal) =>
        patchMessage(conversationId, messageId, (m) => ({
          ...m,
          memoryProposals: m.memoryProposals?.map((p) => (p.id === proposalId ? proposal : p)),
        }));
      put({ ...previous, status: decision === "save" ? "saved" : "dismissed" });
      api
        .decideProposal(conversationId, proposalId, decision)
        .then(({ proposal }) => put(proposal))
        .catch((error: unknown) => {
          put(previous);
          setNotice(error instanceof ApiError ? error.message : "Couldn't update memory. Try again.");
        });
    },
    [activeId, patchMessage],
  );

  /** Keeps a card in `conversationId` (the open one, or a call's) answered or applied once the server has saved what the member did. */
  const recordUiResponse = useCallback(
    (conversationId: string, messageId: string, blockId: string, response: UiResponse) => {
      patchMessage(conversationId, messageId, (m) => ({ ...m, uiResponse: { ...(m.uiResponse ?? {}), [blockId]: response } }));
      // Applying the proposed setup can finish the setup interview, keeping a name is how the
      // agent arrives, and a name or sound kept changes how it talks with them. (Choosing whether
      // to run the first task now, after, changes neither.)
      if (response.status !== "applied" || response.firstRun) return;
      api.getSetup().then(({ setup }) => setSetup(setup), () => undefined);
      if (response.applied.name || response.applied.manner !== undefined) {
        api.getCompanion().then(({ companion: next }) => next && onCompanion(next), () => undefined);
      }
    },
    [patchMessage, onCompanion],
  );

  /** Rates a reply right away; puts the old rating back if saving fails. */
  const rateMessage = useCallback(
    (messageId: string, feedback: MessageFeedback | null) => {
      if (!activeId) return;
      const conversationId = activeId;
      const previous = threadsRef.current[conversationId]?.messages.find((m) => m.id === messageId)?.feedback ?? null;
      const put = (value: MessageFeedback | null) => patchMessage(conversationId, messageId, (m) => ({ ...m, feedback: value }));
      put(feedback);
      api.rateMessage(conversationId, messageId, feedback).catch((error: unknown) => {
        put(previous);
        setNotice(error instanceof ApiError ? error.message : "Couldn't save your feedback. Try again.");
      });
    },
    [activeId, patchMessage],
  );

  /** Answers the latest message in `conversationId` (the open one, or a call's) again. */
  const retry = useCallback(
    (conversationId: string, messageId: string) => {
      if (running.has(conversationId)) return;
      const unsentSend = unsent.current.get(messageId);
      if (unsentSend !== undefined) {
        // The original send never reached the server: drop both placeholders and resend.
        unsent.current.delete(messageId);
        patchMessages(conversationId, (messages) => {
          const index = messages.findIndex((m) => m.id === messageId);
          return index > 0 ? messages.slice(0, index - 1) : messages.filter((m) => m.id !== messageId);
        });
        const projectId = conversationsRef.current.find((c) => c.id === conversationId)?.projectId ?? null;
        sendTo(conversationId, unsentSend.text, false, unsentSend.extras, false, projectId);
        return;
      }
      setNotice(null);
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
    [patchMessages, runTurn, running, sendTo],
  );

  // A reply that ran out of time with the job unfinished, and nothing asked of the member, says
  // so (keepGoing): while it's the latest message here, the next reply starts by itself, as a
  // new request with its own time. Each reply once per tab; the server caps how many in a row,
  // and anything the member sends or stops ends it. With no tab open, the background worker
  // carries it on instead; whichever starts first takes it.
  const continuedFrom = useRef(new Set<string>());
  // Looked at again when the tab comes back into view: a reply that ended while it was hidden
  // carries on then, rather than waiting for something else to change.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const onShow = () => document.visibilityState === "visible" && setShown((n) => n + 1);
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, []);
  useEffect(() => {
    if (document.visibilityState !== "visible") return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const [conversationId, thread] of Object.entries(threads)) {
      const last = thread.status === "ready" ? thread.messages.at(-1) : undefined;
      if (!last?.keepGoing || (last.status !== "complete" && last.status !== "error") || last.role !== "assistant") continue;
      if (running.has(conversationId) || controllers.current.has(conversationId) || continuedFrom.current.has(last.id)) continue;
      timers.push(
        setTimeout(() => {
          if (threadsRef.current[conversationId]?.messages.at(-1)?.id !== last.id || controllers.current.has(conversationId)) return;
          continuedFrom.current.add(last.id);
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
          patchMessages(conversationId, (messages) => [...messages, assistant]);
          void runTurn(conversationId, { kind: "continue" }, { assistant: assistant.id });
        }, 800),
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [threads, running, patchMessages, runTurn, shown]);

  // Stopping is a request to the server: closing the tab doesn't stop the agent, Stop does.
  const stop = useCallback((conversationId: string) => {
    api.stopRun(conversationId).catch(() => controllers.current.get(conversationId)?.abort());
  }, []);

  // The open conversation's own handlers, for the thread and its message box.
  const decideHere = useCallback(
    (approvalId: string, decision: "approve" | "reject", always?: boolean) => activeId && decide(activeId, approvalId, decision, undefined, always),
    [activeId, decide],
  );
  const recordHere = useCallback(
    (messageId: string, blockId: string, response: UiResponse) => activeId && recordUiResponse(activeId, messageId, blockId, response),
    [activeId, recordUiResponse],
  );
  const retryHere = useCallback((messageId: string) => activeId && retry(activeId, messageId), [activeId, retry]);
  const stopHere = useCallback(() => activeId && stop(activeId), [activeId, stop]);
  const runTaskHere = useCallback((taskId: string) => runTaskNow(taskId, activeId), [activeId, runTaskNow]);

  // The service worker shows notifications on devices where the member turned them on.
  useEffect(() => {
    void registerServiceWorker();
  }, []);

  // When the app is hidden (phone locked, app switched), let go of open streams. The runs
  // keep going on the server, which notifies the member when one ends while they're away;
  // coming back follows them from the saved state. A run the server hasn't taken yet is let go
  // of once it has: its saved state could still be missing the message, and nothing would follow it.
  useEffect(() => {
    const onVisibility = () => {
      const hidden = document.visibilityState === "hidden";
      for (const controller of controllers.current.values()) {
        if (controller.signal.aborted) continue;
        if (!hidden) {
          detached.current.delete(controller);
          continue;
        }
        detached.current.add(controller);
        if (confirmed.current.has(controller)) controller.abort();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Follow a run this tab didn't start (e.g. after a reload, or a task's run) until it finishes:
  // in the open conversation, and in a call's when that's elsewhere. A call narrating it hears
  // what each load changed, as if it streamed here, from the start of a reply no one announced.
  const followRemote = useCallback(
    (id: string) => {
      let cancelled = false;
      setRunState(id, true);
      const tick = async () => {
        while (!cancelled) {
          await new Promise((r) => setTimeout(r, 1500));
          if (cancelled || controllers.current.has(id)) return;
          if (document.visibilityState === "hidden") continue;
          try {
            // Only what changed since the page's last message, not the whole conversation each time.
            const current = threadsRef.current[id];
            const from = followAnchor(current?.messages ?? []);
            const latest = from ? await api.latestMessages(id, from) : { ...(await api.getConversation(id)), reset: true as const };
            if (cancelled || controllers.current.has(id)) return;
            const before = threadsRef.current[id]?.messages ?? [];
            const merged = latest.reset || !from ? null : mergeSince(before, latest.messages, from);
            const next: ThreadState = merged
              ? { ...(threadsRef.current[id] ?? loaded(latest)), status: "ready", messages: merged, journey: latest.journey, calls: mergedCalls(threadsRef.current[id]?.calls, latest.calls) }
              : reloaded(threadsRef.current[id], latest);
            setThreads((all) => ({ ...all, [id]: next }));
            tellFollowed(id, before, next.messages, latest.conversation);
            if (!next.messages.some((m) => m.status === "streaming") && !goingAhead(next.messages)) {
              upsertConversation(latest.conversation);
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
    },
    [setRunState, tellFollowed, upsertConversation],
  );
  const remotelyRunning = (thread: ThreadState | undefined, id: string | null | undefined) =>
    Boolean(
      id &&
        thread?.status === "ready" &&
        (thread.messages.some((m) => m.status === "streaming") || goingAhead(thread.messages)) &&
        !controllers.current.has(id),
    );
  const followingRemote = remotelyRunning(activeThread, activeId);
  useEffect(() => {
    if (!activeId || !followingRemote) return;
    return followRemote(activeId);
  }, [activeId, followingRemote, followRemote]);
  const callElsewhere = call && call.conversationId !== activeId ? call.conversationId : null;
  const followingCall = remotelyRunning(callElsewhere ? threads[callElsewhere] : undefined, callElsewhere);
  useEffect(() => {
    if (!callElsewhere || !followingCall) return;
    return followRemote(callElsewhere);
  }, [callElsewhere, followingCall, followRemote]);

  // ---------------------------------------------------------------------------------------
  // Conversation management

  // A new chat with this agent: its own screen (/new) where Home has taken "/".
  const newChat = useCallback(() => {
    navigate(several ? "/new" : "/");
    requestAnimationFrame(() => composer.current?.focus());
  }, [navigate, several]);

  // The agent's setup interview: picks up where it left off, or starts it in a new chat with
  // the setup skill attached (the agent opens with its first question). Returns its
  // conversation, or null when there's nothing to start from here.
  const startSetup = useCallback(
    (fresh = false, modality?: Modality): string | null => {
      if (!fresh && setup?.status === "in_progress" && setup.conversationId) {
        navigate(`/c/${setup.conversationId}`);
        return setup.conversationId;
      }
      // Only offered on the new-chat screen, so this starts a new conversation.
      if (activeId) return null;
      // Just the skill, no words: the agent speaks first ("Hey!", or on a call the voice does)
      // and opens step 1.
      const conversationId = crypto.randomUUID();
      drafts.current.delete("new");
      sendTo(conversationId, "", true, { skill: { id: SETUP_SKILL_ID, name: SETUP_SKILL_NAME }, attachments: [], ...(modality ? { modality } : {}) });
      setSetup((s) => (s ? { ...s, status: "in_progress", conversationId: null, done: 0, goal: null, plan: s.plan.map(({ text }) => ({ text, status: "todo" as const })) } : s));
      return conversationId;
    },
    [activeId, navigate, sendTo, setup],
  );

  /**
   * Opens a call in `conversationId`, or in a new chat when there's none. With `setup`, it's the
   * setup interview's ("Talk it through"): from where it is (the open setup conversation, the one
   * under way, or a new one). `waitForTap` when no tap on this page started it (arriving from
   * onboarding). Resolves with the call, or null when one is already starting; throws (an
   * ApiError, with words for the member) when it can't start, e.g. today's voice time is used up.
   */
  const startingCall = useRef(false);
  const openCall = useCallback(
    async ({ conversationId, setup: forSetup = false, waitForTap = false }: { conversationId?: string | null; setup?: boolean; waitForTap?: boolean } = {}) => {
      if (startingCall.current || callRef.current) return null;
      startingCall.current = true;
      setCalling(true);
      try {
        const { grant } = await api.startVoice();
        const id = conversationId ?? (forSetup ? startSetup(false, "call") : crypto.randomUUID());
        if (!id) {
          await api.endVoice(grant.sessionId).catch(() => undefined);
          return null;
        }
        const startedAt = Date.now();
        setLocalCalls((all) => ({ ...all, [grant.sessionId]: { id: grant.sessionId, startedAt, endedAt: null } }));
        // Docked over the app, so they keep using it; the setup interview (and a call arriving from
        // onboarding, which waits for a tap) opens on the full screen.
        setCall({ grant, conversationId: id, waitForTap, startedAt, setup: forSetup, layout: forSetup || waitForTap ? "full" : "bar" });
        return grant;
      } finally {
        startingCall.current = false;
        setCalling(false);
      }
    },
    [startSetup],
  );

  /** A call from a button ("Call Rowan", "Talk it through"), saying why if it can't start. */
  const startCall = useCallback(
    async (options: { conversationId?: string | null; setup?: boolean; waitForTap?: boolean } = {}) => {
      setCallNotice(null);
      setNotice(null);
      try {
        await openCall(options);
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "Voice is unavailable right now. Keep going here.";
        setMicInstead(!(error instanceof ApiError && error.status === 429));
        if (options.conversationId) setNotice(message);
        else setCallNotice(message);
      }
    },
    [openCall],
  );

  /** The agent's offer under a reply, taken: a call in this conversation. Its card says why if it can't start. */
  const callFromOffer = useCallback(async () => {
    if (!activeId) throw new ApiError(404, "Open the conversation first.");
    const grant = await openCall({ conversationId: activeId });
    if (!grant) throw new ApiError(409, "A call is already starting.");
    return grant.sessionId;
  }, [activeId, openCall]);

  /**
   * The call is over: it ends here at once (its recap shows before the server says so), and words
   * still held for a job that hadn't landed go into that conversation's message box, ready to send.
   */
  const endCall = useCallback((held: string[]) => {
    const ending = callRef.current;
    if (!ending) return;
    const id = ending.grant.sessionId;
    setLocalCalls((all) => ({ ...all, [id]: { id, startedAt: all[id]?.startedAt ?? ending.startedAt, endedAt: Date.now() } }));
    const words = held.join(" ").trim();
    if (words) {
      const key = ending.conversationId;
      const draft = [drafts.current.get(key)?.trim(), words].filter(Boolean).join("\n\n");
      drafts.current.set(key, draft);
      if (conversationIdFrom(window.location.pathname) === key) requestAnimationFrame(() => composer.current?.setValue(draft));
    }
    setCall(null);
  }, []);
  // The member clears the plan the agent kept for the work in a conversation (its rail). If that
  // fails, the plan comes back, unless a new one has come in meanwhile.
  const clearPlan = useCallback((conversationId: string) => {
    const before = threadsRef.current[conversationId]?.journey ?? null;
    const setJourney = (journey: (current: JourneyInfo | null) => JourneyInfo | null) =>
      setThreads((all) => (all[conversationId] ? { ...all, [conversationId]: { ...all[conversationId], journey: journey(all[conversationId].journey ?? null) } } : all));
    setJourney(() => null);
    api.clearPlan(conversationId).catch(() => {
      setJourney((current) => current ?? before);
      setNotice("Couldn't clear the plan. Try again.");
    });
  }, []);

  const skipSetup = useCallback(() => {
    setSetup((s) => (s ? { ...s, status: "skipped" } : s));
    api.skipSetup().catch(() => setSetup(initialSetup));
  }, [initialSetup]);

  // The journey rail follows the interview: when a reply ends while it's under way, the server's
  // copy of the checklist (as the agent last reported it) replaces ours.
  const wasRunning = useRef<ReadonlySet<string>>(running);
  useEffect(() => {
    const ended = [...wasRunning.current].some((id) => !running.has(id));
    wasRunning.current = running;
    if (ended && setup?.status === "in_progress") api.getSetup().then(({ setup }) => setSetup(setup), () => undefined);
  }, [running, setup?.status]);

  // ---------------------------------------------------------------------------------------
  // Whose move it is in each conversation, for the sidebar's marks: a run this tab is streaming
  // or following is working; the open conversation goes by what's on screen; the rest by what
  // the server says, asked again on load, on coming back to the app, when a run ends, and every
  // little while only while one is working out of view (a task's run in the background).

  const refreshMoves = useCallback(() => {
    const ids = conversationsRef.current.slice(0, MAX_MOVE_IDS).map((c) => c.id);
    if (ids.length === 0) return;
    api.conversationMoves(ids).then(({ moves }) => setServerMoves(moves), () => undefined);
  }, []);

  const wasRunningForMoves = useRef<ReadonlySet<string>>(running);
  useEffect(() => {
    const ended = [...wasRunningForMoves.current].filter((id) => !running.has(id));
    wasRunningForMoves.current = running;
    if (ended.length === 0) return;
    // Its old mark would show until the server answers; what's on screen says more.
    setServerMoves((all) => {
      const next = { ...all };
      for (const id of ended) delete next[id];
      return next;
    });
    refreshMoves();
  }, [running, refreshMoves]);

  // Leaving a conversation, its mark is what it showed, until the server says otherwise.
  const shownBefore = useRef(activeId);
  useEffect(() => {
    const left = shownBefore.current;
    shownBefore.current = activeId;
    if (!left || left === activeId) return;
    const thread = threadsRef.current[left];
    if (thread?.status !== "ready") return;
    const mark = markOf(moveOf(thread.messages.at(-1)));
    setServerMoves((all) => {
      const { [left]: _, ...rest } = all;
      return mark ? { ...rest, [left]: mark } : rest;
    });
  }, [activeId]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshMoves();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshMoves]);

  const workingElsewhere = Object.entries(serverMoves).some(([id, move]) => move === "working" && !running.has(id));
  useEffect(() => {
    if (!workingElsewhere) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshMoves();
    }, MOVES_POLL_MS);
    return () => clearInterval(timer);
  }, [workingElsewhere, refreshMoves]);

  const moves = useMemo(() => {
    const all: Record<string, MarkedMove> = { ...serverMoves };
    const open = activeId ? threads[activeId] : undefined;
    if (activeId && open?.status === "ready") {
      const mark = markOf(moveOf(open.messages.at(-1)));
      if (mark) all[activeId] = mark;
      else delete all[activeId];
    }
    for (const id of running) all[id] = "working";
    return all;
  }, [serverMoves, activeId, threads, running]);

  // Who each agent is to the member. The one they're in moves along as they work together: the
  // server updates it as a run ends, so look again a moment after.
  const companion = companions?.[workspace.id] ?? null;
  const wasRunningForCompanion = useRef<ReadonlySet<string>>(running);
  useEffect(() => {
    const ended = [...wasRunningForCompanion.current].some((id) => !running.has(id));
    wasRunningForCompanion.current = running;
    if (!ended || !companion || companion.stage === "arrived") return;
    const timer = setTimeout(() => {
      api.getCompanion().then(({ companion: next }) => next && onCompanion(next), () => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, [running, companion, onCompanion]);

  // "Say hello": once it knows the member, the agent introduces itself in a new chat and
  // suggests a name. Just the skill, no words: it speaks first. From the agent's page it
  // arrives as ?hello=1.
  const sayHello = useCallback(() => {
    if (activeId) return;
    drafts.current.delete("new");
    sendTo(crypto.randomUUID(), "", true, { skill: { id: INTRODUCE_SKILL_ID, name: INTRODUCE_SKILL_NAME }, attachments: [] });
  }, [activeId, sendTo]);
  // Offered on the new-chat screen once it's ready, unless setup is under way (that comes first).
  const hello = companion?.stage === "ready" && setup?.status !== "in_progress";
  const helloRequested = useRef(false);
  useEffect(() => {
    if (helloRequested.current || companion?.stage !== "ready") return;
    if (new URLSearchParams(window.location.search).get("hello") !== "1") return;
    helloRequested.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    sayHello();
  }, [companion?.stage, sayHello]);

  // Arriving from onboarding (or "Run setup" on the agent's page) with ?setup=1 starts it once;
  // ?setup=talk opens it on a call (typed, for members without voice).
  const setupRequested = useRef(false);
  useEffect(() => {
    if (setupRequested.current || !setup) return;
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get("setup");
    if (!wanted) return;
    setupRequested.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    if (wanted === "talk" && voice) void startCall({ setup: true, waitForTap: true });
    else startSetup(wanted === "new");
  }, [setup, startSetup, startCall, voice]);

  // An ask from Home routed to this agent arrives with the page (src/lib/client/pending-send.ts)
  // and is sent here as if typed here. One meant for another agent (the page landed elsewhere)
  // goes back into the message box instead, so nothing is lost and nothing goes to the wrong one.
  const pickedUp = useRef(false);
  useEffect(() => {
    if (pickedUp.current || !atNew) return;
    pickedUp.current = true;
    const pending = takePendingSend(workspace.id);
    if (!pending) return;
    if ("mismatch" in pending) {
      composer.current?.setValue(pending.mismatch.text);
      return;
    }
    drafts.current.delete("new");
    setRouted({ conversationId: pending.conversationId, workspaceId: workspace.id });
    sendTo(pending.conversationId, pending.text, true);
  }, [atNew, workspace.id, sendTo]);

  // "Tidy up" on a Brain topic arrives as ?tidy=<topic>: a new chat with that topic's tidy
  // skill attached, where the agent suggests facts to combine.
  const tidyRequested = useRef(false);
  useEffect(() => {
    if (tidyRequested.current) return;
    const topic = MEMORY_CATEGORIES.find((c) => c === new URLSearchParams(window.location.search).get("tidy"));
    if (!topic) return;
    tidyRequested.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    sendTo(crypto.randomUUID(), tidyRequest(topic), true, { skill: { id: tidySkillId(topic), name: TIDY_SKILL_NAME }, attachments: [] });
  }, [sendTo]);

  // A notification about a voice note opens its conversation with ?play=<reply>: the note is
  // brought into view and its play button pointed out. It doesn't play: sound needs a tap.
  const [noteFocus, setNoteFocus] = useState<{ conversationId: string; messageId: string } | null>(null);
  const playRequested = useRef(false);
  useEffect(() => {
    if (playRequested.current) return;
    playRequested.current = true;
    const messageId = new URLSearchParams(window.location.search).get("play");
    if (!messageId) return;
    window.history.replaceState(null, "", window.location.pathname);
    const conversationId = conversationIdFrom(window.location.pathname);
    if (conversationId && UUID.test(messageId)) setNoteFocus({ conversationId, messageId });
  }, []);
  useEffect(() => {
    if (noteFocus && activeId !== noteFocus.conversationId) setNoteFocus(null);
  }, [activeId, noteFocus]);

  // A tapped notification, in a Studio window that's already open (public/sw.js): go there
  // without a reload. A conversation may have changed on the server since it was loaded. The
  // worker is told it was heard, or it sends the window there itself (an older page can't hear).
  useEffect(() => {
    const worker = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!worker) return;
    const onMessage = (event: MessageEvent) => {
      const open = openRequest(event.data, window.location.origin);
      if (!open) return;
      event.ports[0]?.postMessage("opened");
      if (open.kind === "page") {
        window.location.assign(open.path);
        return;
      }
      setNoteFocus(open.play ? { conversationId: open.conversationId, messageId: open.play } : null);
      openTaskConversation(open.conversationId);
    };
    worker.addEventListener("message", onMessage);
    return () => worker.removeEventListener("message", onMessage);
  }, [openTaskConversation]);

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
      // Back to this agent's own new-chat screen (with Home on, "/" would be Home).
      if (id === activeId) navigate(several ? "/new" : "/");
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
    [activeId, conversations, navigate, several],
  );

  const createProject = useCallback(
    async (name: string) => {
      try {
        const { project } = await api.createProject(name);
        const { instructions: _i, files: _f, ...summary } = project;
        setProjects((list) => [summary, ...list]);
        setProjectDetails((all) => ({ ...all, [project.id]: { status: "ready", project } }));
        navigate(`/p/${project.id}`);
        requestAnimationFrame(() => composer.current?.focus());
      } catch (error) {
        throw new Error(error instanceof ApiError ? error.message : "Couldn't create the project. Try again.");
      }
    },
    [navigate],
  );

  /** Keeps the sidebar and the project page in step with what the server saved. */
  const projectSaved = useCallback((project: Project) => {
    const { instructions: _i, files: _f, ...summary } = project;
    setProjects((list) => list.map((p) => (p.id === project.id ? summary : p)));
    setProjectDetails((all) => ({ ...all, [project.id]: { status: "ready", project } }));
  }, []);

  const renameProject = useCallback(
    (id: string, name: string) => {
      const previous = projects.find((p) => p.id === id);
      const setName = (value: string) => {
        setProjects((list) => list.map((p) => (p.id === id ? { ...p, name: value } : p)));
        setProjectDetails((all) => {
          const current = all[id];
          return current?.status === "ready" ? { ...all, [id]: { status: "ready", project: { ...current.project, name: value } } } : all;
        });
      };
      setName(name);
      api
        .updateProject(id, { name })
        .then(({ project }) => projectSaved(project))
        .catch(() => previous && setName(previous.name));
    },
    [projects, projectSaved],
  );

  /** Deletes a project with its chats and files. */
  const removeProject = useCallback(
    (id: string) => {
      const snapshot = { projects, conversations };
      const doomed = new Set(conversations.filter((c) => c.projectId === id).map((c) => c.id));
      for (const conversationId of doomed) controllers.current.get(conversationId)?.abort();
      setProjects((list) => list.filter((p) => p.id !== id));
      setConversations((list) => list.filter((c) => !doomed.has(c.id)));
      if (activeProjectId === id || (activeId && doomed.has(activeId))) navigate(several ? "/new" : "/");
      api
        .deleteProject(id)
        .then(() => {
          setThreads((all) => Object.fromEntries(Object.entries(all).filter(([key]) => !doomed.has(key))));
          setProjectDetails((all) => {
            const { [id]: _, ...rest } = all;
            return rest;
          });
        })
        .catch(() => {
          setProjects(snapshot.projects);
          setConversations(snapshot.conversations);
        });
    },
    [activeId, activeProjectId, conversations, navigate, projects, several],
  );

  const moveConversation = useCallback(
    (id: string, projectId: string | null) => {
      const previous = conversations.find((c) => c.id === id);
      if (!previous) return;
      setConversations((list) => list.map((c) => (c.id === id ? { ...c, projectId } : c)));
      api.moveConversation(id, projectId).catch(() => {
        setConversations((list) => list.map((c) => (c.id === id ? { ...c, projectId: previous.projectId } : c)));
        setNotice("Couldn't move the conversation. Try again.");
      });
    },
    [conversations],
  );

  // The panel opens on its own once a running reply has found something worth showing.
  const latestReply = activeThread?.status === "ready" ? activeThread.messages.findLast((m) => m.role === "assistant") : undefined;
  const latestHasFindings =
    latestReply?.status === "streaming" && (collectFindings(latestReply).length > 0 || Boolean(latestReply.timeline));
  useEffect(() => {
    if (latestHasFindings && panelAuto.current) setPanelOpen(true);
  }, [latestHasFindings]);

  // The panel covers the whole conversation and stays open across conversations; switching
  // only clears any "jump to this reply" request.
  useEffect(() => {
    setPanelFocus(null);
  }, [activeId]);

  const openPanel = useCallback((messageId: string) => {
    panelAuto.current = true;
    try {
      localStorage.setItem(WORK_PANEL_KEY, "auto");
    } catch {
      // ignore
    }
    setPanelOpen(true);
    setPanelFocus(messageId);
  }, []);

  const closePanel = useCallback(() => {
    panelAuto.current = false;
    try {
      localStorage.setItem(WORK_PANEL_KEY, "off");
    } catch {
      // ignore
    }
    setPanelOpen(false);
    setPanelFocus(null);
  }, []);

  // ---------------------------------------------------------------------------------------
  // A call docked over the app: it follows the chat the member opens, goes where they ask, presses
  // the buttons they name, and shows what the agent saves as it lands.

  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const setupRef = useRef(setup);
  setupRef.current = setup;

  // Opening a chat moves the call into it, and a new chat starts one; elsewhere (tasks, the
  // Library, a project) it stays with the chat it was in.
  const followedPath = useRef(pathname);
  const movedAt = useRef(0);
  useEffect(() => {
    if (followedPath.current === pathname) return;
    followedPath.current = pathname;
    // The call's own chat coming up (its first words start it) isn't them moving around.
    if (conversationIdFrom(pathname) !== callRef.current?.conversationId) movedAt.current = Date.now();
    const into = conversationIdFrom(pathname) ?? (pathname === "/" ? "new" : null);
    if (!into) return;
    setCall((current) => {
      if (!current) return current;
      // A call already in a new chat that hasn't started stays there.
      const id = into === "new" ? (threadsRef.current[current.conversationId] ? crypto.randomUUID() : current.conversationId) : into;
      if (id === current.conversationId) return current;
      return { ...current, conversationId: id, setup: current.setup && setupRef.current?.conversationId === id };
    });
  }, [pathname]);

  const latestOnScreen = activeThread?.status === "ready" ? activeThread.messages.findLast((m) => m.role === "assistant" && m.activity.length > 0) : undefined;
  const latestOnScreenId = latestOnScreen?.id ?? null;
  const callScreen = useMemo<CallScreen>(() => {
    const view: ScreenView = activeId
      ? "chat"
      : activeProjectId
        ? "project"
        : activeTask === "list"
          ? "tasks"
          : activeTask
            ? "task"
            : libraryPath === "home"
              ? "library"
              : libraryPath
                ? "tracker"
                : "new_chat";
    const title =
      view === "chat" ? activeTitle : view === "project" ? activeProjectName : view === "task" ? taskTitle : view === "tracker" && libraryPath ? collectionName(libraryPath) : null;
    const actions = [...(Object.keys(buttons ?? {}) as ScreenAction[]), ...(activeId && latestOnScreenId ? (["open_results"] as const) : [])];
    return { view, ...(title ? { title } : {}), ...(actions.length ? { actions } : {}) };
  }, [activeId, activeProjectId, activeProjectName, activeTask, activeTitle, buttons, latestOnScreenId, libraryPath, taskTitle]);
  /** What the member is looking at as they speak, by id, so the agent knows what "this" is. */
  const screenRef: ScreenRef | undefined =
    activeTask && activeTask !== "list" ? { kind: "task", id: activeTask } : libraryPath && libraryPath !== "home" ? { kind: "tracker", collection: libraryPath } : undefined;

  /** "Open …" on a call: matched by name against what's theirs here, then gone to. */
  const openPlace = useCallback(
    async (request: { place?: unknown; name?: unknown; said: string }): Promise<OpenResult> => {
      const [tasks, library] = await Promise.all([api.listTasks().catch(() => null), api.listLibrary().catch(() => null)]);
      const match = resolvePlace(request, {
        chats: conversationsRef.current.map((c) => ({ id: c.id, title: c.title })),
        projects: projectsRef.current.map((p) => ({ id: p.id, name: p.name })),
        tasks: (tasks?.tasks ?? []).filter((t) => t.status !== "archived").map((t) => ({ id: t.id, title: t.title })),
        trackers: (library?.trackers ?? []).map((t) => ({ collection: t.collection, name: collectionName(t.collection) })),
        docs: (library?.items ?? []).map((i) => ({ title: i.title, conversationId: i.conversationId })),
      });
      switch (match.kind) {
        case "back":
          window.history.back();
          return { status: "opened", title: "" };
        case "go":
          if (match.page) return { status: "page", path: match.path, title: match.title };
          navigate(match.path);
          return { status: "opened", title: match.title };
        case "which":
          return { status: "which", options: match.options };
        default:
          return { status: "none" };
      }
    },
    [navigate],
  );

  /** A button the member named on a call: the page's own handler, or the Results panel. */
  const latestOnScreenRef = useRef(latestOnScreenId);
  latestOnScreenRef.current = latestOnScreenId;
  const pressOnScreen = useCallback(
    async (action: ScreenAction): Promise<boolean> => {
      if (action === "open_results") {
        if (!latestOnScreenRef.current) return false;
        openPanel(latestOnScreenRef.current);
        return true;
      }
      const press = buttonsRef.current?.[action];
      return press ? Boolean(await press()) : false;
    },
    [openPanel],
  );

  // What the agent saves while they watch the call's chat (a tracker row, a doc in the Library) is
  // shown where it landed, once a reply, unless they've moved around since it started; when the
  // reply then waits on them, the chat comes back.
  const shownFrom = useRef<{ path: string; conversationId: string } | null>(null);
  const shownThisReply = useRef(false);
  const replyStartedAt = useRef(0);
  useEffect(
    () =>
      subscribe((id, event) => {
        const live = callRef.current;
        if (!live || live.layout !== "bar" || id !== live.conversationId) return;
        if (event.type === "start") {
          shownThisReply.current = false;
          replyStartedAt.current = Date.now();
        }
        const landed = event.type === "saved" ? `/library/${event.target.collection}` : event.type === "artifact" ? "/library" : null;
        if (landed && !shownThisReply.current && conversationIdFrom(window.location.pathname) === id && movedAt.current < replyStartedAt.current) {
          shownThisReply.current = true;
          shownFrom.current = { path: landed, conversationId: id };
          navigate(landed);
          return;
        }
        if (event.type === "end" && shownFrom.current?.conversationId === id) {
          const shown = shownFrom.current;
          shownFrom.current = null;
          // Only if they're still where it took them: anywhere else, they've moved on themselves.
          if (window.location.pathname === shown.path && waitsOnMember(event.message)) navigate(`/c/${id}`);
        }
      }),
    [navigate, subscribe],
  );

  /** The call's chat, by name, when it isn't the page on screen (for "Back to …" on the bar). */
  const callElsewhereTitle =
    call && call.conversationId !== activeId && threads[call.conversationId] ? (conversations.find((c) => c.id === call.conversationId)?.title ?? "the chat") : null;

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
        stop(activeId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, collapsed, drawerOpen, newChat, running, stop, toggleSidebar]);

  // ---------------------------------------------------------------------------------------

  const isRunning = activeId ? running.has(activeId) : false;
  const lastMove = activeThread?.status === "ready" ? moveOf(activeThread.messages.at(-1), { running: isRunning }) : null;
  const awaiting = lastMove?.reason === "approval";
  // The setup's rail shows in its conversation while the interview is under way. Once it's
  // applied, its finished checklist stays there until later work has a plan of its own; once
  // it's set aside, that conversation is like any other.
  const ownJourney = activeThread?.journey && activeThread.journey.kind !== "setup" ? activeThread.journey : null;
  const setupHere = Boolean(
    setup && activeId === setup.conversationId && (setup.status === "in_progress" || (setup.status === "done" && activeThread?.status === "ready" && !ownJourney)),
  );
  const journey = setupHere ? null : shownJourney(activeThread, isRunning);
  // A call about the setup (started as the interview's, or in its conversation while it holds
  // there) follows the setup's rail, live; any other follows its own conversation's, and one
  // that followed a task's run there, the task's.
  const callThread = call ? threads[call.conversationId] : undefined;
  const callOwnJourney = callThread?.journey && callThread.journey.kind !== "setup" ? callThread.journey : null;
  const setupCall = Boolean(
    call &&
      setup &&
      (call.setup ||
        (call.conversationId === setup.conversationId && (setup.status === "in_progress" || (setup.status === "done" && callThread?.status === "ready" && !callOwnJourney)))),
  );
  const callRunning = call ? running.has(call.conversationId) : false;
  const callJourney = useMemo(
    () => (!call ? null : setupCall && setup ? setupAsJourney(setup) : shownJourney(callThread, callRunning)),
    [call, setup, setupCall, callThread, callRunning],
  );
  const callPurpose: CallPurpose = setupCall
    ? "setup"
    : callThread?.journey?.kind === "task" || callThread?.messages.some((m) => m.origin?.kind === "task")
      ? "task"
      : "chat";
  // The calls a thread's messages were said on: as the server last said, with what this tab knows
  // of its own (a call just hung up on is over here before the server's copy says so), and where
  // its calls followed a task's run: into this conversation, or from it (and how that run stands).
  const callsOf = useCallback(
    (id: string | null, thread: ThreadState | undefined): RecapCall[] => {
      if (!id || !thread) return [];
      const said = new Set(thread.messages.flatMap((m) => callOf(m.origin) ?? []));
      const all = new Map<string, RecapCall>((thread.calls ?? []).map((c) => [c.id, c]));
      for (const mine of Object.values(localCalls)) {
        const went = follows[mine.id] ?? [];
        const into = went.find((f) => f.conversationId === id);
        if (!said.has(mine.id) && !into) continue;
        const known = all.get(mine.id);
        const away = went.filter((f) => f.leftFrom === id).map((f) => ({ title: f.title, move: moves[f.conversationId] ?? null }));
        all.set(mine.id, {
          ...(known ? { ...known, endedAt: known.endedAt ?? mine.endedAt } : mine),
          ...(into ? { followedFrom: into.firstMessage } : {}),
          ...(away.length ? { away } : {}),
        });
      }
      return [...all.values()];
    },
    [follows, localCalls, moves],
  );
  const activeCalls = useMemo(() => callsOf(activeId, activeThread), [activeId, activeThread, callsOf]);
  // A call with the agent from the message box, where talking setup through isn't already offered.
  const callName = (companion?.stage === "arrived" ? companion.name : null) ?? greeter;
  const callButton = (where: string | null) =>
    voice && !call ? { label: callName ? `Call ${callName}` : "Start a call", onCall: () => void startCall({ conversationId: where }), busy: calling } : undefined;
  const sidebarHidden = desktop ? collapsed : !drawerOpen;
  const draftKey = activeId ?? "new";
  const projectDraftKey = `project:${activeProjectId}`;

  const footnote =
    agent.mode === "mock" ? (
      <p className="text-[12px] text-fg-3">
        Mock agent — responses are simulated. Connect the agent API to work with real data.
      </p>
    ) : agent.mode === "unavailable" ? (
      <p className="text-[12px] text-fg-3">This agent isn&apos;t enabled yet.</p>
    ) : null;

  return (
    <Tooltip.Provider delayDuration={500} skipDelayDuration={200}>
      <ScreenButtonsContext.Provider value={setButtons}>
      <div inert={call?.layout === "full" ? true : undefined} className="flex h-dvh overflow-hidden bg-bg" style={keyboardHeight ? { height: keyboardHeight } : undefined}>
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
            moves={moves}
            agent={agent}
            workspace={workspaces.find((w) => w.id === workspace.id) ?? workspace}
            workspaces={workspaces}
            companions={companions}
            email={email}
            mod={mod}
            atHome={atHome}
            home={homeData}
            homeEnabled={several}
            onHome={() => navigate("/")}
            onSelect={(id) => navigate(`/c/${id}`)}
            onNew={newChat}
            onCollapse={toggleSidebar}
            onRename={rename}
            onDelete={remove}
            projects={projects}
            activeProjectId={activeProjectId}
            onSelectProject={(id) => navigate(`/p/${id}`)}
            onCreateProject={createProject}
            onRenameProject={renameProject}
            onDeleteProject={removeProject}
            onMove={moveConversation}
            tasksActive={activeTask !== null}
            onSelectTasks={() => navigate("/tasks")}
            libraryActive={libraryActive}
            onSelectLibrary={() => navigate("/library")}
          />
        </aside>

        <main
          className="relative flex min-w-0 flex-1 flex-col"
          onDragEnter={(e) => {
            if (!acceptsDrop(e)) return;
            dragDepth.current += 1;
            setDropping(true);
          }}
          onDragOver={(e) => {
            if (!acceptsDrop(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDropping(false);
          }}
          onDrop={(e) => {
            dragDepth.current = 0;
            setDropping(false);
            if (!acceptsDrop(e) || e.dataTransfer.files.length === 0) return;
            e.preventDefault();
            composer.current?.addFiles(e.dataTransfer.files);
          }}
        >
          {dropping ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-2 z-40 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-bg/85 animate-fade-in"
            >
              <Paperclip size={22} strokeWidth={1.75} className="text-accent" />
              <p className="text-[15px] font-medium text-fg">Drop files to attach</p>
              <p className="text-[13px] text-fg-3">PDF, Word, CSV, text, or images up to 10 MB</p>
            </div>
          ) : null}
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
            <h1 className="flex min-w-0 flex-1 items-center gap-1 px-1.5 text-[14px] font-medium text-fg-2 max-md:justify-center">
              {/* With several agents, every chat says which one it's with. */}
              {several && activeId ? (
                <>
                  <span className="flex min-w-0 shrink-0 items-center gap-1.5 text-fg">
                    {companion ? <CompanionMark stage={companion.stage} look={companion.look} size={16} /> : null}
                    <span className="max-w-[10rem] truncate">{agentLabel(workspace, companions)}</span>
                  </span>
                  <ChevronRight size={14} className="shrink-0 text-fg-4" aria-hidden="true" />
                </>
              ) : null}
              {conversationProject ? (
                <>
                  <a
                    href={`/p/${conversationProject.id}`}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      navigate(`/p/${conversationProject.id}`);
                    }}
                    className="max-w-[40%] shrink-0 truncate rounded-md text-fg-3 transition-colors hover:text-fg"
                  >
                    {conversationProject.name}
                  </a>
                  <ChevronRight size={14} className="shrink-0 text-fg-4" aria-hidden="true" />
                </>
              ) : null}
              <span className="min-w-0 truncate">{activeTitle ?? (activeTask && activeTask !== "list" ? taskTitle : null) ?? ""}</span>
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
          {/* A call docks here, under the header, while the member keeps using the app. */}
          <div ref={setDock} className="contents" />

          {libraryPath === "home" ? (
            <LibraryView onOpenConversation={(id) => navigate(`/c/${id}`)} onOpenTracker={(collection) => navigate(`/library/${collection}`)} />
          ) : libraryPath ? (
            <TrackerPage key={libraryPath} collection={libraryPath} onBack={() => navigate("/library")} />
          ) : activeTask === "list" ? (
            <TasksView skills={skills} onOpen={(id) => navigate(`/tasks/${id}`)} />
          ) : activeTask ? (
            <TaskDetail
              key={activeTask}
              taskId={activeTask}
              skills={skills}
              onBack={() => navigate("/tasks")}
              onOpenConversation={openTaskConversation}
              onTitle={setTaskTitle}
            />
          ) : activeProjectId ? (
            activeProject?.status === "ready" ? (
              <ProjectView
                key={activeProjectId}
                ref={composer}
                project={activeProject.project}
                conversations={conversations.filter((c) => c.projectId === activeProjectId)}
                running={running}
                draft={drafts.current.get(projectDraftKey) ?? ""}
                onDraftChange={(v) => drafts.current.set(projectDraftKey, v)}
                onSubmit={send}
                onOpen={(id) => navigate(`/c/${id}`)}
                onChange={projectSaved}
                skills={skills}
                allowFiles={agent.attachments}
                footnote={footnote}
                voice={voice}
              />
            ) : activeProject?.status === "missing" || activeProject?.status === "error" ? (
              <Unavailable what="project" missing={activeProject.status === "missing"} onNew={newChat} />
            ) : (
              <div className="flex flex-1 items-center justify-center" aria-busy="true">
                <span className="spinner animate-fade-in [animation-delay:200ms]" aria-label="Loading project" />
              </div>
            )
          ) : atHome ? (
            <HomeView
              key="home"
              ref={composer}
              data={homeData}
              workspaces={workspaces}
              companions={companions}
              current={workspace.id}
              draft={drafts.current.get("home") ?? ""}
              onDraftChange={(v) => drafts.current.set("home", v)}
              onSubmit={(text, pick) => void sendFromHome(text, pick)}
              routing={routing}
              ask={homeAsk}
              onCancelAsk={() => setHomeAsk(null)}
              onOpen={openFromHome}
              voice={voice}
              footnote={footnote}
              notice={homeNotice}
            />
          ) : !activeId ? (
            <EmptyState
              key="new"
              ref={composer}
              draft={drafts.current.get("new") ?? ""}
              onDraftChange={(v) => drafts.current.set("new", v)}
              onSubmit={send}
              offHome={several && workspaces.some((w) => w.id === workspace.id && !w.onHome)}
              onPutOnHome={workspace.role === "owner" ? putOnHome : undefined}
              skills={skills}
              initialSkillId={initialSkillId}
              canManageSkills={workspace.role === "owner"}
              allowFiles={agent.attachments}
              footnote={footnote}
              setup={!hello && setup && (setup.status === "not_started" || setup.status === "in_progress") ? setup : null}
              onSayHello={hello ? sayHello : undefined}
              agentName={workspace.name}
              member={member}
              greeter={greeter}
              onSetup={() => startSetup()}
              onSkipSetup={skipSetup}
              onTalk={voice && setup ? () => void startCall({ setup: true }) : undefined}
              talking={calling}
              talkNotice={callNotice}
              micInstead={micInstead}
              voice={voice}
              call={!hello && setup && (setup.status === "not_started" || setup.status === "in_progress") ? undefined : callButton(null)}
            />
          ) : activeThread?.status === "missing" || activeThread?.status === "error" ? (
            <Unavailable what="conversation" missing={activeThread.status === "missing"} onNew={newChat} />
          ) : activeThread?.status === "ready" ? (
            <Thread
              key={activeId}
              messages={activeThread.messages}
              earlier={Boolean(activeThread.earlier)}
              onLoadEarlier={loadEarlier}
              running={isRunning}
              onRetry={retryHere}
              onEdit={edit}
              onDecide={decideHere}
              onProposal={answerProposal}
              onAnswer={send}
              onUiResponse={recordHere}
              onRunTask={runTaskHere}
              onFeedback={rateMessage}
              onOpenPanel={openPanel}
              sendCount={sendCount}
              noteFocus={noteFocus?.conversationId === activeId ? noteFocus.messageId : null}
              onCall={voice && !call ? callFromOffer : undefined}
              calls={activeCalls}
              footer={
                <div className="mx-auto w-full max-w-[46rem] px-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-6 md:pb-5">
                  {/* Home sent this ask here. A chat never moves, so another agent gets it as a new chat. */}
                  {routed?.conversationId === activeId && several ? (
                    <p className="mb-2 flex flex-wrap items-center justify-center gap-x-1.5 px-1 text-center text-[12.5px] text-fg-3 animate-fade-up">
                      <span>Sent to {agentLabel(workspace, companions)}</span>
                      {workspaces.some((w) => w.id !== workspace.id && w.onHome) ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <DropdownMenu.Root>
                            <DropdownMenu.Trigger className="rounded text-fg-2 underline underline-offset-2 hover:text-fg">Ask another agent instead</DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content align="center" side="top" sideOffset={6} className="z-50 w-[248px] rounded-xl border border-line bg-surface p-1 shadow-pop animate-fade-in">
                                <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-[12px] font-medium text-fg-3">Start this as a new chat with</DropdownMenu.Label>
                                {workspaces
                                  .filter((w) => w.id !== workspace.id && w.onHome)
                                  .map((w) => (
                                    <DropdownMenu.Item
                                      key={w.id}
                                      onSelect={() => askAnother(w.id)}
                                      className="flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-fg outline-none data-[highlighted]:bg-hover"
                                    >
                                      {companions?.[w.id] ? <CompanionMark stage={companions[w.id].stage} look={companions[w.id].look} size={16} /> : null}
                                      <span className="min-w-0 truncate">{agentLabel(w, companions)}</span>
                                    </DropdownMenu.Item>
                                  ))}
                              </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                          </DropdownMenu.Root>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                  {notice ? (
                    <p role="status" className="mb-2 px-1 text-center text-[13px] text-danger">
                      {notice}
                    </p>
                  ) : null}
                  {setup && setupHere ? (
                    <div className="mb-2 flex items-stretch gap-2 animate-fade-up">
                      <Journey steps={setup.plan} title={SETUP_JOURNEY_TITLE} goal={setup.goal} growing move={lastMove?.move} className="min-w-0 flex-1" />
                      {voice && setup.status === "in_progress" ? (
                        <button
                          type="button"
                          onClick={() => void startCall({ conversationId: setup.conversationId, setup: true })}
                          disabled={calling}
                          aria-label="Talk it through on a call"
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-fg-2 transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-fg active:scale-[0.97] disabled:opacity-60"
                        >
                          {calling ? <span className="spinner size-3.5" aria-hidden="true" /> : <AudioLines size={15} className="text-accent" />}
                          <span className="max-sm:hidden">Talk it through</span>
                        </button>
                      ) : null}
                    </div>
                  ) : journey ? (
                    <Journey
                      steps={journey.steps}
                      goal={journey.goal}
                      move={lastMove?.move}
                      // A conversation's own plan is the member's to clear; a task's is edited on the task.
                      onClear={journey.kind === "conversation" && activeId && !isRunning ? () => clearPlan(activeId) : undefined}
                      className="mb-2 animate-fade-up"
                    />
                  ) : null}
                  <Composer
                    key={draftKey}
                    ref={composer}
                    initialValue={drafts.current.get(draftKey) ?? ""}
                    onDraftChange={(v) => drafts.current.set(draftKey, v)}
                    onSubmit={send}
                    onStop={stopHere}
                    skills={skills}
                    running={isRunning}
                    placeholder={isRunning ? "Redirect the agent…" : several ? `Reply to ${agentLabel(workspace, companions)}…` : "Reply…"}
                    autoFocus={desktop}
                    allowFiles={agent.attachments}
                    hint={composerHint(lastMove)}
                    voice={voice}
                    redirects={isRunning || awaiting}
                    // In the setup conversation while it's under way, "Talk it through" is the call.
                    call={setup && setupHere && setup.status === "in_progress" ? undefined : callButton(activeId)}
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

        {panelOpen && activeId && activeThread?.status === "ready" ? (
          <WorkPanel
            messages={activeThread.messages}
            focusId={panelFocus}
            onClose={closePanel}
          />
        ) : null}
      </div>
      {call ? (
        <Call
          grant={call.grant}
          agentName={workspace.name}
          conversationId={call.conversationId}
          messages={threads[call.conversationId]?.messages ?? []}
          running={running.has(call.conversationId)}
          journey={callJourney}
          purpose={callPurpose}
          voiceNotes={Boolean(voice?.speech.tts)}
          // Everything on the call acts on the call's own conversation, wherever the page is.
          onSend={(text, { steer, attachments }) => {
            const id = call.conversationId;
            // A call from the new-chat screen starts its conversation with the first words.
            const isNew = !threadsRef.current[id];
            sendTo(id, text, isNew, { skill: null, attachments: attachments ?? [], modality: "call", voiceSessionId: call.grant.sessionId, ...(screenRef ? { screen: screenRef } : {}) }, steer);
          }}
          onStop={() => stop(call.conversationId)}
          onRetry={(messageId) => retry(call.conversationId, messageId)}
          onDecide={(approvalId, decision, spoken) => decide(call.conversationId, approvalId, decision, spoken)}
          onUiResponse={(messageId, blockId, response) => recordUiResponse(call.conversationId, messageId, blockId, response)}
          onRunTask={(taskId) => runTaskNow(taskId, call.conversationId)}
          subscribe={subscribe}
          onEnd={endCall}
          waitForTap={call.waitForTap}
          layout={call.layout}
          onLayout={(layout) => setCall((c) => (c ? { ...c, layout } : c))}
          dock={dock}
          screen={callScreen}
          onOpen={openPlace}
          onPress={pressOnScreen}
          elsewhere={callElsewhereTitle}
          onBack={() => navigate(`/c/${call.conversationId}`)}
        />
      ) : null}
      </ScreenButtonsContext.Provider>
    </Tooltip.Provider>
  );
}

function Unavailable({ what, missing, onNew }: { what: "conversation" | "project"; missing: boolean; onNew: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[10vh] text-center animate-fade-up">
      <h2 className="font-display text-[24px] tracking-[-0.01em]">
        {missing ? `This ${what} isn't here` : `Couldn't load this ${what}`}
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
