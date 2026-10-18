import { describe, expect, it } from "vitest";
import type { UiForm } from "@/lib/types";
import { fillField, fillQuestions, heardIn, spokenNumber } from "./ui-fill";

const form: UiForm = {
  kind: "form",
  id: "f1",
  title: "Your search",
  submitLabel: "Next",
  fields: [
    { kind: "choice", id: "job", label: "The one thing you most want from me", required: true, options: [{ label: "Find roles that fit" }, { label: "Tailor applications" }], allowOther: true },
    { kind: "multi_choice", id: "where", label: "Where", required: false, options: [{ label: "Remote" }, { label: "Hybrid" }, { label: "On-site" }] },
    { kind: "scale", id: "hands", label: "How hands-on", required: false, steps: 5, low: "Ask me first", high: "Just do it" },
    { kind: "rank", id: "matters", label: "What matters most", required: false, options: [{ label: "Pay" }, { label: "Remote" }, { label: "Seniority" }, { label: "Industry" }] },
    { kind: "text", id: "roles", label: "Target roles", required: false },
    {
      kind: "verdict",
      id: "trial",
      label: "Would you go for these?",
      required: true,
      reasons: ["Too junior", "Agency"],
      items: [
        { id: "a", title: "Senior Designer · Example Co" },
        { id: "b", title: "Designer II · Sample Labs" },
        { id: "c", title: "Staff Designer · Placeholder Inc" },
      ],
    },
    { kind: "file", id: "resume", label: "Your résumé", required: false, accept: ["pdf"], max: 1, keep: true },
    { kind: "list", id: "stories", label: "Stories", required: false, itemLabel: "Story", max: 3, parts: [{ id: "result", label: "Result", long: false }] },
  ],
};

