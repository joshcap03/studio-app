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
        { kind: "multi_choice", id: "what_should_i_do", label: "What should I do?", required: true, options: [{ label: "Find roles" }, { label: "Prep" }], prefill: ["Prep"] },
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
            parts: [
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
  ])("reads the schedule %j", (raw, expected) => {
    expect(scheduleFrom(raw)).toEqual(expected);
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
