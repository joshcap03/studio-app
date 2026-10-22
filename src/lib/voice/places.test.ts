import { describe, expect, it } from "vitest";
import { nameScore, parseOpen, resolvePlace, type PlaceIndex } from "./places";

const index: PlaceIndex = {
  chats: [
    { id: "c1", title: "Ramp procurement prep" },
    { id: "c2", title: "David AI interview" },
    { id: "c3", title: "Ramp onsite logistics" },
  ],
  projects: [{ id: "p1", name: "Fintech pipeline" }],
  tasks: [{ id: "t1", title: "Weekly job digest" }],
  trackers: [{ collection: "applications", name: "Applications" }],
  docs: [
    { title: "Highbeam cover letter", conversationId: "c9" },
    { title: "Salary bands", conversationId: null },
  ],
};

describe("parseOpen", () => {
  it("reads the place and the name from their words", () => {
    expect(parseOpen("Open my tasks")).toEqual({ place: "tasks", name: "" });
    expect(parseOpen("show me the applications tracker please")).toEqual({ place: "tracker", name: "applications" });
    expect(parseOpen("go back to the David AI chat")).toEqual({ place: "chat", name: "david ai" });
    expect(parseOpen("start a new chat")).toEqual({ place: "new_chat", name: "" });
    expect(parseOpen("go back")).toEqual({ place: "back", name: "" });
    expect(parseOpen("pull up Highbeam cover letter")).toEqual({ place: null, name: "highbeam cover letter" });
  });
});

describe("nameScore", () => {
  it("matches a spoken name to a written one", () => {
    expect(nameScore("weekly job digest", "Weekly job digest")).toBe(3);
    expect(nameScore("david", "David AI interview")).toBe(2);
    expect(nameScore("ramps prep", "Ramp procurement prep")).toBe(2);
    expect(nameScore("salary", "Weekly job digest")).toBe(0);
  });
});

describe("resolvePlace", () => {
  it("goes to a page they named outright, whatever the voice read", () => {
    expect(resolvePlace({ said: "open my tasks", place: "chat", name: "tasks" }, index)).toEqual({ kind: "go", path: "/tasks", title: "your task list" });
    expect(resolvePlace({ said: "open settings" }, index)).toEqual({ kind: "go", path: "/settings", title: "Settings", page: true });
    expect(resolvePlace({ said: "go back" }, index)).toEqual({ kind: "back" });
  });
  it("finds the one thing they named, of any kind", () => {
    expect(resolvePlace({ said: "open the applications tracker" }, index)).toEqual({ kind: "go", path: "/library/applications", title: "Applications" });
    expect(resolvePlace({ said: "go to the David chat" }, index)).toEqual({ kind: "go", path: "/c/c2", title: "David AI interview" });
    expect(resolvePlace({ said: "show me the job digest" }, index)).toEqual({ kind: "go", path: "/tasks/t1", title: "Weekly job digest" });
    expect(resolvePlace({ said: "open the fintech pipeline" }, index)).toEqual({ kind: "go", path: "/p/p1", title: "Fintech pipeline" });
    // A doc opens in the chat it came from, else the Library.
    expect(resolvePlace({ said: "pull up the Highbeam cover letter" }, index)).toEqual({ kind: "go", path: "/c/c9", title: "Highbeam cover letter" });
    expect(resolvePlace({ said: "open salary bands" }, index)).toEqual({ kind: "go", path: "/library", title: "Salary bands" });
  });
  it("asks which when two fit, and is nowhere when nothing does", () => {
    expect(resolvePlace({ said: "open the Ramp chat" }, index)).toEqual({ kind: "which", options: ["Ramp procurement prep", "Ramp onsite logistics"] });
    expect(resolvePlace({ said: "open a ticket with support" }, index)).toEqual({ kind: "none" });
  });
});
