import type { MarkedMove } from "@/lib/chat/move";
import type { Attachment, CallSummary, ChatMessage, Companion, ConversationSummary, Journey, LibraryItem, MemoryProposal, MessageFeedback, Modality, Project, ProjectSummary, ProposalPicks, ScreenRef, SetupSummary, ShownStep, StreamEvent, UiResponse, WorkspaceSummary } from "@/lib/types";
import type { VoiceGrant } from "@/lib/voice/types";
import type { VoiceKey } from "@/lib/voice/voices";
import type { TaskSchedule } from "@/lib/tasks/schedule";
import type { AgentRecord, AgentTask, PlanStep, TaskRun, TrackerSummary } from "@/lib/tasks/types";
import type { VerdictCall } from "@/lib/verdicts";
import type { DriveInput } from "@/lib/browser-fill";
import type { CredentialSummary } from "@/lib/secrets";
import { disablePush } from "./push";
import { agentHeaders } from "./tab-agent";

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
    headers: { "Content-Type": "application/json", ...agentHeaders(), ...init?.headers },
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

/** Audio from one of the app's own routes, as a blob to play from (no range requests needed). */
async function audio(path: string): Promise<Blob> {
  const res = await fetch(path, { headers: agentHeaders() });
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  return res.blob();
}

export const api = {
  updateAccount: (patch: { name?: string; about?: string }) =>
    request<{ account: { name: string; about: string } }>("/api/account", { method: "PATCH", body: JSON.stringify(patch) }),
  listConversations: (query = "", signal?: AbortSignal) =>
    request<{ conversations: ConversationSummary[] }>(`/api/conversations?q=${encodeURIComponent(query)}`, { signal }),
  // This page knows the agent's offers to call and its browser handed over, so it asks for them
  // (pages from before them don't get any).
  getConversation: (id: string, signal?: AbortSignal) =>
    request<{ conversation: ConversationSummary; messages: ChatMessage[]; journey: Journey | null; calls: CallSummary[] }>(`/api/conversations/${id}?offers=1&secrets=1&handoffs=1`, { signal }),
  /** Whose move it is in these conversations: only those working, waiting on the member, or stuck. */
  conversationMoves: (ids: string[], signal?: AbortSignal) =>
    request<{ moves: Record<string, MarkedMove> }>(`/api/conversations/moves?ids=${ids.map(encodeURIComponent).join(",")}`, { signal }),
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
  /** Clears the plan the agent keeps for the work in a conversation (the rail above the chat). */
  clearPlan: (id: string) =>
    request<{ conversation: ConversationSummary }>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ plan: null }),
    }),
  deleteConversation: (id: string) => request<void>(`/api/conversations/${id}`, { method: "DELETE" }),
  clearConversations: () => request<{ deleted: number }>("/api/conversations", { method: "DELETE" }),
  stopRun: (id: string) => request<void>(`/api/conversations/${id}/stop`, { method: "POST" }),
  getSetup: () => request<{ setup: SetupSummary | null }>("/api/agent/setup"),
  getCompanion: () => request<{ companion: Companion | null }>("/api/agent/companion"),
  updateCompanion: (patch: { name?: string; manner?: string; voice?: VoiceKey | null }) =>
    request<{ companion: Companion }>("/api/agent/companion", { method: "PATCH", body: JSON.stringify(patch) }),
  /** A voice's preview line as audio, for playing in the browser. */
  voicePreview: (voice: VoiceKey): Promise<Blob> => audio(`/api/voice/preview?voice=${encodeURIComponent(voice)}`),
  /** A reply's voice note as audio, said in the agent's voice. */
  voiceNote: (conversationId: string, messageId: string): Promise<Blob> => audio(`/api/conversations/${conversationId}/messages/${messageId}/speech`),
  /** What the member said in a recording from the message box's mic; the recording isn't kept. */
  transcribe: async (recording: Blob): Promise<{ text: string; mock?: true }> => {
    const res = await fetch("/api/voice/transcribe", { method: "POST", headers: { "Content-Type": recording.type || "audio/webm", ...agentHeaders() }, body: recording });
    if (res.status === 401) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      throw new ApiError(401, "Signed out.");
    }
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
    return (await res.json()) as { text: string; mock?: true };
  },
  skipSetup: () => request<{ ok: true }>("/api/agent/setup", { method: "POST", body: JSON.stringify({ status: "skipped" }) }),
  /** "That's not what I said" about a request approved by voice: spoken approval goes off for everyone. */
  reportSpokenApproval: (conversationId: string, approvalId: string) =>
    request<{ ok: true }>(`/api/conversations/${conversationId}/approvals/${approvalId}/report`, { method: "POST", body: "{}" }),
  decideProposal: (conversationId: string, proposalId: string, decision: "save" | "dismiss" | "undo") =>
    request<{ proposal: MemoryProposal }>(`/api/conversations/${conversationId}/proposals/${proposalId}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
  /** The site the agent's browser is on now, and the saved logins (for that site) or cards that fit a request. */
  secretRequest: (conversationId: string, blockId: string) =>
    request<{ site: string | null; browser: "open" | "off" | "none" | "ended" | "failed"; saved: CredentialSummary[]; canSave: boolean }>(
      `/api/conversations/${conversationId}/secrets/${blockId}`,
    ),
  /**
   * Fills a login or card into the agent's browser (or records the member did it themself).
   * Resolves with the card's response and the words to send the agent next, never a value.
   */
  fillSecret: (
    conversationId: string,
    blockId: string,
    body:
      | { use: "saved"; credentialId: string; cvv?: string }
      | { use: "login"; username: string; password: string; save: boolean }
      | { use: "card"; number: string; name: string; expiry: string; cvv: string; save: boolean }
      | { use: "code"; code: string }
      | { use: "self" },
  ) => request<{ response: UiResponse; message: string }>(`/api/conversations/${conversationId}/secrets/${blockId}`, { method: "POST", body: JSON.stringify(body) }),
  /** One click, key, scroll, or bit of typing in the agent's browser, while taking it over. */
  /** One input to the agent's browser; with `record`, the step it was (showing the agent a job). */
  driveBrowser: (conversationId: string, input: DriveInput, { record = false }: { record?: boolean } = {}) =>
    request<{ ok: true; step?: ShownStep }>(`/api/conversations/${conversationId}/browser/input`, {
      method: "POST",
      body: JSON.stringify(record ? { ...input, record: true } : input),
    }),
  listCredentials: () => request<{ credentials: CredentialSummary[]; enabled: boolean }>("/api/account/credentials"),
  deleteCredential: (id: string) => request<{ ok: true }>(`/api/account/credentials/${id}`, { method: "DELETE" }),
  /** A live view of the agent's browser in this conversation that the member can click and type in. */
  takeBrowser: (conversationId: string) =>
    request<{ url: string }>(`/api/conversations/${conversationId}/browser/control`, { method: "POST" }),
  browserSignIns: () => request<{ saved: boolean | null }>("/api/account/browser"),
  /** Deletes one of the member's agents; `next` is the agent to open now, null when none is left. */
  deleteAgent: (id: string) => request<{ next: string | null }>(`/api/workspaces/${id}`, { method: "DELETE" }),
  listAgents: () => request<{ workspaces: WorkspaceSummary[]; active: string | null }>("/api/workspaces"),
  forgetBrowserSignIns: () => request<{ saved: boolean | null }>("/api/account/browser", { method: "DELETE" }),
  answerUi: (
    conversationId: string,
    blockId: string,
    body:
      | { action: "submit"; keepFiles?: string[]; verdicts?: VerdictCall[] }
      | { action: "apply"; picks: ProposalPicks; edits?: { profile?: string; instructions?: string; name?: string; skills?: Record<string, string> }; timezone?: string }
      | { action: "merge"; picks: number[]; edits?: Record<string, string> }
      | { action: "first-run"; choice: "started" | "later" }
      | { action: "handback"; steps?: number }
      | { action: "undo" }
      | { action: "accept"; sessionId: string }
      | { action: "decline" },
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
  updateTask: (id: string, patch: Partial<TaskFields> & { status?: AgentTask["status"]; plan?: PlanStep[]; goal?: string | null }) =>
    request<{ task: AgentTask }>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteTask: (id: string) => request<void>(`/api/tasks/${id}`, { method: "DELETE" }),
  listTaskRuns: (id: string, signal?: AbortSignal) => request<{ runs: TaskRun[] }>(`/api/tasks/${id}/runs`, { signal }),
  runTask: (id: string) => request<{ conversationId: string; runId: string }>(`/api/tasks/${id}/run`, { method: "POST" }),
  listRecords: (signal?: AbortSignal, collection?: string) =>
    request<{ records: AgentRecord[] }>(collection ? `/api/records?collection=${encodeURIComponent(collection)}` : "/api/records", { signal }),
  updateRecord: (id: string, patch: { status?: string | null }) =>
    request<{ record: AgentRecord }>(`/api/records/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteRecord: (id: string) => request<void>(`/api/records/${id}`, { method: "DELETE" }),
  listLibrary: (signal?: AbortSignal) => request<{ items: LibraryItem[]; trackers: TrackerSummary[] }>("/api/library", { signal }),
  addLibraryLink: (link: { url: string; title?: string }) => request<{ item: LibraryItem }>("/api/library", { method: "POST", body: JSON.stringify(link) }),
  updateLibraryItem: (id: string, patch: { title?: string; pinned?: boolean }) =>
    request<{ item: LibraryItem }>(`/api/library/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteLibraryItem: (id: string) => request<void>(`/api/library/${id}`, { method: "DELETE" }),
  listAgentFiles: (signal?: AbortSignal) => request<{ files: Attachment[] }>("/api/agent/files", { signal }),
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
  const res = await fetch(path, { method: "POST", headers: agentHeaders(), body: form, signal });
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
  | { kind: "send"; text: string; skillId?: string; attachmentIds?: string[]; steer?: boolean; projectId?: string; modality?: Modality; voiceSessionId?: string; screen?: ScreenRef }
  | { kind: "retry" }
  | { kind: "edit"; messageId: string; text: string }
  | ({ kind: "decide"; approvalId: string; decision: "approve" | "reject" } & ({ via?: "tap" } | SpokenDecision));

/** A decision said on a call: what the member was heard to say, and the call. The server checks both. */
export interface SpokenDecision {
  via: "voice";
  heard: string;
  voiceSessionId: string;
}

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
    headers: { "Content-Type": "application/json", ...agentHeaders() },
    // This page can show the agent's offer to call and its requests for a login or card, and its browser handed over; the
    // server leaves them out for a page that can't.
    body: JSON.stringify({ ...body, offers: true, secrets: true, handoffs: true }),
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
