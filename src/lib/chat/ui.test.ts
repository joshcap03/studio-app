import { describe, expect, it } from "vitest";
import type { UiForm } from "@/lib/types";
import { buildUiBlock, scheduleFrom } from "./ui";
import { formAnswerText, missingAnswer } from "./ui-answer";

describe("buildUiBlock", () => {
  it("keeps every field kind, with ids, caps, and the agent's drafts", () => {
    const block = buildUiBlock(
      {
        form: {
          title: "  Your   search ",
          intro: "Why I ask.",
          fields: [
            { type: "checkboxes", label: "What should I do?", options: ["Find roles", "find roles", "Prep"], prefill: ["Prep", "Nope"], required: true },
            { kind: "text", label: "Roles", prefill: "PM" },
            { kind: "text", id: "roles", label: "Roles again" },
            { kind: "upload", label: "Résumé", accept: [".PDF", "exe"], max: 99 },
            {
              kind: "list",
              label: "Stories",
              item_label: "Story",
              parts: ["Situation", { id: "result", label: "Result", long: true }],
              prefill: [{ situation: "Signups stalled", result: "Up 18%" }, { other: "dropped" }],
            },
            { kind: "connect", label: "Apps", apps: ["Gmail", "not-an-app"] },
            { kind: "choice", label: "Only one option", options: ["A"] },
            { kind: "mystery", label: "Unknown" },
          ],
        },
      },
      "b1",
    );
    expect(block).toEqual({
      kind: "form",
      id: "b1",
      title: "Your search",
      intro: "Why I ask.",
      submitLabel: "Send",
      fields: [
        { kind: "multi_choice", id: "what_should_i_do", label: "What should I do?", required: true, options: [{ label: "Find roles" }, { label: "Prep" }], prefill: ["Prep"], allowOther: true },
        { kind: "text", id: "roles", label: "Roles", required: false, prefill: "PM" },
        { kind: "text", id: "roles_2", label: "Roles again", required: false },
        { kind: "file", id: "resume", label: "Résumé", required: false, accept: ["pdf"], max: 5, keep: false },
        {
          kind: "list",
          id: "stories",
          label: "Stories",
          required: false,
          itemLabel: "Story",
          max: 8,
          parts: [
            { id: "situation", label: "Situation", long: false },
            { id: "result", label: "Result", long: true },
          ],
          prefill: [{ situation: "Signups stalled", result: "Up 18%" }],
        },
        { kind: "connect", id: "apps", label: "Apps", required: false, apps: ["gmail"] },
      ],
    });
  });

  it("refuses a form with no title or no usable field", () => {
    expect(buildUiBlock({ form: { title: "", fields: [{ kind: "text", label: "x" }] } })).toBeNull();
    expect(buildUiBlock({ form: { title: "x", fields: [{ kind: "mystery", label: "x" }] } })).toBeNull();
    expect(buildUiBlock({ nothing: true })).toBeNull();
    expect(buildUiBlock("form")).toBeNull();
  });

  it("keeps only real library skills, valid schedules, and something to apply", () => {
    const block = buildUiBlock(
      {
        proposal: {
          summary: "What I'll do.",
          instructions: "Be brief.",
          skills: ["find-roles", { catalog_id: "find-roles" }, "made-up", { name: "Thank-you notes", instructions: "Draft them." }, { name: "No body" }],
          tasks: [
            { template_task_id: "find-new-roles", title: "Find roles", instructions: "Look.", skill: "find-roles", schedule: { every: "weekdays", at: "08:00" } },
            { title: "Bad time", instructions: "x", schedule: { every: "day", at: "25:00" }, skill: "made-up" },
            { instructions: "no title" },
          ],
          memories: ["Prefers remote.", "Prefers remote.", ""],
        },
      },
      "p1",
    );
    expect(block).toEqual({
      kind: "proposal",
      id: "p1",
      summary: "What I'll do.",
      instructions: "Be brief.",
      skills: [{ catalogId: "find-roles" }, { name: "Thank-you notes", description: "", instructions: "Draft them." }],
      tasks: [
        { templateTaskId: "find-new-roles", title: "Find roles", instructions: "Look.", skill: "find-roles", schedule: { every: "weekdays", at: "08:00" } },
        { title: "Bad time", instructions: "x", schedule: null },
      ],
      memories: ["Prefers remote."],
    });
    expect(buildUiBlock({ proposal: { summary: "Nothing to change." } })).toBeNull();
  });

  it("takes a name the agent suggests for itself, alone or with a setup, and drops one that isn't a name", () => {
    expect(buildUiBlock({ proposal: { summary: "Hi.", identity: { name: ' "Juniper" ', manner: "I keep it short.  I lead with what I found." } } }, "p2")).toEqual({
      kind: "proposal",
      id: "p2",
      summary: "Hi.",
      skills: [],
      tasks: [],
      memories: [],
      identity: { name: "Juniper", manner: "I keep it short. I lead with what I found." },
    });
    expect(buildUiBlock({ proposal: { summary: "Hi.", identity: { name: "Call me at https://x.test", manner: "" } } })).toBeNull();
    expect(buildUiBlock({ proposal: { summary: "Hi.", identity: { name: "🙂" } } })).toBeNull();
    expect(buildUiBlock({ proposal: { summary: "s", instructions: "Be brief.", identity: { name: "Mae-Lin O'Hara" } } })).toMatchObject({
      instructions: "Be brief.",
      identity: { name: "Mae-Lin O'Hara", manner: "" },
    });
  });
});

