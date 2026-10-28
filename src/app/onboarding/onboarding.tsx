"use client";

import { ArrowRight, AudioLines } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/client/api";
import type { AccountProfile } from "@/lib/tenant-core";
import { DEFAULT_TEMPLATE_ID, templateById, templateChoices } from "@/lib/templates";

type Step = "you" | "workspace";

const STEPS: { id: Step | "chat"; label: string }[] = [
  { id: "you", label: "You" },
  { id: "workspace", label: "First agent" },
  { id: "chat", label: "Set it up" },
];

interface Props {
  initialStep: Step;
  /** The person's profile, when setup starts by asking about them (first-time setup only). */
  account: AccountProfile | null;
  canCancel: boolean;
  /** The member can set the agent up on a call (the voice preview). */
  canTalk: boolean;
}

export function Onboarding({ initialStep, account, canCancel, canTalk }: Props) {
  const [step, setStep] = useState<Step>(initialStep);
  // First-time setup makes the first of their agents; later visits add another.
  const steps = (account ? STEPS : STEPS.filter((s) => s.id !== "you")).map((s) =>
    s.id === "workspace" ? { ...s, label: canCancel ? "New agent" : "First agent" } : s,
  );
  const [you, setYou] = useState<AccountProfile>(account ?? { name: "", about: "" });
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE_ID);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<false | "continue" | "talk">(false);

  async function saveYou(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending("continue");
    setError(null);
    try {
      await api.updateAccount(you);
      setStep("workspace");
    } catch (e) {
      setError((e as Error).message || "Couldn't save. Try again.");
    } finally {
      setPending(false);
    }
  }

  /**
   * Creates the agent, named for its template until renamed, and opens its setup interview, typed
   * or on a call. The interview learns what it's for and offers apps once the plan is agreed.
   */
  async function createWorkspace(event: React.FormEvent, next: "continue" | "talk" = "continue") {
    event.preventDefault();
    if (pending) return;
    setPending(next);
    setError(null);
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: template.namePlaceholder, templateId, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      setPending(false);
      setError(body?.error ?? "Couldn't create the agent. Try again.");
      return;
    }
    window.location.assign(next === "talk" ? "/?setup=talk" : "/?setup=1");
  }

  const current = steps.findIndex((s) => s.id === step);
  const choices = templateChoices();
  const template = templateById(templateId) ?? templateById(DEFAULT_TEMPLATE_ID)!;

  return (
    <div className="mt-10">
      <ol className="flex items-center gap-2 text-[12.5px]" aria-label="Setup progress">
        {steps.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2" aria-current={i === current ? "step" : undefined}>
            <span
              className={`flex size-5 items-center justify-center rounded-full text-[11px] font-medium tabular-nums ${
                i <= current ? "bg-inverse text-on-inverse" : "border border-line-strong text-fg-3"
              }`}
            >
              {i + 1}
            </span>
            <span className={i === current ? "font-medium text-fg" : "text-fg-3"}>{s.label}</span>
            {i < steps.length - 1 ? <span className="mx-1 h-px w-5 bg-line-strong" aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>

      {step === "you" ? (
        <form onSubmit={saveYou} className="mt-8 animate-fade-up" noValidate>
          <h1 className="font-display text-[28px] leading-tight tracking-[-0.01em]">About you</h1>
          <p className="mt-1.5 text-[14px] text-fg-3">
            Every agent you make reads this, so you only have to say it once. You can change it anytime in Settings.
          </p>

          <label htmlFor="your-name" className="mt-7 block text-[13px] font-medium text-fg-2">
            Your name
          </label>
          <input
            id="your-name"
            autoFocus
            autoComplete="name"
            maxLength={80}
            value={you.name}
            onChange={(e) => setYou({ ...you, name: e.target.value })}
            className="mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-[15px] outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none"
          />

          <label htmlFor="about-you" className="mt-5 block text-[13px] font-medium text-fg-2">
            About you <span className="font-normal text-fg-3">Optional</span>
          </label>
          <textarea
            id="about-you"
            rows={4}
            maxLength={4000}
            value={you.about}
            onChange={(e) => setYou({ ...you, about: e.target.value })}
            placeholder="Where you are, what you do, how you like to work…"
            className="mt-1.5 w-full resize-none rounded-xl border border-line bg-surface px-3.5 py-3 text-[14.5px] leading-relaxed outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none"
          />

          <p role="alert" className="mt-4 min-h-5 text-[13px] text-danger">
            {error}
          </p>

          <div className="mt-2 flex items-center gap-3">
            <button
              type="submit"
              disabled={!you.name.trim() || Boolean(pending)}
              className="flex h-10 items-center gap-2 rounded-xl bg-inverse px-4 text-[14px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              {pending ? "Saving…" : "Continue"}
              <ArrowRight size={15} />
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={createWorkspace} className="mt-8 animate-fade-up" noValidate>
          <h1 className="font-display text-[28px] leading-tight tracking-[-0.01em]">{canCancel ? "New agent" : "Your first agent"}</h1>
          <p className="mt-1.5 text-[14px] text-fg-3">
            Pick a starting point. Next, your agent asks what you need and sets itself up with you; you can change anything later
            {canCancel ? null : <>, and add more agents anytime</>}.
          </p>

          <fieldset className="mt-7">
            <legend className="text-[13px] font-medium text-fg-2">Start from</legend>
            <div className="mt-1.5 grid gap-2">
              {choices.map((t) => (
                <label
                  key={t.id}
                  className={`flex cursor-pointer gap-3 rounded-xl border px-3.5 py-3 transition-colors ${
                    t.id === templateId ? "border-line-strong bg-subtle" : "border-line bg-surface hover:bg-subtle/60"
                  }`}
                >
                  <input
                    type="radio"
                    name="template"
                    value={t.id}
                    checked={t.id === templateId}
                    onChange={() => setTemplateId(t.id)}
                    className="mt-1 accent-current"
                  />
                  <span>
                    <span className="block text-[14px] font-medium text-fg">{t.name}</span>
                    <span className="mt-0.5 block text-[13px] leading-snug text-fg-3">{t.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <p role="alert" className="mt-4 min-h-5 text-[13px] text-danger">
            {error}
          </p>

          <div className="mt-2 flex items-center gap-3">
            <button
              type="submit"
              disabled={Boolean(pending)}
              className="flex h-10 items-center gap-2 rounded-xl bg-inverse px-4 text-[14px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              {pending === "continue" ? "Creating…" : "Continue"}
              <ArrowRight size={15} />
            </button>
            {canTalk ? (
              // Skip the form: pick a starting point and say the rest on a call.
              <button
                type="button"
                onClick={(e) => void createWorkspace(e, "talk")}
                disabled={Boolean(pending)}
                className="flex h-10 items-center gap-2 rounded-xl border border-line-strong px-4 text-[14px] font-medium text-fg transition-colors hover:bg-hover disabled:opacity-50"
              >
                {pending === "talk" ? <span className="spinner size-3.5" aria-hidden="true" /> : <AudioLines size={15} className="text-accent" />}
                Talk it through
              </button>
            ) : null}
            {account ? (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStep("you");
                }}
                disabled={Boolean(pending)}
                className="text-[13.5px] text-fg-3 hover:text-fg disabled:opacity-50"
              >
                Back
              </button>
            ) : null}
            {canCancel ? (
              <a href="/" className="text-[13.5px] text-fg-3 hover:text-fg">
                Cancel
              </a>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}
