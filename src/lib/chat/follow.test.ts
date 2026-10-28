import { describe, expect, it } from "vitest";
import type { ActivityStep, ChatMessage, ConversationSummary } from "@/lib/types";
import { followEvents, joinedEvents, followAnchor, keepEarlier, mergeSince } from "./follow";

const conversation: ConversationSummary = { id: "c1", title: "Find roles", projectId: null, createdAt: 0, updatedAt: 0 };
const step = (id: string, status: ActivityStep["status"], label = "Searching LinkedIn"): ActivityStep => ({ id, label, status, startedAt: 0 });
const msg = (patch: Partial<ChatMessage>): ChatMessage => ({
  id: "r1",
  conversationId: "c1",
  role: "assistant",
  content: "",
  status: "streaming",
  activity: [],
  artifacts: [],
  createdAt: 0,
  ...patch,
});
const asked = msg({ id: "u1", role: "user", content: "Find roles", status: "complete" });
const types = (events: ReturnType<typeof followEvents>) => events.map((e) => e.type);

describe("followEvents", () => {
  it("tells a run nobody announced from its start, with everything it has so far", () => {
    const after = [asked, msg({ activity: [step("s1", "done", "Searched LinkedIn"), step("s2", "running", "Reading postings")], content: "Found" })];
    const events = followEvents([asked], after, conversation, new Set());
    expect(types(events)).toEqual(["start", "activity", "activity", "text"]);
    expect(events[0]).toMatchObject({ type: "start", assistantMessage: { id: "r1" }, conversation });
    expect(events[3]).toEqual({ type: "text", delta: "Found" });
  });

  it("tells only what changed for a run already announced, and its end", () => {
    const before = [asked, msg({ activity: [step("s1", "running")], content: "Found two" })];
    const going = [asked, msg({ activity: [step("s1", "done", "Searched LinkedIn"), step("s2", "running", "Reading postings")], content: "Found two roles." })];
    const events = followEvents(before, going, conversation, new Set(["r1"]));
    expect(events).toEqual([
      { type: "activity", step: going[1].activity[0] },
      { type: "activity", step: going[1].activity[1] },
      { type: "text", delta: " roles." },
    ]);
    // Rewritten text replaces; a finished reply ends, with what it says now.
    const done = [asked, msg({ status: "complete", activity: going[1].activity, content: "Two roles cleared your bar." })];
    expect(followEvents(going, done, conversation, new Set(["r1"]))).toEqual([
      { type: "text-replace", text: "Two roles cleared your bar." },
      { type: "end", message: done[1], conversation },
    ]);
    // Paused for an OK is an end too, as it is when streamed.
    expect(types(followEvents(going, [asked, { ...going[1], status: "awaiting" }], conversation, new Set(["r1"])))).toEqual(["end"]);
  });

  it("tells a run that started and finished between two loads whole", () => {
    const after = [asked, msg({ status: "complete", activity: [step("s1", "done")], content: "Done." })];
    expect(types(followEvents([asked], after, conversation, new Set()))).toEqual(["start", "activity", "text", "end"]);
  });

  it("says nothing about replies that didn't change", () => {
    const old = msg({ id: "r0", status: "complete", content: "Earlier." });
    expect(followEvents([asked, old], [asked, old], conversation, new Set())).toEqual([]);
    const going = msg({ activity: [step("s1", "running")], content: "Found" });
    expect(followEvents([asked, going], [asked, going], conversation, new Set(["r1"]))).toEqual([]);
  });
});

describe("joinedEvents", () => {
  const older = msg({ id: "r0", status: "complete", content: "Last week: nothing new." });
  const brief = msg({ id: "u2", role: "user", content: "Check for new roles", status: "complete" });

  it("tells the run a call followed into whole, even one over before it loaded, and nothing older", () => {
    for (const status of ["complete", "error", "awaiting"] as const) {
      const run = msg({ id: "r2", status, activity: [step("s1", "done", "Searched LinkedIn")], content: status === "error" ? "" : "Two new roles." });
      const events = joinedEvents([asked, older, brief, run], conversation, new Set());
      expect(types(events), status).toEqual(status === "error" ? ["start", "activity", "end"] : ["start", "activity", "text", "end"]);
      expect(events[0]).toMatchObject({ type: "start", assistantMessage: { id: "r2" } });
      expect(events.at(-1)).toEqual({ type: "end", message: run, conversation });
    }
  });

  it("tells one still going from its start, for the follower to carry on from", () => {
    const run = msg({ id: "r2", activity: [step("s1", "running")] });
    expect(types(joinedEvents([asked, older, brief, run], conversation, new Set()))).toEqual(["start", "activity"]);
    // One already told says nothing more here.
    expect(joinedEvents([asked, older, brief, { ...run, status: "complete" }], conversation, new Set(["r2"]))).toEqual([]);
    expect(joinedEvents([asked], conversation, new Set())).toEqual([]);
  });
});

describe("following with little traffic", () => {
  const m = (id: string, content = id) => ({ id, content });

  it("asks from the last message the server knows, never a placeholder", () => {
    expect(followAnchor([m("a"), m("b"), m("pending-user"), m("pending-reply")])).toBe("b");
    expect(followAnchor([m("pending-user")])).toBeNull();
    expect(followAnchor([])).toBeNull();
  });

  it("brings the page up to date from that message on, keeping what came before", () => {
    const before = [m("a"), m("b"), m("c", "work…")];
    expect(mergeSince(before, [m("c", "done"), m("d")], "c")).toEqual([m("a"), m("b"), m("c", "done"), m("d")]);
    // A placeholder the page had after the anchor gives way to the server's copy.
    expect(mergeSince([...before, m("pending-x")], [m("c"), m("e")], "c")).toEqual([m("a"), m("b"), m("c"), m("e")]);
    expect(mergeSince(before, [m("z")], "gone")).toBeNull();
  });

  it("keeps the earlier messages the member read back to when the newest page loads again", () => {
    const read = { messages: [m("a"), m("b"), m("c"), m("d")], earlier: false };
    expect(keepEarlier(read, { messages: [m("c"), m("d", "new"), m("e")], earlier: true })).toEqual({
      messages: [m("a"), m("b"), m("c"), m("d", "new"), m("e")],
      earlier: false,
    });
    // Nothing in common (a fresh load, or the page never had it): the newest page as it is.
    expect(keepEarlier(read, { messages: [m("x")], earlier: true })).toEqual({ messages: [m("x")], earlier: true });
    expect(keepEarlier(undefined, { messages: [m("x")] })).toEqual({ messages: [m("x")], earlier: false });
  });
});
