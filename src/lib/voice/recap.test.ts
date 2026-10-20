import { describe, expect, it } from "vitest";
import type { Approval, CallSummary, ChatMessage, UiBlock } from "@/lib/types";
import { callLength, callRecap, recapsByMessage, withHeldWords } from "./recap";

const CALL = "call-1";
const call: CallSummary = { id: CALL, startedAt: 1_000_000, endedAt: 1_300_000 };

let n = 0;
const msg = (patch: Partial<ChatMessage>): ChatMessage => ({
  id: `m${(n += 1)}`,
  conversationId: "c1",
  role: "assistant",
  content: "",
  status: "complete",
  activity: [],
  artifacts: [],
  createdAt: 1_000_000 + n * 1000,
  ...patch,
});
const said = (content: string, patch: Partial<ChatMessage> = {}) => msg({ role: "user", content, origin: { kind: "voice", sessionId: CALL }, ...patch });
const step = (id: string, label: string, status: "done" | "failed" | "running" = "done", patch = {}) => ({ id, label, status, app: "web", action: "search" as const, startedAt: 0, ...patch });
const form: UiBlock = { kind: "form", id: "f", title: "Your search", fields: [], submitLabel: "Send" };
const approval = (patch: Partial<Approval>): Approval => ({ id: "a", summary: "Send the reply to Jo", details: [], status: "pending", createdAt: 0, ...patch });

describe("callRecap", () => {
  it("says what they asked in their words, what got done, what they decided, and what's still out", () => {
    const messages = [
      msg({ role: "user", content: "Earlier, typed." }),
      msg({ content: "Earlier reply.", activity: [step("e", "Searched earlier")] }),
      said("Find me remote design roles"),
      msg({
        content: "Found three.",
        activity: [
          step("s1", "Searched LinkedIn"),
          step("s2", "Read 12 postings", "done", { action: "read" }),
          step("s3", "Couldn't open Wellfound", "failed"),
          step("n", "Let me look", "done", { action: "note" }),
          step("h", "Looked up tools", "done", { hidden: true }),
          step("p", "Updated the plan", "done", { action: "write" }),
          step("m", "Remembered something", "done", { action: "remember", app: "memory" }),
        ],
        artifacts: [{ id: "doc", kind: "document", title: "Shortlist", url: "https://docs.example/1" }],
        ui: [form],
        uiResponse: { f: { status: "submitted", at: 1_005_500 } },
      }),
      // The form's answers, sent on the call: under "decided", not "asked".
      said("Roles: Senior designer"),
      msg({ status: "awaiting", content: "Here's the reply to Jo.", approvals: [approval({ id: "a1" })] }),
    ];
    const recap = callRecap(messages, call)!;
    expect(recap.asked).toEqual(["Find me remote design roles"]);
    expect(recap.did).toEqual([
      { label: "Searched LinkedIn", failed: false },
      { label: "Read 12 postings", failed: false },
      { label: "Couldn't open Wellfound", failed: true },
    ]);
    expect(recap.made.map((a) => a.title)).toEqual(["Shortlist"]);
    expect(recap.decided).toEqual(["Sent “Your search”"]);
    expect(recap.out).toEqual([{ kind: "waiting", text: "Your OK: Send the reply to Jo" }]);
    expect(recap.after).toBe(messages.at(-1)!.id);
    expect(recap.seconds).toBe(300);
  });

  it("keeps saying a job is out on it until it lands, and what it asks once it has", () => {
    const going = [said("Run the weekly check"), msg({ status: "streaming", activity: [step("s", "Searching Gmail", "running")] })];
    expect(callRecap(going, call)!.out).toEqual([{ kind: "working", text: "I'm still on it" }]);
    const landed = [going[0], { ...going[1], status: "complete" as const, content: "Two need you. Which first?", ui: [form] }];
    expect(callRecap(landed, call)!.out).toEqual([{ kind: "waiting", text: "Waiting on you: “Your search”" }]);
    // Once the conversation has moved on, an old card isn't what's out.
    expect(callRecap([...landed, msg({ role: "user", content: "Later, typed." })], call)!.out).toEqual([]);
  });

  it("counts decisions made while it was on, on any reply here", () => {
    const before = msg({
      content: "Here's how I'd work.",
      ui: [{ kind: "proposal", id: "p", summary: "s", skills: [], tasks: [], memories: [] }],
      uiResponse: { p: { status: "applied", at: 1_100_000, picks: { profile: true, instructions: false, skills: [], tasks: [0], memories: [] }, applied: { settings: true, skills: 0, tasks: 1, memories: 0, skipped: 0 } } },
      approvals: [approval({ id: "old", status: "approved", decidedAt: 900_000 }), approval({ id: "new", summary: "Email Dana", status: "declined", decidedAt: 1_200_000 })],
    });
    const recap = callRecap([before, said("Do the first one now"), msg({ content: "Started." })], call)!;
    expect(recap.decided).toEqual(["Applied: updated what it's for and how it works, 1 task on", "Declined: Email Dana"]);
  });

  it("is nothing while the call is going, or for a call nothing was said on here", () => {
    const messages = [said("Hi"), msg({ content: "Hey." })];
    expect(callRecap(messages, { ...call, endedAt: null })).toBeNull();
    expect(callRecap(messages, { ...call, id: "other" })).toBeNull();
    // Words held as a voice message, or said on a call before calls had recaps, belong to no call.
    expect(callRecap([msg({ role: "user", content: "Hi", origin: { kind: "voice" } })], { ...call, id: "" })).toBeNull();
  });

  it("goes after the call's last message, one per call", () => {
    const second: CallSummary = { id: "call-2", startedAt: 2_000_000, endedAt: 2_060_000 };
    const first = [said("First call"), msg({ content: "One." })];
    const later = [msg({ role: "user", content: "Typed between.", createdAt: 1_500_000 }), msg({ content: "Two.", createdAt: 1_501_000 })];
    const again = [said("Second call", { origin: { kind: "voice", sessionId: "call-2" }, createdAt: 2_010_000 }), msg({ content: "Three.", createdAt: 2_011_000 })];
    const all = [...first, ...later, ...again];
    const recaps = recapsByMessage(all, [call, second]);
    expect([...recaps.keys()]).toEqual([first[1].id, again[1].id]);
    expect(recaps.get(again[1].id)![0].asked).toEqual(["Second call"]);
    expect(recapsByMessage(all, [{ ...second, endedAt: null }]).size).toBe(0);
  });
});

