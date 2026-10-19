import type { Attachment, ChatMessage, ConversationSummary, MemoryProposal, MessageFeedback, Modality, Project, ProjectSummary, ProposalPicks, SetupSummary, StreamEvent, UiResponse } from "@/lib/types";
import type { VoiceGrant } from "@/lib/voice/types";
import type { TaskSchedule } from "@/lib/tasks/schedule";
import type { AgentRecord, AgentTask, PlanStep, TaskRun } from "@/lib/tasks/types";
import type { VerdictCall } from "@/lib/verdicts";
import { disablePush } from "./push";

/** What a member sets on a task; the server fills in the rest. */
export interface TaskFields {
  title: string;
  instructions: string;
  skillId: string | null;
  schedule: TaskSchedule | null;
  timezone: string;
}

// Browser-side calls to this application's own API. The browser never talks to the agent
// backend directly and never holds credentials; the session cookie is httpOnly.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 401) {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    throw new ApiError(401, "Signed out.");
  }
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "Something went wrong. Try again.";
}

export const api = {
  updateAccount: (patch: { name?: string; about?: string }) =>
    request<{ account: { name: string; about: string } }>("/api/account", { method: "PATCH", body: JSON.stringify(patch) }),
  listConversations: (query = "", signal?: AbortSignal) =>
    request<{ conversations: ConversationSummary[] }>(`/api/conversations?q=${encodeURIComponent(query)}`, { signal }),
  getConversation: (id: string, signal?: AbortSignal) =>
    request<{ conversation: ConversationSummary; messages: ChatMessage[] }>(`/api/conversations/${id}`, { signal }),
  renameConversation: (id: string, title: string) =>
    request<{ conversation: ConversationSummary }>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  moveConversation: (id: string, projectId: string | null) =>
    request<{ conversation: ConversationSummary }>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId }),
    }),
  deleteConversation: (id: string) => request<void>(`/api/conversations/${id}`, { method: "DELETE" }),
  clearConversations: () => request<{ deleted: number }>("/api/conversations", { method: "DELETE" }),
  stopRun: (id: string) => request<void>(`/api/conversations/${id}/stop`, { method: "POST" }),
  getSetup: () => request<{ setup: SetupSummary | null }>("/api/agent/setup"),
  skipSetup: () => request<{ ok: true }>("/api/agent/setup", { method: "POST", body: JSON.stringify({ status: "skipped" }) }),
  decideProposal: (conversationId: string, proposalId: string, decision: "save" | "dismiss" | "undo") =>
    request<{ proposal: MemoryProposal }>(`/api/conversations/${conversationId}/proposals/${proposalId}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
  answerUi: (
    conversationId: string,
    blockId: string,
    body:
      | { action: "submit"; keepFiles?: string[]; verdicts?: VerdictCall[] }
      | { action: "apply"; picks: ProposalPicks; edits?: { profile?: string; instructions?: string }; timezone?: string }
      | { action: "merge"; picks: number[]; edits?: Record<string, string> }
      | { action: "undo" },
  ) =>
    request<{ response: UiResponse }>(`/api/conversations/${conversationId}/ui/${blockId}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  rateMessage: (conversationId: string, messageId: string, feedback: MessageFeedback | null) =>
    request<{ feedback: MessageFeedback | null }>(`/api/conversations/${conversationId}/messages/${messageId}/feedback`, {
      method: "PUT",
      body: JSON.stringify({ feedback }),
    }),
  listProjects: () => request<{ projects: ProjectSummary[] }>("/api/projects"),
  getProject: (id: string, signal?: AbortSignal) => request<{ project: Project }>(`/api/projects/${id}`, { signal }),
  createProject: (name: string) => request<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),
  updateProject: (id: string, patch: { name?: string; instructions?: string }) =>
    request<{ project: Project }>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),
  deleteProjectFile: (projectId: string, fileId: string) => request<void>(`/api/projects/${projectId}/files/${fileId}`, { method: "DELETE" }),
  deleteAgentFile: (id: string) => request<void>(`/api/agent/files/${id}`, { method: "DELETE" }),
  deleteAttachment: (id: string) => request<void>(`/api/attachments/${id}`, { method: "DELETE" }),
  listTasks: (signal?: AbortSignal) => request<{ tasks: AgentTask[] }>("/api/tasks", { signal }),
  getTask: (id: string, signal?: AbortSignal) => request<{ task: AgentTask; score?: string | null }>(`/api/tasks/${id}`, { signal }),
  createTask: (draft: TaskFields) => request<{ task: AgentTask }>("/api/tasks", { method: "POST", body: JSON.stringify(draft) }),
  updateTask: (id: string, patch: Partial<TaskFields> & { status?: AgentTask["status"]; plan?: PlanStep[] }) =>
    request<{ task: AgentTask }>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteTask: (id: string) => request<void>(`/api/tasks/${id}`, { method: "DELETE" }),
  listTaskRuns: (id: string, signal?: AbortSignal) => request<{ runs: TaskRun[] }>(`/api/tasks/${id}/runs`, { signal }),
  runTask: (id: string) => request<{ conversationId: string; runId: string }>(`/api/tasks/${id}/run`, { method: "POST" }),
  listRecords: (signal?: AbortSignal) => request<{ records: AgentRecord[] }>("/api/records", { signal }),
  updateRecord: (id: string, patch: { status?: string | null }) =>
    request<{ record: AgentRecord }>(`/api/records/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteRecord: (id: string) => request<void>(`/api/records/${id}`, { method: "DELETE" }),
  startVoice: () => request<{ grant: VoiceGrant }>("/api/voice/session", { method: "POST", body: "{}" }),
  endVoice: (sessionId: string) => request<{ seconds: number }>(`/api/voice/session/${sessionId}/end`, { method: "POST", body: "{}" }),
  /** Stops notifications on this device first, so the next person on it doesn't get them. */
  signOut: async () => {
    await disablePush().catch(() => undefined);
    return request<{ ok: true }>("/api/auth/signout", { method: "POST" });
  },
};

async function upload<T>(path: string, file: File, signal?: AbortSignal): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(path, { method: "POST", body: form, signal });
  if (res.status === 401) {
    window.location.assign("/login");
    throw new ApiError(401, "Signed out.");
  }
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  return (await res.json()) as T;
}

/** Uploads a file to attach to the next message. */
export async function uploadAttachment(file: File, signal?: AbortSignal): Promise<Attachment> {
  return (await upload<{ attachment: Attachment }>("/api/attachments", file, signal)).attachment;
}

/** Adds a file to a project; the agent gets it with every message in the project. */
export async function uploadProjectFile(projectId: string, file: File): Promise<Attachment> {
  return (await upload<{ file: Attachment }>(`/api/projects/${projectId}/files`, file)).file;
}

/** Adds a file to the active agent; it gets the file with every message. */
export async function uploadAgentFile(file: File): Promise<Attachment> {
  return (await upload<{ file: Attachment }>("/api/agent/files", file)).file;
}

export type TurnBody =
  | { kind: "send"; text: string; skillId?: string; attachmentIds?: string[]; steer?: boolean; projectId?: string; modality?: Modality }
  | { kind: "retry" }
  | { kind: "edit"; messageId: string; text: string }
  | { kind: "decide"; approvalId: string; decision: "approve" | "reject" };

/**
 * Starts a turn and calls `onEvent` for each streamed event. Resolves when the stream ends.
 * Rejects with AbortError when `signal` aborts and with ApiError on HTTP failures.
 */
export async function streamTurn(
  conversationId: string,
  body: TurnBody,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401) {
    window.location.assign("/login");
    throw new ApiError(401, "Signed out.");
  }
  if (!res.ok || !res.body) throw new ApiError(res.status, await errorMessage(res));
  await readNdjson(res.body, onEvent);
}

/** Parses a newline-delimited JSON stream, tolerating chunks that split lines. */
export async function readNdjson<T>(body: ReadableStream<Uint8Array>, onEvent: (event: T) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line) as T);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) onEvent(JSON.parse(buffer) as T);
}
