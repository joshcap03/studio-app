import { describe, expect, it } from "vitest";
import type { ChatMessage, Journey, JourneyStep } from "@/lib/types";
import { shownJourney } from "./shown-journey";

const steps = (...statuses: JourneyStep["status"][]): JourneyStep[] => statuses.map((status, i) => ({ text: `Step ${i + 1}`, status }));
const journey = (kind: Journey["kind"], ...statuses: JourneyStep["status"][]): Journey => ({ kind, goal: "a prep doc", steps: steps(...statuses), updatedAt: 100 });
const reply = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "r", conversationId: "c", role: "assistant", content: "Here it is.", status: "complete", createdAt: 50, ...patch }) as ChatMessage;
const asked: ChatMessage = { id: "u", conversationId: "c", role: "user", content: "Go", status: "complete", createdAt: 40 } as ChatMessage;
const thread = (j: Journey, ...messages: ChatMessage[]) => ({ status: "ready", journey: j, messages: [asked, ...messages] });

describe("shownJourney", () => {
  it("drops a conversation's plan the agent left on a step when it ended its reply", () => {
    expect(shownJourney(thread(journey("conversation", "done", "done", "doing", "todo"), reply()), false)).toBeNull();
  });

  it("keeps it while the reply runs", () => {
    const j = journey("conversation", "done", "doing");
    expect(shownJourney(thread(j, reply({ status: "streaming" })), true)).toBe(j);
  });

  it("keeps it while the job carries on in a next reply", () => {
    const j = journey("conversation", "done", "doing");
    expect(shownJourney(thread(j, reply({ keepGoing: "the rest" })), false)).toBe(j);
  });

  it("keeps it when the reply waits on the member", () => {
    const j = journey("conversation", "doing", "todo");
    expect(shownJourney(thread(j, reply({ questions: [{ question: "Which?" }] as ChatMessage["questions"] })), false)).toBe(j);
  });

  it("keeps it when the reply ends on a question in plain words", () => {
    const j = journey("conversation", "doing", "todo");
    expect(shownJourney(thread(j, reply({ content: "Which is harder right now?\n" })), false)).toBe(j);
  });

  it("keeps it when the agent reported where it stopped", () => {
    for (const stop of ["blocked", "needs_you"] as const) {
      const j = journey("conversation", "done", stop, "todo");
      expect(shownJourney(thread(j, reply()), false)).toBe(j);
    }
  });

  it("keeps it when the reply stopped short, so the rail can say it's stuck", () => {
    const j = journey("conversation", "done", "doing");
    expect(shownJourney(thread(j, reply({ status: "error" })), false)).toBe(j);
  });

  it("keeps a finished plan and a task's plan", () => {
    const finished = journey("conversation", "done", "done");
    expect(shownJourney(thread(finished, reply()), false)).toBe(finished);
    const task = journey("task", "done", "doing");
    expect(shownJourney(thread(task, reply()), false)).toBe(task);
  });

  it("once the member has written since: shows a plan only while the reply runs", () => {
    const j = journey("conversation", "done", "doing");
    const later = reply({ role: "user", createdAt: 200 });
    expect(shownJourney(thread(j, later), true)).toBe(j);
    expect(shownJourney(thread(j, later), false)).toBeNull();
    expect(shownJourney(thread(journey("conversation", "done"), later), true)).toBeNull();
  });
});
