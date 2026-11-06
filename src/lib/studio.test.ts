import { describe, expect, it } from "vitest";
import { ASKS, approvalsLine, knowledge, knowledgeLine, missingApps, nextStep, partPath, partsNeeding, routineChain, skillOrigin, type StudioSignals } from "@/lib/studio";
import type { Memory } from "@/lib/types";

const set: StudioSignals = { setup: "done", companion: "arrived", missingApps: [], hasChats: true, onHome: true, several: true, owner: true };
const gmail = { slug: "gmail", name: "Gmail" };

describe("nextStep", () => {
  it("asks the owner to finish setup before anything else", () => {
    expect(nextStep({ ...set, setup: "in_progress", missingApps: [gmail] }).action).toMatchObject({ kind: "setup", label: "Finish setting up" });
    expect(nextStep({ ...set, setup: "not_started" }).action).toMatchObject({ kind: "setup" });
  });

  it("never asks a non-owner to set up", () => {
    expect(nextStep({ ...set, owner: false, setup: null, missingApps: [gmail] }).action).toMatchObject({ kind: "connect", slug: "gmail" });
  });

  it("names the first app the template still wants", () => {
    const step = nextStep({ ...set, missingApps: [gmail, { slug: "stripe", name: "Stripe" }] });
    expect(step.text).toBe("Connect Gmail so I can use it for you.");
    expect(step.action).toMatchObject({ kind: "connect", slug: "gmail", label: "Connect Gmail" });
  });

  it("offers hello once the companion is ready, then a first chat, then Home", () => {
    expect(nextStep({ ...set, companion: "ready" }).action).toMatchObject({ kind: "hello" });
    expect(nextStep({ ...set, hasChats: false }).action).toMatchObject({ kind: "chat" });
    expect(nextStep({ ...set, onHome: false }).action).toMatchObject({ kind: "home" });
    expect(nextStep({ ...set, onHome: false, owner: false }).action).toBeNull();
    expect(nextStep({ ...set, onHome: false, several: false }).action).toBeNull();
  });

  it("says it's set when nothing's missing", () => {
    expect(nextStep(set)).toEqual({ text: "I'm set. Change anything below whenever you like.", action: null });
  });
});

describe("partsNeeding", () => {
  it("marks nothing on an agent that's set", () => {
    expect(partsNeeding(set)).toEqual([]);
  });

  it("marks the part that can help: setup on the brief, a missing app on apps", () => {
    expect(partsNeeding({ ...set, setup: "in_progress", missingApps: [gmail] })).toEqual(["brief", "apps"]);
    expect(partsNeeding({ ...set, setup: "not_started" })).toEqual(["brief"]);
  });

  it("doesn't ask a member who isn't the owner to set it up", () => {
    expect(partsNeeding({ ...set, owner: false, setup: "not_started" })).toEqual([]);
  });
});

describe("partPath", () => {
  it("gives each part its own address, the brief the workbench's", () => {
    expect(partPath("brief")).toBe("/studio");
    expect(partPath("skills")).toBe("/studio/skills");
  });
});

describe("missingApps", () => {
  it("keeps only what the template suggests that isn't connected or on its way", () => {
    const offered = [
      { slug: "gmail", name: "Gmail", status: "connected" as const },
      { slug: "stripe", name: "Stripe", status: "pending" as const },
      { slug: "shopify", name: "Shopify", status: "disconnected" as const },
      { slug: "slack", name: "Slack", status: "disconnected" as const },
    ];
    expect(missingApps(offered, ["gmail", "stripe", "shopify"])).toEqual([{ slug: "shopify", name: "Shopify" }]);
    expect(missingApps(offered, [])).toEqual([]);
  });
});

