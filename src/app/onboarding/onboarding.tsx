"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { ConnectionsList } from "@/components/settings/connections-list";
import { appName } from "@/lib/apps";
import { api } from "@/lib/client/api";
import type { AccountProfile } from "@/lib/tenant-core";
import { DEFAULT_TEMPLATE_ID, TEMPLATES, templateById } from "@/lib/templates";

type Step = "you" | "workspace" | "connect";

const STEPS: { id: Step | "chat"; label: string }[] = [
  { id: "you", label: "You" },
  { id: "workspace", label: "Your agent" },
  { id: "connect", label: "Connect apps" },
  { id: "chat", label: "Start chatting" },
];

interface Props {
  initialStep: Step;
  /** The person's profile, when setup starts by asking about them (first-time setup only). */
  account: AccountProfile | null;
  workspaceName: string | null;
  canCancel: boolean;
}

export function Onboarding({ initialStep, account, workspaceName, canCancel }: Props) {
  const [step, setStep] = useState<Step>(initialStep);
  const steps = account ? STEPS : STEPS.filter((s) => s.id !== "you");
  const [you, setYou] = useState<AccountProfile>(account ?? { name: "", about: "" });
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE_ID);
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [created, setCreated] = useState(workspaceName);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function saveYou(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
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

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, profile: about, templateId, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setPending(false);
    if (!res.ok) {
      setError(body?.error ?? "Couldn't create the agent. Try again.");
      return;
    }
    setCreated(name.trim());
    setStep("connect");
  }

  const current = steps.findIndex((s) => s.id === step);
  const template = templateById(templateId) ?? TEMPLATES[0];
  const suggested = created && step === "connect" ? template.apps : [];

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
              disabled={!you.name.trim() || pending}
              className="flex h-10 items-center gap-2 rounded-xl bg-inverse px-4 text-[14px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              {pending ? "Saving…" : "Continue"}
              <ArrowRight size={15} />
            </button>
          </div>
        </form>
      ) : step === "workspace" ? (
        <form onSubmit={createWorkspace} className="mt-8 animate-fade-up" noValidate>
          <h1 className="font-display text-[28px] leading-tight tracking-[-0.01em]">{canCancel ? "New agent" : "Set up your agent"}</h1>
          <p className="mt-1.5 text-[14px] text-fg-3">
            Each agent has its own focus, instructions, and chats: one for your business, one for a job search, one for the rest of your
            life. They all know you, and share your connected apps and what they remember about you. Pick a starting point; you can
            change everything later in agent setup.
          </p>

          <fieldset className="mt-7">
            <legend className="text-[13px] font-medium text-fg-2">Start from</legend>
            <div className="mt-1.5 grid gap-2">
              {TEMPLATES.map((t) => (
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

          <label htmlFor="ws-name" className="mt-6 block text-[13px] font-medium text-fg-2">
            Agent name
          </label>
          <input
            id="ws-name"
            autoFocus
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={template.id === "job-search" ? "Job search" : template.id === "small-business" ? "My business" : "Personal"}
            className="mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-[15px] outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none"
          />

          <label htmlFor="ws-about" className="mt-5 block text-[13px] font-medium text-fg-2">
            What is this agent for? <span className="font-normal text-fg-3">Optional</span>
          </label>
          <textarea
            id="ws-about"
            rows={4}
            maxLength={8000}
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            placeholder={template.profilePrompt}
            className="mt-1.5 w-full resize-none rounded-xl border border-line bg-surface px-3.5 py-3 text-[14.5px] leading-relaxed outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none"
          />
          <p className="mt-1.5 text-[12.5px] text-fg-3">The agent reads this before every conversation. You can edit it anytime in agent setup.</p>

          <p role="alert" className="mt-4 min-h-5 text-[13px] text-danger">
            {error}
          </p>

          <div className="mt-2 flex items-center gap-3">
            <button
              type="submit"
              disabled={!name.trim() || pending}
              className="flex h-10 items-center gap-2 rounded-xl bg-inverse px-4 text-[14px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              {pending ? "Creating…" : "Continue"}
              <ArrowRight size={15} />
            </button>
            {canCancel ? (
              <a href="/" className="text-[13.5px] text-fg-3 hover:text-fg">
                Cancel
              </a>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="mt-8 animate-fade-up">
          <h1 className="font-display text-[28px] leading-tight tracking-[-0.01em]">Connect your apps</h1>
          <p className="mt-1.5 text-[14px] text-fg-3">
            Give the agent access to the apps it should work in{created ? <> for <span className="text-fg-2">{created}</span></> : null}. It
            asks before sending, changing, or deleting anything, and only you can use your connections. All your agents share them.
          </p>
          {suggested.length > 0 ? (
            <p className="mt-3 text-[13px] text-fg-3">
              Useful for {template.name.toLowerCase()}: <span className="text-fg-2">{suggested.map(appName).join(", ")}</span>
              {template.optionalApps?.length ? <>, and optionally {template.optionalApps.map(appName).join(", ")}</> : null}.
            </p>
          ) : null}
          <div className="mt-6">
            <ConnectionsList returnTo="/onboarding" />
          </div>
          <div className="mt-8 flex items-center gap-4">
            <a
              href="/"
              className="flex h-10 items-center gap-2 rounded-xl bg-inverse px-4 text-[14px] font-medium text-on-inverse transition-opacity hover:opacity-90"
            >
              Start chatting
              <ArrowRight size={15} />
            </a>
            <span className="text-[12.5px] text-fg-3">You can skip this and connect apps anytime.</span>
          </div>
        </div>
      )}
    </div>
  );
}