describe("a recap quotes only the member's own words", () => {
  it("files a question card's picks said on the call under decided, and keeps free words they said in reply", () => {
    const ask = msg({ content: "Two quick ones.", questions: [{ question: "Where should I look?", options: [{ label: "Remote" }, { label: "Austin, TX" }], multiSelect: true }] });
    const picked = callRecap([said("Find roles"), ask, said("Remote, Austin, TX"), msg({ content: "On it." })], call)!;
    expect(picked.asked).toEqual(["Find roles"]);
    expect(picked.decided).toEqual(["Answered “Where should I look?”"]);
    const both = { ...ask, questions: [...ask.questions!, { question: "Which level?", header: "Level", options: [{ label: "Senior" }], multiSelect: false }] };
    expect(callRecap([said("Find roles"), both, said("Where should I look? Remote\nLevel: Senior"), msg({ content: "On it." })], call)!.decided).toEqual(["Answered 2 questions"]);
    const own = callRecap([said("Find roles"), ask, said("Remote, but nothing in Austin"), msg({ content: "On it." })], call)!;
    expect(own.asked).toEqual(["Find roles", "Remote, but nothing in Austin"]);
    expect(own.decided).toEqual([]);
  });

  it("quotes words held while it worked apart from what they went along with, without the joiner", () => {
    const messages = [said("Find roles"), msg({ content: "Found two." }), said(withHeldWords("Look in Austin too", "No agencies")), msg({ content: "Okay." })];
    expect(callRecap(messages, call)!.asked).toEqual(["Find roles", "Look in Austin too", "No agencies"]);
    // Held words that went along with a card's answers are still theirs.
    const ask = msg({ content: "Where?", questions: [{ question: "Where?", options: [{ label: "Remote" }], multiSelect: false }] });
    const recap = callRecap([said("Find roles"), ask, said(withHeldWords("Remote", "And no agencies")), msg({ content: "Okay." })], call)!;
    expect(recap.asked).toEqual(["Find roles", "And no agencies"]);
    expect(recap.decided).toEqual(["Answered “Where?”"]);
    expect(withHeldWords("Remote", "")).toBe("Remote");
  });
});

