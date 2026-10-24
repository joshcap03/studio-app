import { callOf } from "@/lib/chat/modality";
import { withoutVoice } from "@/lib/chat/ui";
import type { Tenant } from "@/lib/tenant-core";
import type { CallSummary, ChatMessage } from "@/lib/types";
import { voiceStatus } from "./status";

// The member's own calls, as the rest of the app sees them: which call a message was said on
// (checked, never taken from the browser), whether a call is over, and the calls a conversation's
// messages were said on, for their recaps. All under the member's session: voice_sessions rows
// are theirs alone (RLS), and only rows in the agent they're in count. Free of Next.js, so the
// worker path can use it.

/** Words can reach the server a moment after the member hung up; they still belong to that call. */
const LATE_WORDS_MS = 2 * 60_000;
/** The most calls one conversation's recaps are read for. */
const MAX_CALLS = 50;

interface CallRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  max_seconds: number;
}

/** A call as the browser sees it: over once it ended, or once its time ran out (a tab that never hung up). */
function toCall(row: CallRow, now = Date.now()): CallSummary {
  const startedAt = Date.parse(row.started_at);
  const limit = startedAt + row.max_seconds * 1000;
  const endedAt = row.ended_at ? Date.parse(row.ended_at) : limit <= now ? limit : null;
  return { id: row.id, startedAt, endedAt };
}

async function readCalls(tenant: Tenant, ids: string[]): Promise<CallSummary[]> {
  if (!ids.length) return [];
  const { data, error } = await tenant.db
    .from("voice_sessions")
    .select("id, started_at, ended_at, max_seconds")
    .in("id", ids)
    .eq("workspace_id", tenant.workspace.id);
  if (error) throw new Error(error.message);
  return ((data ?? []) as CallRow[]).map((row) => toCall(row));
}

/**
 * The member's own call in this agent that words can still be said on: one that's going, or
 * ended a moment ago. Null for anyone else's call, a call in another agent, or an old one.
 */
export async function callForWords(tenant: Tenant, callId: string): Promise<CallSummary | null> {
  const [call] = await readCalls(tenant, [callId]);
  if (!call) return null;
  return call.endedAt === null || Date.now() - call.endedAt <= LATE_WORDS_MS ? call : null;
}

/** The member's own call in this agent that's still going; null when it's over or isn't theirs. */
export async function openCall(tenant: Tenant, callId: string): Promise<CallSummary | null> {
  const [call] = await readCalls(tenant, [callId]);
  return call && call.endedAt === null ? call : null;
}

/** Whether this call of the member's is over (or isn't theirs: then nothing will read the reply out either). */
export async function callEnded(tenant: Tenant, callId: string): Promise<boolean> {
  const [call] = await readCalls(tenant, [callId]);
  return !call || call.endedAt !== null;
}

/** The calls these messages were said on, oldest first. */
export async function callsFor(tenant: Tenant, messages: ChatMessage[]): Promise<CallSummary[]> {
  const ids = [...new Set(messages.flatMap((m) => callOf(m.origin) ?? []))].slice(-MAX_CALLS);
  return (await readCalls(tenant, ids)).sort((a, b) => a.startedAt - b.startedAt);
}

/** callsFor, or none when they can't be read: the conversation still loads without its recaps. */
export function callsOrNone(tenant: Tenant, messages: ChatMessage[]): Promise<CallSummary[]> {
  return callsFor(tenant, messages).catch((error) => {
    console.error("[voice] couldn't read the conversation's calls", error);
    return [];
  });
}

/**
 * A conversation's messages as the member's page gets them, with the calls they were said on (for
 * their recaps). With voice off for them (docs/voice.md), nothing from when it was on shows.
 */
export async function messagesWithCalls(tenant: Tenant, messages: ChatMessage[]): Promise<{ messages: ChatMessage[]; calls: CallSummary[] }> {
  if (voiceStatus(tenant)) return { messages, calls: await callsOrNone(tenant, messages) };
  return { messages: withoutVoice(messages), calls: [] };
}