describe("knowledge", () => {
  const memory = (category: Memory["category"], pinned = false): Memory => ({ id: category + String(pinned), content: "x", scope: "workspace", createdAt: 0, mine: true, category, pinned });

  it("counts facts by topic, fullest first", () => {
    const k = knowledge([memory("customers"), memory("customers", true), memory("products"), memory("other")]);
    expect(k.total).toBe(4);
    expect(k.pinned).toBe(1);
    expect(k.topics.map((t) => `${t.label} ${t.count}`)).toEqual(["People & contacts 2", "Other 1", "Work & offerings 1"]);
  });

  it("says it in one line", () => {
    expect(knowledgeLine(knowledge([]))).toMatch(/Nothing written down yet/);
    expect(knowledgeLine(knowledge([memory("customers")]))).toBe("It knows one thing about your work.");
    expect(knowledgeLine(knowledge([memory("customers"), memory("products", true)]))).toBe("It knows 2 things about your work, one of them pinned.");
  });
});

describe("approvalsLine", () => {
  it("promises to ask with no standing OKs, and names the sites it may pay on", () => {
    expect(approvalsLine([])).toMatch(/never pays .* without asking/);
    expect(approvalsLine(["gmail_labels", "tool:GMAIL_SEND_EMAIL"])).toMatch(/never pay/);
    expect(approvalsLine(["site:amazon.com"])).toMatch(/^It can pay and order on amazon.com without asking/);
    expect(approvalsLine(["site:amazon.com", "site:uline.com"])).toMatch(/amazon.com and uline.com/);
  });
});

describe("skillOrigin", () => {
  it("tells the library's, the shown, and the worked-out apart", () => {
    expect(skillOrigin({ catalogId: "weekly-review", description: "Weekly review." })).toBe("from the library");
    expect(skillOrigin({ catalogId: null, description: "Reorder supplies the way you showed me." })).toBe("you showed it");
    expect(skillOrigin({ catalogId: null, description: "Follow up with a lead." })).toBe("worked out together");
  });
});

describe("routineChain", () => {
  const task = { title: "Weekly sales report", instructions: "Pull the week's sales and update the Orders list.", status: "active" as const, schedule: { every: "week" as const, at: "08:00", weekday: 1 }, templateTaskId: null, lastRunAt: 1 };
  const opts = { when: "Every Monday at 8:00 AM", skill: "Sales report", watch: null, collections: ["orders", "customers"], lastRun: { status: "done" as const } };

  it("reads left to right from the schedule, the skill, the list it mentions, and how it ended", () => {
    expect(routineChain(task, opts)).toEqual({ when: "Every Monday at 8:00 AM", does: "Weekly sales report, with Sales report", keeps: "orders", hear: "You hear when it's done", notStarted: false });
  });

  it("leaves the skill out when it's named like the task", () => {
    expect(routineChain(task, { ...opts, skill: "weekly sales report" }).does).toBe("Weekly sales report");
  });

  it("starts with the app a watch listens to, and says when it's broken", () => {
    const watched = routineChain({ ...task, schedule: null }, { ...opts, watch: { toolkit: "gmail", status: "watching" } });
    expect(watched.when).toBe("When something happens in Gmail");
    expect(routineChain({ ...task, schedule: null }, { ...opts, watch: { toolkit: "gmail", status: "broken" } }).hear).toBe("It's lost sight of it");
  });

  it("marks a template's task that was never turned on, and a paused one", () => {
    const fresh = routineChain({ ...task, status: "paused", lastRunAt: null, templateTaskId: "t1" }, { ...opts, skill: null, lastRun: null });
    expect(fresh).toMatchObject({ does: "Weekly sales report", hear: "Not started yet", notStarted: true });
    expect(routineChain({ ...task, status: "paused" }, opts).hear).toBe("Paused");
  });

  it("says when it runs only by hand, is working, or went wrong", () => {
    expect(routineChain({ ...task, schedule: null }, opts).when).toBe("When you run it");
    expect(routineChain(task, { ...opts, lastRun: { status: "running" } }).hear).toBe("Working now");
    expect(routineChain(task, { ...opts, lastRun: { status: "failed" } }).hear).toBe("Last time went wrong");
    expect(routineChain({ ...task, instructions: "Nothing listed." }, opts).keeps).toBeNull();
  });
});

describe("asks", () => {
  it("are sentences the member finishes", () => {
    for (const ask of [ASKS.brief, ASKS.remember, ASKS.skill, ASKS.routine, ASKS.app, ASKS.teach, ASKS.routineChange("Weekly")]) expect(ask).toMatch(/\S $/);
  });
});
