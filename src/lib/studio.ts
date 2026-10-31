import { appForToolkit, appName } from "@/lib/apps";
import type { StandingKind } from "@/lib/approvals/standing";
import type { AgentTask, TaskRun, TaskWatch } from "@/lib/tasks/types";
import type { CompanionStage, JourneyStep, Memory, MemoryCategory, ToolkitConnection } from "@/lib/types";
import { MEMORY_CATEGORY_LABELS } from "@/lib/types";

// The agent's own page in Studio ("/studio", src/components/studio): the words it says about
// itself, from real state only. The copy is the product, so it lives here, pure and tested, and
// the components only lay it out. First person throughout: it's the agent talking, never a form.

/** What the page knows about where this agent stands with its member. */
export interface StudioSignals {
  /** The owner's setup interview; null for a member who isn't the owner. */
  setup: "not_started" | "in_progress" | "done" | "skipped" | null;
  /** How far the companion has come (the "companion" preview); null without it. */
  companion: CompanionStage | null;
  /** Apps its template suggests that the member hasn't connected, as the connections list has them. */
  missingApps: Pick<ToolkitConnection, "slug" | "name">[];
  /** The member has chatted with it at least once. */
  hasChats: boolean;
  /** It takes asks from Home, and whether Home exists for this member (several agents, the preview on). */
  onHome: boolean;
  several: boolean;
  owner: boolean;
}

/** What the next-step line's button does; the component wires each to what the shell already has. */
export type NextAction =
  | { kind: "setup" }
  | { kind: "connect"; slug: string; name: string }
  | { kind: "hello" }
  | { kind: "chat" }
  | { kind: "home" };

export interface NextStep {
  /** One line, in the agent's words, about what would help it most right now. */
  text: string;
  /** The button beside it, or null when it's set. */
  action: (NextAction & { label: string }) | null;
}

/**
 * The one thing that would help this agent most, in priority order: finishing setup, an app it
 * was made for, meeting the member, a first chat, and being put on Home. Only what the member
 * can do here; a non-owner is told where things stand without being asked to act.
 */
export function nextStep(s: StudioSignals): NextStep {
  if (s.owner && s.setup === "in_progress") return { text: "We were in the middle of setting up. Let's finish.", action: { kind: "setup", label: "Finish setting up" } };
  if (s.owner && s.setup === "not_started") {
    return { text: "Set up with me: a short chat, then I'll suggest how I'll work for you.", action: { kind: "setup", label: "Set up with me" } };
  }
  const app = s.missingApps[0];
  if (app) return { text: `Connect ${app.name} so I can use it for you.`, action: { kind: "connect", slug: app.slug, name: app.name, label: `Connect ${app.name}` } };
  if (s.companion === "ready") return { text: "I think I know you now. Say hello and I'll introduce myself.", action: { kind: "hello", label: "Say hello" } };
  if (!s.hasChats) return { text: "Send me anything to start. I learn as we go.", action: { kind: "chat", label: "Start a chat" } };
  if (s.several && !s.onHome) {
    return s.owner
      ? { text: "Put me on Home so asks there can reach me.", action: { kind: "home", label: "Put me on Home" } }
      : { text: "I'm not on Home yet; the owner can put me there.", action: null };
  }
  return { text: "I'm set. Change anything below whenever you like.", action: null };
}

/**
 * The quiet rail under the name: the same signals as `nextStep`, as steps that fill in as the agent
 * becomes the member's. No score, just how far along it is. "On Home" only where Home exists.
 */
export function readiness(s: StudioSignals): JourneyStep[] {
  const steps: JourneyStep[] = [
    { text: "Set up", status: s.setup === null || s.setup === "done" || s.setup === "skipped" ? "done" : s.setup === "in_progress" ? "doing" : "todo" },
    { text: "Knows you", status: s.companion === null || s.companion === "ready" || s.companion === "arrived" ? "done" : s.companion === "drawn" ? "doing" : "todo" },
    { text: "Has the apps it needs", status: s.missingApps.length === 0 ? "done" : "todo" },
    { text: "Has chatted with you", status: s.hasChats ? "done" : "todo" },
  ];
  if (s.several) steps.push({ text: "On Home", status: s.onHome ? "done" : "todo" });
  return steps;
}

/**
 * The apps the agent's template suggests (`suggested`, Composio slugs) that the member hasn't
 * connected or started connecting. Apps on offer that no template asked for aren't missing.
 */
export function missingApps(toolkits: ToolkitConnection[], suggested: string[]): Pick<ToolkitConnection, "slug" | "name">[] {
  const wanted = new Set(suggested);
  return toolkits.filter((t) => wanted.has(t.slug) && t.status !== "connected" && t.status !== "pending").map(({ slug, name }) => ({ slug, name }));
}

