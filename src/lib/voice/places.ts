import { normalizeSpeech, SEE_IT, spokenWords } from "./intent";
import { OPEN_PLACES, type OpenPlace } from "./types";

// Where "open …" on a call goes: the member's own words (and the voice's reading of them, when it
// gave one) matched against what's theirs in this agent, by name. A name that matches nothing is
// no place, and the words go to the worker as a request instead. Pure.

/** What the member has in this agent, by name, for matching. */
export interface PlaceIndex {
  chats: { id: string; title: string }[];
  projects: { id: string; name: string }[];
  tasks: { id: string; title: string }[];
  trackers: { collection: string; name: string }[];
  /** Library items: opened in the chat they came from, else the Library. */
  docs: { title: string; conversationId: string | null }[];
}

/** A page in the app (`path`), one that loads on its own (`page`: settings, the agent), or going back. */
export type PlaceMatch =
  | { kind: "go"; path: string; title: string; page?: boolean }
  | { kind: "back" }
  | { kind: "which"; options: string[] }
  | { kind: "none" };

const LEAD =
  /^(?:(?:ok|okay|yes|yeah|so|now|please|hey|can you|could you|would you|will you|lets|just|go ahead and|i want to|id like to)\s+)*(?:open(?: up)?|pull up|bring up|switch to|jump to|navigate to|head to|get me to|show me|show|go(?: back)? to|take me(?: back)? to|back to|start|open)?\s*/;
const ARTICLE = /^(?:(?:my|the|our|a|an|this|that|its|their|your|up)\s+)+/;
const TAIL = /(?:\s+(?:please|now|for me|again|page|view))+$/;

/** The place and name in "open my job tracker", "go to the Ramp chat", "new chat". */
export function parseOpen(said: string): { place: OpenPlace | null; name: string } {
  // Fillers out, and "…and show me what's in there" is only more of the same ask.
  const words = spokenWords(said).replace(SEE_IT, "");
  if (/^(?:(?:ok|okay|so|now|please|just)\s+)*(?:go back|take me back|back)(?:\s+(?:please|now))*$/.test(words)) return { place: "back", name: "" };
  const rest = words.replace(LEAD, "").replace(TAIL, "").replace(ARTICLE, "").trim();
  if (/^(?:a )?new (?:chat|conversation)$/.test(rest)) return { place: "new_chat", name: "" };
  if (/^(?:tasks?|task list|list of tasks)$/.test(rest)) return { place: "tasks", name: "" };
  if (/^library$/.test(rest)) return { place: "library", name: "" };
  if (/^(?:settings|account settings)$/.test(rest)) return { place: "settings", name: "" };
  if (/^(?:agent|agent page|agent setup|agents page|brain|memory|memories)$/.test(rest)) return { place: "agent", name: "" };
  const kind = /^(.+?)\s+(tracker|task|chat|conversation|project)$/.exec(rest);
  if (kind) {
    const place: OpenPlace = kind[2] === "tracker" ? "tracker" : kind[2] === "task" ? "task" : kind[2] === "project" ? "project" : "chat";
    return { place, name: kind[1].replace(ARTICLE, "") };
  }
  return { place: null, name: rest };
}

/** Words that say what kind of thing it is, not which one. */
const GENERIC = new Set(["the", "my", "a", "an", "our", "chat", "conversation", "task", "tracker", "project", "doc", "document", "about", "with", "for", "on", "to", "of", "and", "page"]);

function keyWords(text: string): string[] {
  return normalizeSpeech(text)
    .split(" ")
    .filter((w) => w && !GENERIC.has(w));
}

/** How well `name` names `title`: 3 the same, 2 every word in it, 1 most words, 0 not. */
export function nameScore(name: string, title: string): number {
  const asked = keyWords(name);
  const has = keyWords(title);
  if (!asked.length || !has.length) return 0;
  if (asked.join(" ") === has.join(" ")) return 3;
  const set = new Set(has);
  // Spoken plurals and possessives ("Ramp's", "trackers") match their written form.
  const found = asked.filter((w) => set.has(w) || set.has(w.replace(/s$/, "")) || has.some((h) => h.replace(/s$/, "") === w));
  if (found.length === asked.length) return 2;
  return found.length / asked.length >= 0.6 && found.length >= 2 ? 1 : 0;
}

interface Candidate {
  title: string;
  path: string;
  page?: boolean;
}

function best(name: string, candidates: Candidate[]): PlaceMatch {
  const scored = candidates.map((c) => ({ c, score: nameScore(name, c.title) })).filter((x) => x.score > 0);
  if (!scored.length) return { kind: "none" };
  const top = Math.max(...scored.map((x) => x.score));
  const winners = scored.filter((x) => x.score === top);
  // The same name twice (a chat and the task that runs in it) is one place: the first kind listed.
  const titles = [...new Set(winners.map((x) => x.c.title))];
  if (winners.length === 1 || titles.length === 1) return { kind: "go", ...winners[0].c };
  return { kind: "which", options: titles.slice(0, 3) };
}

const PAGES: Partial<Record<OpenPlace, PlaceMatch>> = {
  new_chat: { kind: "go", path: "/new", title: "a new chat" },
  tasks: { kind: "go", path: "/tasks", title: "your task list" },
  library: { kind: "go", path: "/library", title: "your Library" },
  settings: { kind: "go", path: "/settings", title: "Settings", page: true },
  agent: { kind: "go", path: "/agent", title: "the agent's page", page: true },
  back: { kind: "back" },
};

/**
 * Where to go for what the member said (`said`), with the voice's reading of it when it gave one
 * (`place`, `name`): a page, the one thing they named, a choice when two fit, or none.
 */
export function resolvePlace(request: { place?: unknown; name?: unknown; said: string }, index: PlaceIndex): PlaceMatch {
  const parsed = parseOpen(request.said);
  const given = typeof request.place === "string" && (OPEN_PLACES as readonly string[]).includes(request.place) ? (request.place as OpenPlace) : null;
  const named = typeof request.name === "string" && request.name.trim() ? request.name.trim() : parsed.name;
  // Their own words decide a page they named outright; the voice's reading fills in the rest.
  const place = parsed.place ?? given;
  const name = parsed.place && !parsed.name ? "" : named;
  const page = place ? PAGES[place] : undefined;
  if (page && !(place === "tasks" && name) && !(place === "library" && name)) return page;

  const chats = index.chats.map((c) => ({ title: c.title, path: `/c/${c.id}` }));
  const tasks = index.tasks.map((t) => ({ title: t.title, path: `/tasks/${t.id}` }));
  const trackers = index.trackers.map((t) => ({ title: t.name, path: `/library/${t.collection}` }));
  const projects = index.projects.map((p) => ({ title: p.name, path: `/p/${p.id}` }));
  const docs = index.docs.map((d) => ({ title: d.title, path: d.conversationId ? `/c/${d.conversationId}` : "/library" }));
  if (!name) return { kind: "none" };
  switch (place) {
    case "chat":
      return best(name, chats);
    case "task":
    case "tasks":
      return best(name, tasks);
    case "tracker":
      return best(name, trackers);
    case "project":
      return best(name, projects);
    case "library":
      return best(name, [...trackers, ...docs]);
    default:
      return best(name, [...trackers, ...tasks, ...projects, ...chats, ...docs]);
  }
}
