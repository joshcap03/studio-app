import { describe, expect, it } from "vitest";
import { findingsForReply } from "@/components/chat/findings";
import { approvalFor, openingLineIndexes } from "@/lib/agent/langflow";
import { spokenApprovalFor } from "@/lib/approvals/spoken";
import { evidenceFor, interpretCalls, talksMachinery, type ToolCall } from "@/lib/agent/tools";
import { linksSeen } from "@/lib/chat/timeline";
import type { ActivityStep, ChatMessage, RunReport } from "@/lib/types";
import { voiceNoteFor } from "@/lib/voice/notes";
import { initialRelay, relayEvent, speakableGist, spokenStep, TECHNICAL as SPOKEN_TECHNICAL } from "@/lib/voice/relay";

// Replays every tool call in a real Langflow flow's history through the same interpreter and
// findings code the app uses, and checks the result reads like it should to a business
// owner: every finished step says what it found (or failed with a plain reason), and no line
// leaks raw data or technical text. Covers every tool the agent has used, not just one.
//
// The same goes for what the voice says on a call (src/lib/voice/relay.ts): it narrates only
// labels the agent reported, word for word, and a reply's spoken gist carries no markup or links;
// nor does a voice note (src/lib/voice/notes.ts), the reply's or a task run's report. Every
// take_action the agent asked approval for is classified for spoken approval
// (src/lib/approvals/spoken.ts): money and deletions are always taps, and a read-back is plain words.
//
// Read-only. Needs LANGFLOW_AUDIT_BASE_URL, LANGFLOW_AUDIT_API_KEY, LANGFLOW_AUDIT_FLOW_ID.

const base = process.env.LANGFLOW_AUDIT_BASE_URL;
const key = process.env.LANGFLOW_AUDIT_API_KEY;
const flow = process.env.LANGFLOW_AUDIT_FLOW_ID;

