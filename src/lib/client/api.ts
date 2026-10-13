import type { Attachment, ChatMessage, ConversationSummary, MemoryProposal, StreamEvent } from "@/lib/types";

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
  listConversations: (query = "", signal?: AbortSignal) =>
    request<{ conversations: ConversationSummary[] }>(`/api/conversations?q=${encodeURIComponent(query)}`, { signal }),
  getConversation: (id: string, signal?: AbortSignal) =>
    request<{ conversation: ConversationSummary; messages: ChatMessage[] }>(`/api/conversations/${id}`, { signal }),
  renameConversation: (id: string, title: string) =>
    request<{ conversation: ConversationSummary }>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteConversation: (id: string) => request<void>(`/api/conversations/${id}`, { method: "DELETE" }),
  stopRun: (id: string) => request<void>(`/api/conversations/${id}/stop`, { method: "POST" }),
  decideProposal: (conversationId: string, proposalId: string, decision: "save" | "dismiss") =>
    request<{ proposal: MemoryProposal }>(`/api/conversations/${conversationId}/proposals/${proposalId}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
  deleteAttachment: (id: string) => request<void>(`/api/attachments/${id}`, { method: "DELETE" }),
  signOut: () => request<{ ok: true }>("/api/auth/signout", { method: "POST" }),
};

/** Uploads a file to attach to the next message. */
export async function uploadAttachment(file: File, signal?: AbortSignal): Promise<Attachment> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/attachments", { method: "POST", body: form, signal });
  if (res.status === 401) {
    window.location.assign("/login");
    throw new ApiError(401, "Signed out.");
  }
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  return ((await res.json()) as { attachment: Attachment }).attachment;
}

export type TurnBody =
  | { kind: "send"; text: string; attachmentIds?: string[] }
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
