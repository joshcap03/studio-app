import { marksOf, type MarkedMove } from "@/lib/chat/move";
import { createStore, MAX_MOVES } from "@/lib/db/store";
import { templateById } from "@/lib/templates";
import type { Tenant } from "@/lib/tenant-core";
import type { WorkspaceSummary } from "@/lib/types";

// Home: every agent the person has, side by side, to pick which one to talk to. Each one's
// latest chats and whose move it is in them, read as the member under RLS, one agent at a time
// (the same store and marks the sidebar uses, so the dots mean the same thing).

/** The latest chats shown on each agent's card. */
export const HOME_CHATS = 3;

export interface HomeChat {
  id: string;
  title: string;
  updatedAt: number;
  mark: MarkedMove | null;
}

export interface AgentOverview extends WorkspaceSummary {
  /** What it's for: its profile, else its template's description; null with neither. */
  about: string | null;
  /** When the member last chatted with it; null before their first chat. */
  lastActive: number | null;
  recent: HomeChat[];
  /** Chats of theirs, among the latest, that wait on them, that it's working on, that got stuck. */
  counts: Record<MarkedMove, number>;
}

interface SettingsRow {
  workspace_id: string;
  business_context: string;
  template_id: string | null;
}

/** What one agent is for, in a line: its profile with whitespace folded, else its template's. */
export function aboutOf(profile: string | null | undefined, templateId: string | null | undefined): string | null {
  const own = profile?.replace(/\s+/g, " ").trim();
  if (own) return own;
  return templateById(templateId)?.description ?? null;
}

async function overviewOf(tenant: Tenant, workspace: WorkspaceSummary, settings: SettingsRow | undefined): Promise<AgentOverview> {
  const store = createStore(tenant.db, { workspaceId: workspace.id, userId: tenant.userId });
  const conversations = await store.listConversations();
  // Whose move it is is best effort: the card shows without the dots.
  const marks = await store
    .lastMessages(conversations.slice(0, MAX_MOVES).map((c) => c.id))
    .then(marksOf)
    .catch((error) => {
      console.error("[home] moves unavailable", error);
      return {} as Record<string, MarkedMove>;
    });
  const counts: Record<MarkedMove, number> = { your_call: 0, working: 0, stuck: 0 };
  for (const mark of Object.values(marks)) counts[mark] += 1;
  return {
    ...workspace,
    about: aboutOf(settings?.business_context, settings?.template_id),
    lastActive: conversations[0]?.updatedAt ?? null,
    recent: conversations.slice(0, HOME_CHATS).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, mark: marks[c.id] ?? null })),
    counts,
  };
}

/** Every agent the person belongs to, in the order they joined them. */
export async function agentOverviews(tenant: Tenant): Promise<AgentOverview[]> {
  const ids = tenant.workspaces.map((w) => w.id);
  const { data, error } = await tenant.db
    .from("workspace_settings")
    .select("workspace_id, business_context, template_id")
    .in("workspace_id", ids)
    .returns<SettingsRow[]>();
  if (error) throw error;
  const settings = new Map((data ?? []).map((row) => [row.workspace_id, row]));
  return Promise.all(tenant.workspaces.map((w) => overviewOf(tenant, w, settings.get(w.id))));
}