describe("form answers", () => {
  const form = buildUiBlock(
    {
      form: {
        title: "Setup",
        fields: [
          { kind: "multi_choice", id: "jobs", label: "Jobs", options: ["Find", "Prep"], required: true },
          { kind: "long_text", id: "notes", label: "Notes" },
          { kind: "file", id: "resume", label: "Résumé", keep: true },
          { kind: "file", id: "extra", label: "Other files" },
          { kind: "list", id: "stories", label: "Stories", item_label: "Story", parts: [{ id: "s", label: "Situation" }, { id: "r", label: "Result" }] },
        ],
      },
    },
    "f",
  ) as UiForm;

  it("names the first missing required answer", () => {
    expect(missingAnswer(form, {})).toBe("Jobs");
    expect(missingAnswer(form, { jobs: [] })).toBe("Jobs");
    expect(missingAnswer(form, { jobs: ["Find"] })).toBeNull();
  });

  it("reads like the member wrote it, skipping blanks", () => {
    const text = formAnswerText(form, {
      jobs: ["Find", "Prep"],
      notes: "  Line one\nLine two ",
      resume: ["cv.pdf"],
      extra: ["notes.txt"],
      stories: [{ s: "Stalled", r: "Up 18%" }, { s: " ", r: "" }],
    });
    expect(text).toBe("Jobs: Find, Prep\nNotes:\nLine one\nLine two\nRésumé: added cv.pdf to this agent's files\nOther files: attached notes.txt\nStories:\nStory 1\n- Situation: Stalled\n- Result: Up 18%");
    expect(formAnswerText(form, {})).toBe("Setup: nothing to add.");
  });

  describe("apps to connect", () => {
    const apps = buildUiBlock(
      {
        form: {
          title: "Your tools",
          fields: [
            { kind: "connect", id: "qb", label: "Connect QuickBooks", app: "quickbooks" },
            { kind: "connect", id: "mail", label: "Email and calendar", apps: ["gmail", "calendar"] },
          ],
        },
      },
      "f",
    ) as UiForm;

    it("says plainly which were connected and which were skipped", () => {
      const text = formAnswerText(apps, {
        qb: [{ app: "quickbooks", status: "not_connected" }],
        mail: [
          { app: "gmail", status: "connected" },
          { app: "calendar", status: "not_connected" },
        ],
      });
      expect(text).toBe("Connect QuickBooks: skipped for now, not connected\nEmail and calendar: Gmail connected; Google Calendar skipped for now, not connected");
    });

    it("never sends a card with only apps as nothing to add", () => {
      expect(formAnswerText(apps, { qb: [{ app: "quickbooks", status: "connected" }] })).toBe("Connect QuickBooks: connected\nEmail and calendar: Gmail skipped for now; Google Calendar skipped for now");
      expect(formAnswerText(apps, { qb: [{ app: "quickbooks", status: "unavailable" }] })).toMatch(/^Connect QuickBooks: not available yet, not connected\n/);
      expect(missingAnswer(apps, {})).toBeNull();
    });
  });
});

describe("drafted results", () => {
  it("keeps a drafted result's text whole, under the names models use for it", () => {
    const draft = "A client's Saturday food cost hit 38%.\nTuesday was 29%.\n\nCheck your best night first.";
    const block = buildUiBlock({ form: { title: "Trial run", fields: [{ type: "verdict", label: "Drafts", items: [{ title: "Draft 1", text: draft }, { title: "Draft 2", content: "x".repeat(1200) }] }] } }, "v") as UiForm;
    const items = block.fields[0].kind === "verdict" ? block.fields[0].items : [];
    expect(items.map((i) => i.body)).toEqual([draft, "x".repeat(1200)]);
  });
});

