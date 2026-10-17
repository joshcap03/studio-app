import { describe, expect, it } from "vitest";
import { runFiles } from "@/lib/agent-files";
import type { AgentAttachment } from "@/lib/agent/types";

const file = (id: string, name = `${id}.pdf`, size = 100): AgentAttachment => ({
  id,
  name,
  mimeType: "application/pdf",
  size,
  read: async () => new Blob(["x"]),
});

describe("runFiles", () => {
  it("sends the agent's files first, then the project's", () => {
    const merged = runFiles([file("a1"), file("a2")], [file("p1")]);
    expect(merged.map((f) => f.id)).toEqual(["a1", "a2", "p1"]);
  });

  it("sends a file once when it's on both shelves", () => {
    const merged = runFiles([file("a1", "resume.pdf", 2048)], [file("a1"), file("p1", "resume.pdf", 2048), file("p2", "resume.pdf", 999)]);
    expect(merged.map((f) => f.id)).toEqual(["a1", "p2"]);
  });

  it("stops at the cap, dropping project files before the agent's", () => {
    const agent = Array.from({ length: 10 }, (_, i) => file(`a${i}`));
    const project = Array.from({ length: 10 }, (_, i) => file(`p${i}`));
    const merged = runFiles(agent, project);
    expect(merged).toHaveLength(15);
    expect(merged.slice(0, 10).map((f) => f.id)).toEqual(agent.map((f) => f.id));
    expect(merged.slice(10).map((f) => f.id)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(runFiles(agent, project, 3).map((f) => f.id)).toEqual(["a0", "a1", "a2"]);
  });

  it("is empty when there are no files", () => {
    expect(runFiles([], [])).toEqual([]);
  });
});
