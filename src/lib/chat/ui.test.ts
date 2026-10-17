import { describe, expect, it } from "vitest";
import type { UiForm } from "@/lib/types";
import { buildUiBlock } from "./ui";
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
