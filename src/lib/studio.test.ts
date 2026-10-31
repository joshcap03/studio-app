import { describe, expect, it } from "vitest";
import { ASKS, approvalsLine, firstLine, knowledge, knowledgeLine, missingApps, nextStep, readiness, routineChain, skillOrigin, type StudioSignals } from "@/lib/studio";
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

describe("readiness", () => {
  it("fills in with the same signals, and shows On Home only where Home exists", () => {
    expect(readiness(set).map((s) => s.status)).toEqual(["done", "done", "done", "done", "done"]);
    const early = readiness({ ...set, setup: "in_progress", companion: "drawn", missingApps: [gmail], hasChats: false, onHome: false, several: false });
    expect(early.map((s) => `${s.text}:${s.status}`)).toEqual(["Set up:doing", "Knows you:doing", "Has the apps it needs:todo", "Has chatted with you:todo"]);
  });

  it("treats a skipped setup and no companion as settled", () => {
    expect(readiness({ ...set, setup: "skipped", companion: null }).slice(0, 2).map((s) => s.status)).toEqual(["done", "done"]);
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
    expect(knowledgeLine(knowledge([]))).toMatch(/haven't written anything down yet/);
    expect(knowledgeLine(knowledge([memory("customers")]))).toBe("I know one thing about your work.");
    expect(knowledgeLine(knowledge([memory("customers"), memory("products", true)]))).toBe("I know 2 things about your work, one of them pinned.");
  });
});

describe("approvalsLine", () => {
  it("promises to ask with no standing OKs, and names the sites it may pay on", () => {
    expect(approvalsLine([])).toMatch(/never pay .* without asking/);
    expect(approvalsLine(["gmail_labels", "tool:GMAIL_SEND_EMAIL"])).toMatch(/never pay/);
    expect(approvalsLine(["site:amazon.com"])).toMatch(/^I can pay and order on amazon.com without asking/);
    expect(approvalsLine(["site:amazon.com", "site:uline.com"])).toMatch(/amazon.com and uline.com/);
  });
});

describe("skillOrigin", () => {
  it("tells the library's, the shown, and the worked-out apart", () => {
    expect(skillOrigin({ catalogId: "weekly-review", description: "Weekly review." })).toBe("from the library");
    expect(skillOrigin({ catalogId: null, description: "Reorder supplies the way you showed me." })).toBe("you showed me");
    expect(skillOrigin({ catalogId: null, description: "Follow up with a lead." })).toBe("we worked it out");
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
    expect(routineChain({ ...task, schedule: null }, { ...opts, watch: { toolkit: "gmail", status: "broken" } }).hear).toBe("I've lost sight of it");
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

describe("firstLine and asks", () => {
  it("takes the first real line, without markdown", () => {
    expect(firstLine("\n## How I work\n- step")).toBe("How I work");
    expect(firstLine("")).toBe("");
  });

  it("asks are sentences the member finishes", () => {
    for (const ask of [ASKS.profile, ASKS.instructions, ASKS.remember, ASKS.skill, ASKS.routine, ASKS.app, ASKS.routineChange("Weekly")]) expect(ask).toMatch(/\S $/);
  });
});