describe("a call that followed a task's run", () => {
  it("has a recap where it went, from the run's start, saying it's out until it lands", () => {
    const earlier = [msg({ role: "user", content: "Last week's run", origin: { kind: "task", taskId: "t", title: "Weekly roles", runId: "r0" } }), msg({ content: "Nothing new." })];
    const brief = msg({ role: "user", content: "Check for new roles", origin: { kind: "task", taskId: "t", title: "Weekly roles", runId: "r1" } });
    const going = msg({ status: "streaming", activity: [step("s1", "Searched LinkedIn")] });
    const followed = { ...call, followedFrom: brief.id };
    const recap = callRecap([...earlier, brief, going], followed)!;
    expect(recap).toMatchObject({ asked: [], decided: [], did: [{ label: "Searched LinkedIn", failed: false }], out: [{ kind: "working", text: "I'm still on it" }], after: going.id });
    const landed = callRecap([...earlier, brief, { ...going, status: "complete" as const, content: "Two new roles." }], followed)!;
    expect(landed.out).toEqual([]);
    // Without the follow, nothing was said on it here.
    expect(callRecap([...earlier, brief, going], call)).toBeNull();
  });

  it("says where it was that it started the run, and that it's still out there", () => {
    const messages = [said("Do the first one now"), msg({ content: "Starting it." })];
    const away = (move: "working" | "your_call" | null) => ({ ...call, away: [{ title: "Weekly roles", move }] });
    expect(callRecap(messages, away("working"))).toMatchObject({ decided: ["Started “Weekly roles”"], out: [{ kind: "working", text: "I'm still on “Weekly roles”" }] });
    expect(callRecap(messages, away("your_call"))!.out).toEqual([{ kind: "waiting", text: "Waiting on you: “Weekly roles”" }]);
    expect(callRecap(messages, away(null))!.out).toEqual([]);
  });
});

describe("callLength", () => {
  it("says how long in a few words", () => {
    expect(callLength(40)).toBe("under a minute");
    expect(callLength(240)).toBe("4 min");
  });
});

describe("approvals decided by voice", () => {
  it("quote the member's words", () => {
    const call = { id: "call", startedAt: 1_000_000, endedAt: 1_300_000 };
    const messages = [
      msg({ id: "u1", role: "user", content: "Email Jo", origin: { kind: "voice", sessionId: "call" }, createdAt: 1_010_000 }),
      msg({
        id: "r1",
        status: "complete",
        content: "Sent.",
        createdAt: 1_020_000,
        approvals: [
          approval({ id: "a1", status: "approved", decidedAt: 1_100_000, decidedVia: "voice", decidedWords: "send it" }),
          approval({ id: "a2", summary: "Email Dana", status: "declined", decidedAt: 1_200_000, decidedVia: "voice", decidedWords: "don't send it" }),
          approval({ id: "a3", summary: "Email Lee", status: "approved", decidedAt: 1_250_000, decidedVia: "tap" }),
        ],
      }),
    ];
    expect(callRecap(messages, call)?.decided).toEqual([
      "Approved by voice (“send it”): Send the reply to Jo",
      "Declined by voice (“don't send it”): Email Dana",
      "Approved: Email Lee",
    ]);
  });
});
