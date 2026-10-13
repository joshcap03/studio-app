import { describe, expect, it } from "vitest";
import { findingsForReply } from "@/components/chat/findings";
import { interpretCalls, type ToolCall } from "@/lib/agent/tools";
import type { ActivityStep } from "@/lib/types";

// Replays every tool call in a real Langflow flow's history through the same interpreter and
// findings code the app uses, and checks the result reads like it should to a business
// owner: every finished step says what it found (or failed with a plain reason), and no line
// leaks raw data or technical text. Covers every tool the agent has used, not just one.
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
function replyToSteps(leaves: Leaf[]): ActivityStep[] {
  const lastTool = leaves.map((l) => l.type).lastIndexOf("tool_use");
  const calls: ToolCall[] = [];
  const order: ({ kind: "call"; index: number } | { kind: "note"; text: string })[] = [];
  leaves.forEach((leaf, i) => {
    if (leaf.type === "tool_use") {
      order.push({ kind: "call", index: calls.length });
      calls.push({ name: leaf.name ?? "tool", input: leaf.tool_input ?? leaf.input ?? {}, output: leaf.output, error: leaf.error });
    } else if (leaf.type === "text" && i < lastTool && typeof leaf.text === "string" && leaf.text.trim()) {
      order.push({ kind: "note", text: leaf.text.trim() });
    }
  });
  const byIndex = new Map(interpretCalls(calls).map((s) => [s.index, s]));
  return order.flatMap((o, i): ActivityStep[] => {
    if (o.kind === "note") return [{ id: `n${i}`, label: o.text, status: "done", action: "note", app: "agent", startedAt: 0 }];
    const s = byIndex.get(o.index);
    return s ? [{ id: `s${o.index}`, label: s.label, status: s.status, detail: s.detail, app: s.app, action: s.action, preview: s.preview, hidden: s.hidden, startedAt: 0 }] : [];
  });
}

const TECHNICAL = /[{}<>\[\]`]|\b(null|undefined|true|false|nonetype)\b|traceback|object has no attribute|mcp tool|content below|requested_range|\w+_\w+\(/i;

describe.skipIf(!base || !key || !flow)("every real tool call reads well", () => {
  it("gives each finished step a plain finding, and never shows raw or technical text", async () => {
    const res = await fetch(`${base}/api/v1/monitor/messages?flow_id=${flow}`, { headers: { "x-api-key": key! } });
    expect(res.ok).toBe(true);
    const messages = (await res.json()) as { sender?: string; content_blocks?: { contents?: Leaf[] }[] }[];

    const missing: string[] = [];
    const technical: string[] = [];
    let checked = 0;
    for (const m of messages) {
      if (m.sender !== "Machine") continue;
      const steps = replyToSteps((m.content_blocks ?? []).flatMap((b) => b.contents ?? []));
      const findings = findingsForReply(steps, []);
      const covered = new Set(findings.map((f) => f.step?.id).filter(Boolean));
      for (const s of steps) {
        if (s.hidden || s.action === "note" || s.status === "running") continue;
        checked++;
        // A step that returned something (or failed) must say so; one that returned nothing
        // at all (e.g. opening a browser) has nothing to report.
        if (!covered.has(s.id) && (s.preview || s.status === "failed")) missing.push(`${s.app}: ${s.label}`);
        if (TECHNICAL.test(s.label) || (s.detail && TECHNICAL.test(s.detail))) technical.push(`${s.app} step: ${s.label} / ${s.detail ?? ""}`);
      }
      for (const f of findings) if (TECHNICAL.test(f.text)) technical.push(`${f.app} finding: ${f.text}`);
    }

    expect(checked).toBeGreaterThan(0);
    expect(technical, technical.join("\n")).toEqual([]);
    expect(missing, missing.join("\n")).toEqual([]);
  }, 60_000);
});