describe("fillField", () => {
  it("picks an option by its exact label, and only loosely matched ones need confirming", () => {
    const exact = fillField(form, {}, { field: "job", value: "find roles that fit" }, "");
    expect(exact).toMatchObject({ ok: true, fieldId: "job", value: ["Find roles that fit"], heard: false });
    const loose = fillField(form, {}, { field: "job", value: "roles" }, "");
    expect(loose).toMatchObject({ ok: true, value: ["Find roles that fit"], heard: true });
  });

  it("takes their own words for 'something else' only as heard unless they said them", () => {
    const said = "honestly I want help with networking events";
    expect(fillField(form, {}, { field: "job", value: "networking events" }, said)).toMatchObject({ ok: true, value: ["networking events"], heard: false });
    expect(fillField(form, {}, { field: "job", value: "go to networking events more" }, said)).toMatchObject({ ok: true, heard: true });
  });

  it("refuses options a field doesn't have and more than one answer for a single choice", () => {
    expect(fillField(form, {}, { field: "where", value: ["Mars"] }, "")).toMatchObject({ ok: false });
    expect(fillField(form, {}, { field: "job", value: ["Find roles that fit", "Tailor applications"] }, "")).toMatchObject({ ok: false });
    expect(fillField(form, {}, { field: "where", value: ["remote", "Hybrid"] }, "")).toMatchObject({ ok: true, value: ["Remote", "Hybrid"], heard: false });
  });

  it("finds a field by its label when the id isn't given", () => {
    expect(fillField(form, {}, { field: "Where", value: "Remote" }, "")).toMatchObject({ ok: true, fieldId: "where" });
    expect(fillField(form, {}, { field: "budget", value: "x" }, "")).toMatchObject({ ok: false });
  });

  it("checks a scale's range and reads spoken numbers", () => {
    expect(fillField(form, {}, { field: "hands", value: "four" }, "")).toMatchObject({ ok: true, value: "4" });
    expect(fillField(form, {}, { field: "hands", value: 9 }, "")).toMatchObject({ ok: false });
    expect(fillField(form, {}, { field: "hands", value: 2.5 }, "")).toMatchObject({ ok: false });
  });

  it("puts what they named first in a ranking and keeps the rest in order", () => {
    const out = fillField(form, { matters: ["Pay", "Remote", "Seniority", "Industry"] }, { field: "matters", value: ["Seniority", "remote"] }, "");
    expect(out).toMatchObject({ ok: true, value: ["Seniority", "Remote", "Pay", "Industry"] });
  });

  it("merges keep and pass calls by number, id, or title", () => {
    const first = fillField(form, {}, { field: "trial", value: [{ item: 1, verdict: "keep" }, { item: "two", verdict: "keep" }] }, "");
    expect(first).toMatchObject({ ok: true, heard: false });
    const values = { trial: first.ok ? first.value : [] };
    const second = fillField(form, values, { field: "trial", value: { item: "c", verdict: "pass", reason: "agency" } }, "");
    expect(second).toMatchObject({ ok: true, heard: false });
    expect(second.ok && second.value).toEqual([
      { id: "a", verdict: "keep" },
      { id: "b", verdict: "keep" },
      { id: "c", verdict: "pass", reason: "Agency" },
    ]);
    expect(fillField(form, {}, { field: "trial", value: { item: 7, verdict: "keep" } }, "")).toMatchObject({ ok: false });
    expect(fillField(form, {}, { field: "trial", value: { item: 1, verdict: "maybe" } }, "")).toMatchObject({ ok: false });
  });

  it("keeps a pass reason in their words only when they said it", () => {
    const said = "pass on three it's on-site only";
    expect(fillField(form, {}, { field: "trial", value: { item: 3, verdict: "pass", reason: "on-site only" } }, said)).toMatchObject({ ok: true, heard: false });
    expect(fillField(form, {}, { field: "trial", value: { item: 3, verdict: "pass", reason: "requires relocation" } }, said)).toMatchObject({ ok: true, heard: true });
  });

  it("takes text only as heard when it isn't what they said", () => {
    const said = "Um, target roles are product designer, senior.";
    expect(fillField(form, {}, { field: "roles", value: "Product designer, senior" }, said)).toMatchObject({ ok: true, value: "Product designer, senior", heard: false });
    expect(fillField(form, {}, { field: "roles", value: "Senior product design lead" }, said)).toMatchObject({ ok: true, heard: true });
  });

  it("marks a fill the voice was unsure of as heard", () => {
    expect(fillField(form, {}, { field: "hands", value: 3, sure: false }, "")).toMatchObject({ ok: true, heard: true });
  });

  it("leaves files and apps to taps", () => {
    expect(fillField(form, {}, { field: "resume", value: "resume.pdf" }, "")).toMatchObject({ ok: false });
  });

  it("fills one part of a list entry from their words", () => {
    const out = fillField(form, {}, { field: "stories", value: { entry: 1, part: "result", text: "Activation up 18%" } }, "the result was activation up 18%");
    expect(out).toMatchObject({ ok: true, value: [{ result: "Activation up 18%" }], heard: false });
    expect(fillField(form, {}, { field: "stories", value: { entry: 3, part: "result", text: "x" } }, "")).toMatchObject({ ok: false });
  });
});

describe("fillQuestions", () => {
  const questions = [
    { question: "Who should get it?", options: [{ label: "Everyone" }, { label: "Repeat buyers" }], multiSelect: false },
    { question: "What should it cover?", options: [{ label: "New arrivals" }, { label: "Restocks" }], multiSelect: true },
  ];
  it("picks options per question", () => {
    const out = fillQuestions(questions, [[], []], [{ question: 1, option: "repeat buyers" }, { question: 2, option: ["Restocks", "New arrivals"] }]);
    expect(out).toMatchObject({ ok: true, picks: [["Repeat buyers"], ["Restocks", "New arrivals"]], heard: false });
  });
  it("refuses options that aren't there", () => {
    expect(fillQuestions(questions, [[], []], { question: 1, option: "Nobody" })).toMatchObject({ ok: false });
  });
});

describe("helpers", () => {
  it("read numbers the way people say them", () => {
    expect([spokenNumber("the third"), spokenNumber("3"), spokenNumber("first one"), spokenNumber("lots")]).toEqual([3, 3, 1, null]);
  });
  it("match whole words in order", () => {
    expect(heardIn("remote only", "I want remote only, please")).toBe(true);
    expect(heardIn("mote", "remote")).toBe(false);
  });
});