describe("loose agent output", () => {
  it("reads prefills, ids, and list drafts under the names models often use", () => {
    // As a real model sent them during setup: type/name/value, parts with key and type "long", drafts as items.
    const block = buildUiBlock({
      form: {
        title: "Your search",
        fields: [
          { name: "target_roles", label: "Target roles", type: "text", value: "Senior Product Designer" },
          { name: "remote", label: "Remote", type: "choice", options: ["Remote only", "Hybrid is fine"], value: "Remote only" },
          {
            key: "stories",
            type: "list",
            label: "Stories",
            item_label: "Story",
            item_fields: [
              { key: "title", label: "Title", type: "short" },
              { key: "situation", label: "Situation", type: "long" },
            ],
            items: [{ title: "Dashboard redesign", situation: "Slow first chart." }],
          },
        ],
      },
    });
    expect(block?.kind).toBe("form");
    const [roles, remote, stories] = (block as UiForm).fields;
    expect(roles).toMatchObject({ id: "target_roles", prefill: "Senior Product Designer" });
    expect(remote).toMatchObject({ id: "remote", prefill: ["Remote only"] });
    expect(stories).toMatchObject({
      id: "stories",
      parts: [
        { id: "title", long: false },
        { id: "situation", long: true },
      ],
      prefill: [{ title: "Dashboard redesign", situation: "Slow first chart." }],
    });
  });

  it.each([
    ["Weekdays at 8:00 AM", { every: "weekdays", at: "08:00" }],
    ["every weekday morning at 8", { every: "weekdays", at: "08:00" }],
    ["Daily at 7pm", { every: "day", at: "19:00" }],
    ["Every Monday at 9", { every: "week", at: "09:00", weekday: 1 }],
    ["weekly on Friday at 4:30 pm", { every: "week", at: "16:30", weekday: 5 }],
    ["Every 4 hours", { every: "hours", hours: 4 }],
    [{ every: "weekday", at: "8am" }, { every: "weekdays", at: "08:00" }],
    [{ every: "weekly", weekday: "Monday", at: "09:00", extra: true }, { every: "week", at: "09:00", weekday: 1 }],
    [{ every: "weekly", day: "monday", at: "09:00" }, { every: "week", at: "09:00", weekday: 1 }],
    [{ every: "monday", at: "09:00" }, { every: "week", at: "09:00", weekday: 1 }],
    [{ every: "Fridays", at: "17:00" }, { every: "week", at: "17:00", weekday: 5 }],
    ["Weekdays, morning", { every: "weekdays", at: "08:00" }],
    [{ on_demand: true }, null],
    [{ every: "on demand" }, null],
    ["On demand", null],
    ["Every Monday in the evening", { every: "week", at: "18:00", weekday: 1 }],
  ])("reads the schedule %j", (raw, expected) => {
    expect(scheduleFrom(raw)).toEqual(expected);
  });

  it("takes connect fields with one app each", () => {
    const block = buildUiBlock({
      form: {
        title: "Connect your apps",
        fields: [
          { name: "gmail", label: "Gmail", type: "connect", app: "gmail" },
          { name: "clay", label: "Clay", type: "connect", apps: "clay" },
          { name: "calendar", label: "Calendar", type: "connect", app: "googlecalendar" },
          { key: "hunter", label: "Hunter", type: "connect" },
          { key: "nope", label: "Nope", type: "connect" },
        ],
      },
    });
    expect((block as UiForm).fields).toMatchObject([
      { kind: "connect", apps: ["gmail"] },
      { kind: "connect", apps: ["clay"] },
      { kind: "connect", apps: ["calendar"] },
      { kind: "connect", apps: ["hunter"] },
    ]);
  });

  it("switches on a template task named only by its id, under that task's title", () => {
    const proposal = buildUiBlock({ proposal: { summary: "s", tasks: [{ template_task_id: "find-new-roles", schedule: "Weekdays at 8:00 AM" }, { template_task_id: "made-up" }] } });
    expect(proposal).toMatchObject({ tasks: [{ templateTaskId: "find-new-roles", title: "Find new roles", schedule: { every: "weekdays", at: "08:00" } }] });
    expect((proposal as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it("leaves schedules it can't read as they were, for the validator to drop", () => {
    expect(scheduleFrom("when it feels right")).toBe("when it feels right");
    expect(scheduleFrom(null)).toBeNull();
    const proposal = buildUiBlock({ proposal: { summary: "s", tasks: [{ title: "T", instructions: "i", schedule: "sometimes" }] } });
    expect(proposal).toMatchObject({ tasks: [{ schedule: null }] });
  });
});

describe("react-first fields", () => {
  const form = buildUiBlock(
    {
      form: {
        title: "Your bar",
        fields: [
          { kind: "choice", label: "The job", options: ["Find roles", "Prep"], allow_other: true, required: true },
          { type: "ranking", label: "What matters most", options: ["Pay", "Remote", "Seniority"], prefill: ["Remote", "Pay", "Seniority"] },
          { kind: "rank", label: "Partial order", options: ["A", "B", "C"], prefill: ["B"] },
          { kind: "slider", label: "How hands-on", low: "Ask me first", high: "Just do it", steps: 12, value: "4" },
          { kind: "scale", label: "No ends", steps: 5 },
          { type: "scale", label: "How strict should I be? 1 = show me borderline roles too, 5 = only near-perfect matches" },
          { type: "scale", label: "How many roles a batch?", min: 1, max: 10, help: "1 = one strong role, 10 = a full list" },
          {
            kind: "verdict",
            label: "Would you go for these?",
            required: true,
            reasons: ["Too junior", "too junior", "Not remote"],
            items: [
              { title: "Senior Designer · Acme", body: "Remote, $190k", url: "https://example.com/1", record: { collection: "applications", key: "https://example.com/1" } },
              { title: "Senior Designer · Acme", link: "javascript:alert(1)" },
              "Designer II · Beta",
              { body: "no title" },
            ],
          },
          { kind: "verdict", label: "Nothing to judge", items: [] },
        ],
      },
    },
    "v",
  ) as UiForm;

  it("keeps rank, scale, verdict, and allow_other, dropping what can't be used", () => {
    expect(form.fields.map((f) => f.kind)).toEqual(["choice", "rank", "rank", "scale", "scale", "scale", "scale", "verdict"]);
    expect(form.fields[0]).toMatchObject({ allowOther: true });
    expect(form.fields[1]).toMatchObject({ prefill: ["Remote", "Pay", "Seniority"], required: false });
    expect(form.fields[2]).not.toHaveProperty("prefill");
    expect(form.fields[3]).toEqual({ kind: "scale", id: "how_hands_on", label: "How hands-on", required: false, steps: 10, low: "Ask me first", high: "Just do it", prefill: 4 });
    // A scale whose ends the model didn't name still asks, with plain ends; ends written into
    // the question or its help become the scale's ends.
    expect(form.fields[4]).toMatchObject({ kind: "scale", label: "No ends", steps: 5, low: "Less", high: "More" });
    expect(form.fields[5]).toMatchObject({ label: "How strict should I be?", steps: 5, low: "show me borderline roles too", high: "only near-perfect matches" });
    expect(form.fields[6]).toMatchObject({ label: "How many roles a batch?", steps: 10, low: "one strong role", high: "a full list" });
    expect(form.fields[6]).not.toHaveProperty("help");
    expect(form.fields[7]).toEqual({
      kind: "verdict",
      id: "would_you_go_for_these",
      label: "Would you go for these?",
      required: true,
      reasons: ["Too junior", "Not remote"],
      items: [
        { id: "senior_designer_acme", title: "Senior Designer · Acme", body: "Remote, $190k", link: "https://example.com/1", record: { collection: "applications", key: "https://example.com/1" } },
        { id: "senior_designer_acme_2", title: "Senior Designer · Acme" },
        { id: "designer_ii_beta", title: "Designer II · Beta" },
      ],
    });
  });

  it("wants a call on every item of a required verdict", () => {
    const base = { the_job: ["Find roles"] };
    expect(missingAnswer(form, base)).toBe("Would you go for these?");
    const some = [{ id: "senior_designer_acme", verdict: "keep" }];
    expect(missingAnswer(form, { ...base, would_you_go_for_these: some })).toBe("Would you go for these?");
    const all = [...some, { id: "senior_designer_acme_2", verdict: "pass" }, { id: "designer_ii_beta", verdict: "pass", reason: "Too junior" }];
    expect(missingAnswer(form, { ...base, would_you_go_for_these: all })).toBeNull();
  });

  it("reads verdicts, order, and scale points as the member meant them", () => {
    const text = formAnswerText(form, {
      the_job: ["Write my cover letters"],
      what_matters_most: ["Remote", "Pay", "Seniority"],
      how_hands_on: "2",
      would_you_go_for_these: [
        { id: "designer_ii_beta", verdict: "pass", reason: " Too junior " },
        { id: "senior_designer_acme", verdict: "keep" },
        { id: "senior_designer_acme_2", verdict: "" },
      ],
    });
    expect(text).toBe(
      [
        "The job: Write my cover letters",
        "What matters most (most important first): 1. Remote; 2. Pay; 3. Seniority",
        "How hands-on: 2 of 10 (1 = Ask me first, 10 = Just do it)",
        "Would you go for these?:",
        "- Kept: Senior Designer · Acme <https://example.com/1>",
        "- Passed: Designer II · Beta (Too junior)",
      ].join("\n"),
    );
  });
});

describe("scale ends in prose", () => {
  const scale = (raw: Record<string, unknown>) => (buildUiBlock({ form: { title: "T", fields: [{ kind: "scale", ...raw }] } }, "s") as UiForm).fields[0];

  it("reads 1 = …, N = … ends, and cuts them from the question where they start", () => {
    expect(scale({ label: "Step 1: How strict? 1 = loose, 5 = strict" })).toMatchObject({ label: "Step 1: How strict?", low: "loose", high: "strict", steps: 5 });
    expect(scale({ label: "How strict?", help: "How often I check in (1 = rarely, 5 = constantly)" })).toMatchObject({ help: "How often I check in", low: "rarely", high: "constantly" });
    expect(scale({ label: "How many a batch? 1 = one strong role, 10 = a full list" })).toMatchObject({ label: "How many a batch?", steps: 10 });
  });

  it("leaves times, ratios, and ends the agent named alone", () => {
    expect(scale({ label: "How ready are you for 9:00, 10:30 meetings?", low: "x", high: "y" })).toMatchObject({ label: "How ready are you for 9:00, 10:30 meetings?", low: "x", high: "y" });
    expect(scale({ label: "Ratio 3:1 is fine, 5:1 is ideal" })).toMatchObject({ label: "Ratio 3:1 is fine, 5:1 is ideal", low: "Less", high: "More" });
    expect(scale({ label: "Pick", help: "Think about mornings, e.g. 7:30, 8:15", low: "a", high: "b" })).toMatchObject({ help: "Think about mornings, e.g. 7:30, 8:15" });
    expect(scale({ label: "How strict? 1 = loose, 5 = strict", low: "Loose", high: "Strict" })).toMatchObject({ label: "How strict? 1 = loose, 5 = strict" });
  });

  it("maps a min/max range and its prefill onto 1..steps", () => {
    expect(scale({ label: "L", low: "a", high: "b", min: 5, max: 10, prefill: 7 })).toMatchObject({ steps: 6, prefill: 3 });
    expect(scale({ label: "L", low: "a", high: "b", min: 0, max: 10 })).toMatchObject({ steps: 10 });
    expect(scale({ label: "L", low: "a", high: "b", min: 50, max: 100 })).toMatchObject({ steps: 10 });
  });
});

describe("choices", () => {
  it("take the member's own words too, unless the agent closes the question", () => {
    const form = buildUiBlock(
      {
        form: {
          title: "T",
          fields: [
            { kind: "choice", label: "Open", options: ["A", "B"] },
            { kind: "choice", label: "Closed", options: ["Yes", "No"], allow_other: false },
          ],
        },
      },
      "c",
    ) as UiForm;
    expect(form.fields.map((f) => "allowOther" in f && f.allowOther)).toEqual([true, false]);
  });
});

describe("loose verdicts and notes", () => {
  it("reads a verdict field with no options whose label is the result and its link (recorded shape)", () => {
    const form = buildUiBlock(
      {
        form: {
          title: "Trial run",
          fields: [
            {
              key: "verdict",
              type: "verdict",
              label: "Sr. Product Designer (Remote), Rula: remote US, $180K–$221K base range, direct posting. Link: https://jobs.example.test/rula/30f6",
              reasons_to_pass: ["Posted outside your last-3-days rule", "Healthcare-focused product"],
            },
          ],
        },
      },
      "t",
    ) as UiForm;
    expect(form.fields).toEqual([
      expect.objectContaining({
        kind: "verdict",
        label: "Keep or pass on each",
        reasons: ["Posted outside your last-3-days rule", "Healthcare-focused product"],
        items: [
          {
            id: "sr_product_designer_remote_rula",
            title: "Sr. Product Designer (Remote), Rula",
            body: "remote US, $180K–$221K base range, direct posting",
            link: "https://jobs.example.test/rula/30f6",
          },
        ],
      }),
    ]);
  });

  it("cleans a result's link and leftovers out of its title and detail", () => {
    const item = (label: string, extra: Record<string, unknown> = {}) =>
      (buildUiBlock({ form: { title: "Trial run", fields: [{ type: "verdict", label, ...extra }] } }, "t") as UiForm).fields[0];
    expect(item("Senior PM, Acme: remote. See https://jobs.example.test/1.")).toMatchObject({ items: [{ title: "Senior PM, Acme", body: "remote. See", link: "https://jobs.example.test/1" }] });
    expect(item("[Senior PM, Acme](https://jobs.example.test/1): remote, $200k")).toMatchObject({ items: [{ title: "Senior PM, Acme", body: "remote, $200k", link: "https://jobs.example.test/1" }] });
    expect(item("Senior PM, Acme (https://jobs.example.test/1): remote")).toMatchObject({ items: [{ title: "Senior PM, Acme", body: "remote", link: "https://jobs.example.test/1" }] });
    expect(item("Senior PM, Acme: remote. Posting: http://jobs.example.test/1")).toMatchObject({ items: [{ title: "Senior PM, Acme", body: "remote", link: "http://jobs.example.test/1" }] });
  });

  it("takes a one-result field's own detail as the result's, not the whole card's help", () => {
    const form = buildUiBlock(
      {
        form: {
          title: "Trial run",
          fields: [
            { type: "verdict", label: "Senior PM, Acme", link: "https://jobs.example.test/1", description: "Remote US, $200k base" },
            { type: "verdict", label: "Staff PM, Beta", url: "https://jobs.example.test/2", why: "Hybrid NYC" },
          ],
        },
      },
      "t",
    ) as UiForm;
    expect(form.fields).toHaveLength(1);
    expect(form.fields[0]).not.toHaveProperty("help");
    expect(form.fields[0]).toMatchObject({
      items: [
        { title: "Senior PM, Acme", body: "Remote US, $200k base", link: "https://jobs.example.test/1" },
        { title: "Staff PM, Beta", body: "Hybrid NYC", link: "https://jobs.example.test/2" },
      ],
    });
  });

  it("takes a result's reason as its line on why it fits", () => {
    const form = buildUiBlock(
      { form: { title: "Keep or pass", fields: [{ type: "verdict", label: "Roles", items: [{ title: "Senior PM, Acme", reason: "Remote US, $200k" }] }] } },
      "t",
    ) as UiForm;
    expect(form.fields[0]).toMatchObject({ items: [{ title: "Senior PM, Acme", body: "Remote US, $200k" }] });
  });

  it("doesn't turn a verdict prompt with no results into a result", () => {
    expect(buildUiBlock({ form: { title: "Trial run", fields: [{ type: "verdict", label: "Would you want these?" }] } }, "t")).toBeNull();
  });

  it("gathers one-result verdict fields with Keep/Pass options into one field, and keeps notes in the intro", () => {
    const form = buildUiBlock(
      {
        form: {
          title: "Examples to judge",
          intro: "Judge each one.",
          fields: [
            { type: "note", name: "n", label: "Heads up", value: "These are made up." },
            { type: "verdict", name: "ex1", label: "Senior PM · Acme, remote, $190k", options: ["Keep", "Pass"], required: true, reasons: ["Too junior"] },
            { kind: "text", label: "Anything else?" },
            { type: "verdict", name: "ex2", label: "Product Lead · Beta, hybrid", options: ["Keep", "Pass"], reasons: ["Not remote"] },
            { type: "verdict_reasons", name: "why", label: "Likely reasons to pass", items: ["Agency role", "not remote"] },
          ],
        },
      },
      "g",
    ) as UiForm;
    expect(form.intro).toBe("Judge each one.\n\nThese are made up.");
    expect(form.fields.map((f) => f.kind)).toEqual(["verdict", "text"]);
    expect(form.fields[0]).toMatchObject({
      label: "Keep or pass on each",
      required: true,
      reasons: ["Too junior", "Agency role", "not remote"],
      items: [
        { id: "senior_pm_acme_remote_190k", title: "Senior PM · Acme, remote, $190k" },
        { id: "product_lead_beta_hybrid", title: "Product Lead · Beta, hybrid" },
      ],
    });
  });
});