/** What the agent knows, counted: facts by topic (fullest first) and how many are pinned. */
export interface Knowledge {
  total: number;
  pinned: number;
  topics: { category: MemoryCategory; label: string; count: number }[];
}

export function knowledge(memories: Memory[]): Knowledge {
  const counts = new Map<MemoryCategory, number>();
  for (const m of memories) counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
  const topics = [...counts]
    .map(([category, count]) => ({ category, label: MEMORY_CATEGORY_LABELS[category], count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { total: memories.length, pinned: memories.filter((m) => m.pinned).length, topics };
}

/** "I know 42 things about your work, 6 of them pinned." */
export function knowledgeLine(k: Knowledge): string {
  if (k.total === 0) return "I haven't written anything down yet. Tell me something and I'll keep it.";
  const things = k.total === 1 ? "one thing" : `${k.total} things`;
  const pinned = k.pinned === 0 ? "" : k.pinned === 1 ? ", one of them pinned" : `, ${k.pinned} of them pinned`;
  return `I know ${things} about your work${pinned}.`;
}

/** The one line about what the agent does on its own with money and deletions, from the member's standing OKs. */
export function approvalsLine(allowed: StandingKind[]): string {
  const sites = allowed.filter((k) => k.startsWith("site:")).map((k) => k.slice(5));
  if (sites.length === 0) return "I never pay for anything or delete for good without asking you first.";
  const list = sites.length === 1 ? sites[0] : sites.length === 2 ? `${sites[0]} and ${sites[1]}` : `${sites.slice(0, -1).join(", ")}, and ${sites[sites.length - 1]}`;
  return `I can pay and order on ${list} without asking; anything else that costs money or deletes for good waits for you.`;
}

/** Where a skill came from, in the member's terms. */
export function skillOrigin(skill: { catalogId: string | null; description: string }): string {
  if (skill.catalogId) return "from the library";
  return /\b(showed|watched|taught)\b/i.test(skill.description) ? "you showed me" : "we worked it out";
}

/** One routine (a task, with its watch if it has one), read left to right: When → I do → I keep → You hear. */
export interface RoutineChain {
  when: string;
  does: string;
  /** The list it keeps, by name, or null when it keeps nothing listed. */
  keeps: string | null;
  hear: string;
  /** A template's task the member hasn't turned on yet. */
  notStarted: boolean;
}

export function routineChain(
  task: Pick<AgentTask, "title" | "instructions" | "status" | "schedule" | "templateTaskId" | "lastRunAt">,
  opts: { when: string; skill: string | null; watch: Pick<TaskWatch, "toolkit" | "status"> | null; collections: string[]; lastRun: Pick<TaskRun, "status"> | null },
): RoutineChain {
  const notStarted = task.status === "paused" && task.lastRunAt === null;
  const when = opts.watch ? `When something happens in ${appName(appForToolkit(opts.watch.toolkit))}` : task.schedule ? opts.when : "When you run it";
  // "Weekly report, with Weekly report" says nothing: the skill is named only when it adds a name.
  const does = opts.skill && opts.skill.trim().toLowerCase() !== task.title.trim().toLowerCase() ? `${task.title}, with ${opts.skill}` : task.title;
  const text = task.instructions.toLowerCase();
  const keeps = opts.collections.find((c) => text.includes(c.toLowerCase().replace(/[_-]+/g, " ")) || text.includes(c.toLowerCase())) ?? null;
  let hear: string;
  if (notStarted) hear = "Not started yet";
  else if (task.status === "paused") hear = "Paused";
  else if (opts.watch && opts.watch.status === "broken") hear = "I've lost sight of it";
  else if (opts.lastRun?.status === "running") hear = "Working now";
  else if (opts.lastRun?.status === "failed") hear = "Last time went wrong";
  else hear = "You hear when it's done";
  return { when, does, keeps, hear, notStarted };
}

/** The first line of the agent's instructions, for the fold's heading. */
export function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^[#*\-\s>]+/, "").trim())
    .find(Boolean);
  return line ?? "";
}

/** "Change what I'm for", and the rest of the asks, as the member would say them to the agent. */
export const ASKS = {
  profile: "I'd like to change what you're for. Here's what's different now: ",
  instructions: "I'd like to change how you work. Here's what I want done differently: ",
  remember: "Here's something to remember: ",
  skill: "I want to teach you something new. Here's the job: ",
  routine: "While I'm away, I'd like you to ",
  routineChange: (title: string) => `About "${title}": I'd like it done differently. `,
  app: "I'd like you to use another app for me: ",
} as const;