interface Leaf {
  type?: string;
  name?: string;
  text?: string;
  tool_input?: unknown;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

/** Rebuilds a reply's steps (tool steps and the agent's lines) in the order they happened. */
function replyToSteps(leaves: Leaf[]): (ActivityStep & { returned?: number })[] {
  // The same rule the adapter uses: only opening lines become steps, never the answer.
  const opening = new Set(openingLineIndexes(leaves));
  const calls: ToolCall[] = [];
  const order: ({ kind: "call"; index: number } | { kind: "note"; text: string })[] = [];
  leaves.forEach((leaf, i) => {
    if (leaf.type === "tool_use") {
      order.push({ kind: "call", index: calls.length });
      calls.push({ name: leaf.name ?? "tool", input: leaf.tool_input ?? leaf.input ?? {}, output: leaf.output, error: leaf.error });
    } else if (opening.has(i) && typeof leaf.text === "string") {
      order.push({ kind: "note", text: leaf.text.trim() });
    }
  });
  const byIndex = new Map(interpretCalls(calls).map((s) => [s.index, s]));
  return order.flatMap((o, i): (ActivityStep & { returned?: number })[] => {
    if (o.kind === "note") return [{ id: `n${i}`, label: o.text, status: "done", action: "note", app: "agent", hidden: talksMachinery(o.text) || undefined, startedAt: 0 }];
    const s = byIndex.get(o.index);
    // How much the tool sent back, including any gateway call merged into this step.
    const output = s ? calls[s.index]?.output : undefined;
    const returned = typeof output === "string" ? output.length : JSON.stringify(output ?? "").length;
    return s ? [{ id: `s${o.index}`, label: s.label, status: s.status, detail: s.detail, app: s.app, action: s.action, preview: s.preview, hidden: s.hidden, startedAt: 0, returned }] : [];
  });
}

const RAW = /[{}<>\[\]`]|\b(null|undefined|true|false|nonetype)\b|traceback|object has no attribute|mcp tool|content below|requested_range|\w+_\w+\(/i;
/** A tool slug (COMPOSIO_REMOTE_WORKBENCH) is code, never words for a person. */
const SLUG = /\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/;
const TECHNICAL = { test: (text: string) => RAW.test(text) || SLUG.test(text) };

describe.skipIf(!base || !key || !flow)("every real tool call reads well", () => {
  it("gives each finished step a plain finding, and never shows raw or technical text", async () => {
    const res = await fetch(`${base}/api/v1/monitor/messages?flow_id=${flow}`, { headers: { "x-api-key": key! } });
    expect(res.ok).toBe(true);
    const messages = (await res.json()) as { sender?: string; text?: string; content_blocks?: { contents?: Leaf[] }[] }[];

    const missing: string[] = [];
    const unread: string[] = [];
    const technical: string[] = [];
    const uncitable: string[] = [];
    const spokenBadly: string[] = [];
    const approvalsWrong: string[] = [];
    let classified = 0;
    let checked = 0;
    let narrated = 0;
    for (const m of messages) {
      if (m.sender !== "Machine") continue;
      const steps = replyToSteps((m.content_blocks ?? []).flatMap((b) => b.contents ?? []));
      const findings = findingsForReply(steps, []);
      const covered = new Set(findings.map((f) => f.step?.id).filter(Boolean));
      for (const s of steps) {
        // Hidden tool steps still drive the status line while they run; hidden notes never show.
        const shown = !s.hidden || s.action !== "note";
        if (shown && (TECHNICAL.test(s.label) || talksMachinery(s.label))) technical.push(`${s.app} status: ${s.label}`);
        if (s.hidden || s.action === "note" || s.status === "running") continue;
        checked++;
        // A step that returned something (or failed) must say so; one that returned nothing
        // at all (e.g. opening a browser) has nothing to report.
        if (!covered.has(s.id) && (s.preview || s.status === "failed")) missing.push(`${s.app}: ${s.label}`);
        // A tool that sent back real data must leave a receipt; otherwise its result was
        // dropped (e.g. an unrecognized response shape) and Results shows nothing.
        if (s.status === "done" && !s.preview && (s.returned ?? 0) > 300) unread.push(`${s.app}: ${s.label}`);
        if (TECHNICAL.test(s.label) || (s.detail && TECHNICAL.test(s.detail))) technical.push(`${s.app} step: ${s.label} / ${s.detail ?? ""}`);
      }
      for (const f of findings) if (TECHNICAL.test(f.text)) technical.push(`${f.app} finding: ${f.text}`);
      // On a call, every step line the voice says is a label the agent reported, and reads well.
      let relay = initialRelay();
      for (const s of steps) {
        const out = relayEvent(relay, { type: "activity", step: s });
        relay = out.state;
        for (const line of out.lines) {
          narrated++;
          const reported = steps.some((x) => line.text === x.label.trim() || line.text === spokenStep(x.label));
          if (!reported || TECHNICAL.test(line.text) || talksMachinery(line.text)) spokenBadly.push(`${s.app} narration: ${line.text}`);
        }
      }
      const gist = speakableGist(m.text ?? "");
      if (/[[\]{}<>`*#|]|https?:\/\//.test(gist)) spokenBadly.push(`spoken reply: ${gist}`);
      // The same reply as a voice note: to a voice message, and as a task run's news, with each
      // report the run made.
      const final = { id: "r", conversationId: "c", role: "assistant", content: m.text ?? "", status: "complete", activity: [], artifacts: [], createdAt: 0 } as ChatMessage;
      const asked = (origin: ChatMessage["origin"]) => ({ ...final, role: "user", origin }) as ChatMessage;
      const reports = (m.content_blocks ?? [])
        .flatMap((b) => b.contents ?? [])
        .filter((l) => l.type === "tool_use" && l.name === "report_run")
        .map((l) => (l.tool_input ?? l.input ?? {}) as Partial<RunReport>)
        .map((r): RunReport => ({ outcome: r.outcome === "needs_you" ? "needs_you" : "update", summary: typeof r.summary === "string" ? r.summary : "" }));
      const notes = [
        voiceNoteFor(final, { answered: asked({ kind: "voice", via: "note" }) }),
        ...reports.map((report) => voiceNoteFor(final, { answered: asked({ kind: "task", taskId: "t", title: "Task", runId: null }), report })),
      ];
      for (const note of notes) if (note && /[[\]{}<>`*#|]|https?:\/\//.test(note.script)) spokenBadly.push(`voice note: ${note.script}`);
      // Every action the agent asked approval for, as the call would classify it.
      for (const leaf of (m.content_blocks ?? []).flatMap((b) => b.contents ?? []).filter((l) => l.type === "tool_use" && l.name === "take_action")) {
        const pause = approvalFor({ action_requests: [{ name: "take_action", args: leaf.tool_input ?? leaf.input ?? {} }] });
        const spoken = spokenApprovalFor({ actions: pause.actions, summary: pause.summary });
        classified++;
        const slugs = pause.actions.map((a) => a.tool).join(", ");
        const words = pause.actions.flatMap((a) => a.tool.split("_"));
        const risky = words.some((w) => /^(PAY|PAYMENT|CHARGE|REFUND|TRANSFER|PAYOUT|INVOICE|DELETE|REMOVE|TRASH|PURGE|CLEAR|ARCHIVE)$/.test(w));
        if (risky && spoken.voiceOk) approvalsWrong.push(`voice-ok money or deletion: ${slugs}`);
        if (spoken.voiceOk && (SPOKEN_TECHNICAL.test(spoken.readBack) || spoken.readBack.length > 400)) approvalsWrong.push(`read-back: ${spoken.readBack}`);
        if (!spoken.voiceOk && !spoken.tapOnly) approvalsWrong.push(`unclassified: ${slugs}`);
      }
      // Every link a tool returned must come with that result's text, or the agent can't cite
      // it with a checkable quote (src/lib/chat/citations.ts).
      const leaves = (m.content_blocks ?? []).flatMap((b) => b.contents ?? []).filter((l) => l.type === "tool_use");
      const evidence = new Set(evidenceFor(leaves.map((l) => ({ name: l.name ?? "tool", input: l.tool_input ?? l.input ?? {}, output: l.output, error: l.error }))).map((e) => e.url));
      for (const url of linksSeen(steps, [])) if (!evidence.has(url)) uncitable.push(url);
    }

    expect(checked).toBeGreaterThan(0);
    expect(technical, technical.join("\n")).toEqual([]);
    expect(missing, missing.join("\n")).toEqual([]);
    expect(unread, unread.join("\n")).toEqual([]);
    expect(uncitable, uncitable.join("\n")).toEqual([]);
    expect(narrated).toBeGreaterThan(0);
    expect(spokenBadly, spokenBadly.join("\n")).toEqual([]);
    expect(approvalsWrong, approvalsWrong.join("\n")).toEqual([]);
    // Logged, so a flow that never asked for approval is visible rather than passing quietly.
    console.info(`[audit] ${classified} approvals classified`);
  }, 60_000);
});
