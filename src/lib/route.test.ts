import { afterEach, describe, expect, it, vi } from "vitest";
import { heuristicRoute, routeAnswer, routePrompt, type AgentCard } from "./route";

// Which agent takes an ask from Home, without a model: by keyword overlap, sure only on a clear win.

const cards: AgentCard[] = [
  { id: "a", name: "Atelier", companionName: "Rowan", template: "Helps run a shop: customers, sales, stock, money.", profile: "A joinery workshop: quotes, orders, suppliers, invoices.", recentTitles: ["Quote for the Marsh kitchen", "Who still owes an invoice"], taskTitles: ["Monday: who owes"] },
  { id: "b", name: "Inbox & calendar", companionName: null, template: "Triages your email, drafts replies, preps meetings.", profile: "", recentTitles: ["Replies to Tuesday's inbox"], taskTitles: ["Weekdays: inbox triage"] },
];

afterEach(() => vi.restoreAllMocks());

describe("heuristicRoute", () => {
  it("is sure when one agent's name or work clearly matches", () => {
    expect(heuristicRoute("Ask Rowan to draft the invoice for the Hendersons", cards, "b")).toEqual({ workspaceId: "a", sure: true, by: "heuristic" });
    expect(heuristicRoute("Go through my inbox and draft replies", cards, "a")).toEqual({ workspaceId: "b", sure: true, by: "heuristic" });
  });

  it("isn't sure on a near tie, and falls back to the last agent with no overlap at all", () => {
    // Two hits each: replies (inbox) against quote and invoice (the shop).
    expect(heuristicRoute("Draft the replies about the quote and the invoice", cards, "b")).toMatchObject({ sure: false, by: "heuristic" });
    expect(heuristicRoute("What's the weather like", cards, "b")).toEqual({ workspaceId: "b", sure: false, by: "last" });
    expect(heuristicRoute("anything", [], "a")).toEqual({ workspaceId: "a", sure: false, by: "last" });
  });
});

describe("routeAnswer", () => {
  it("accepts only one of the numbered agents", () => {
    expect(routeAnswer(2).safeParse({ agent: "2", sure: true }).success).toBe(true);
    expect(routeAnswer(2).safeParse({ agent: 3, sure: true }).success).toBe(false);
    expect(routeAnswer(2).safeParse({ agent: 0 }).success).toBe(false);
    expect(routeAnswer(2).safeParse({ agent: "x" }).success).toBe(false);
    expect(routeAnswer(2).parse({ agent: 1 })).toEqual({ agent: 1, sure: false });
  });
});

describe("routePrompt", () => {
  it("numbers the agents and never shows their ids", () => {
    const { system, user } = routePrompt("Draft the invoice", cards);
    expect(system).toMatch(/JSON only/);
    expect(user).toContain('"""Draft the invoice"""');
    expect(user).toContain("1. Atelier (goes by Rowan)");
    expect(user).toContain("2. Inbox & calendar");
    expect(user).not.toContain('"a"');
    expect(user).toContain("nothing written yet");
  });

  it("caps the ask", () => {
    const { user } = routePrompt("x".repeat(5000), cards);
    expect(user.length).toBeLessThan(2500);
  });
});
