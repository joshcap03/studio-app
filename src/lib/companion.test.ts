import { describe, expect, it } from "vitest";
import { KNOWS_YOU, companionLook, companionName, companionStage, nameProblem, stageRank, toMeet } from "./companion";

const knowsYou = { runs: KNOWS_YOU.readyRuns, days: KNOWS_YOU.readyDays, conversations: KNOWS_YOU.readyConversations, setupSettled: true };

describe("companionStage", () => {
  it("starts as a sketch", () => {
    expect(companionStage({ runs: 0, days: 0, conversations: 0, setupSettled: true })).toBe("sketch");
    expect(companionStage({ runs: KNOWS_YOU.drawnRuns - 1, days: 3, conversations: 3, setupSettled: true })).toBe("sketch");
  });

  it("is drawn in after some real use", () => {
    expect(companionStage({ runs: KNOWS_YOU.drawnRuns, days: 1, conversations: 1, setupSettled: false })).toBe("drawn");
  });

  it("is ready only once every sign that it knows them holds", () => {
    expect(companionStage(knowsYou)).toBe("ready");
    expect(companionStage({ ...knowsYou, runs: KNOWS_YOU.readyRuns - 1 })).toBe("drawn");
    expect(companionStage({ ...knowsYou, days: KNOWS_YOU.readyDays - 1 })).toBe("drawn");
    expect(companionStage({ ...knowsYou, conversations: KNOWS_YOU.readyConversations - 1 })).toBe("drawn");
  });

  it("waits for setup to settle", () => {
    expect(companionStage({ ...knowsYou, runs: 50, setupSettled: false })).toBe("drawn");
  });

  it("orders the stages", () => {
    expect(stageRank("sketch")).toBeLessThan(stageRank("drawn"));
    expect(stageRank("drawn")).toBeLessThan(stageRank("ready"));
    expect(stageRank("ready")).toBeLessThan(stageRank("arrived"));
  });
});

describe("toMeet", () => {
  it("tells someone new what to do to meet their agent", () => {
    expect(toMeet({ runs: 0, days: 0, conversations: 0, setupSettled: true })).toBe(
      "Send ten more messages, start three more chats and use me on two different days, and I'll come to life and you can name me.",
    );
  });

  it("names only the steps still left, counting down with real use", () => {
    expect(toMeet({ ...knowsYou, conversations: KNOWS_YOU.readyConversations - 1 })).toBe("Start one more chat, and I'll come to life and you can name me.");
    expect(toMeet({ ...knowsYou, runs: KNOWS_YOU.readyRuns - 1, days: 1 })).toBe(
      "Send one more message and come back another day, and I'll come to life and you can name me.",
    );
    expect(toMeet({ ...knowsYou, setupSettled: false })).toBe("Finish setting me up, and I'll come to life and you can name me.");
  });

  it("says soon once nothing is left", () => {
    expect(toMeet(knowsYou)).toBe("I'll come to life soon, and you can name me.");
  });
});

describe("companionLook", () => {
  it("is the same for the same agent and member, every time", () => {
    expect(companionLook("ws-1", "user-1")).toEqual(companionLook("ws-1", "user-1"));
  });

  it("varies across agents", () => {
    const looks = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(companionLook(`ws-${i}`, "user-1"))));
    expect(looks.size).toBeGreaterThan(8);
    const shapes = new Set(Array.from({ length: 40 }, (_, i) => companionLook(`ws-${i}`, "user-1").shape));
    const tints = new Set(Array.from({ length: 40 }, (_, i) => companionLook(`ws-${i}`, "user-1").tint));
    expect(shapes.size).toBe(4);
    expect(tints.size).toBe(4);
  });
});

describe("names", () => {
  it("tidies a name and refuses what isn't one", () => {
    expect(companionName("  Juniper. ")).toBe("Juniper");
    expect(companionName("\u201cRowan\u201d")).toBe("Rowan");
    expect(companionName("José")).toBe("José");
    expect(companionName("Mae-Lin O'Hara")).toBe("Mae-Lin O'Hara");
    expect(companionName("")).toBeNull();
    expect(companionName("R2D2")).toBeNull();
    expect(companionName("x".repeat(41))).toBeNull();
    expect(companionName(42)).toBeNull();
  });

  it("won't take the member's own name or another of their agents'", () => {
    expect(nameProblem("sam", { member: "Sam", taken: [] })).toMatch(/your own name/);
    expect(nameProblem("June", { member: "Sam", taken: ["june"] })).toMatch(/Another of your agents/);
    expect(nameProblem("Juniper", { member: "Sam", taken: ["June"] })).toBeNull();
    expect(nameProblem("Juniper", { member: null, taken: [] })).toBeNull();
  });
});
