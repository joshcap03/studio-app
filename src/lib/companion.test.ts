import { describe, expect, it } from "vitest";
import { KNOWS_YOU, companionLook, companionStage, stageRank } from "./companion";

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
