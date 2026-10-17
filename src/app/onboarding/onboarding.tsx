"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { ConnectionsList } from "@/components/settings/connections-list";
import { appName } from "@/lib/apps";
import { DEFAULT_TEMPLATE_ID, TEMPLATES, templateById } from "@/lib/templates";

type Step = "workspace" | "connect";

const STEPS: { id: Step | "chat"; label: string }[] = [
  { id: "workspace", label: "Your agent" },
  { id: "connect", label: "Connect apps" },
  { id: "chat", label: "Start chatting" },
];

export function Onboarding({ initialStep, workspaceName, canCancel }: { initialStep: Step; workspaceName: string | null; canCancel: boolean }) {
  const [step, setStep] = useState<Step>(initialStep);
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE_ID);
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [created, setCreated] = useState(workspaceName);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
      setError(body?.error ?? "Couldn't create the workspace. Try again.");
      return;
    }
    setCreated(name.trim());
    setStep("connect");
  }

  const current = STEPS.findIndex((s) => s.id === step);
  const template = templateById(templateId) ?? TEMPLATES[0];
  const suggested = created && step === "connect" ? template.apps : [];

  return (
    <div className="mt-10">
      <ol className="flex items-center gap-2 text-[12.5px]" aria-label="Setup progress">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2" aria-current={i === current ? "step" : undefined}>
            <span
              className={`flex size-5 items-center justify-center rounded-full text-[11px] font-medium tabular-nums ${
                i <= current ? "bg-inverse text-on-inverse" : "border border-line-strong text-fg-3"
              }`}
            >
              {i + 1}
            </span>
            <span className={i === current ? "font-medium text-fg" : "text-fg-3"}>{s.label}</span>
            {i < STEPS.length - 1 ? <span className="mx-1 h-px w-5 bg-line-strong" aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>

      {step === "workspace" ? (
        <form onSubmit={createWorkspace} className="mt-8 animate-fade-up" noValidate>
          <h1 className="font-display text-[28px] leading-tight tracking-[-0.01em]">Set up your agent</h1>
          <p className="mt-1.5 text-[14px] text-fg-3">Pick a starting point. You can change everything later in Settings.</p>

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
            Workspace name
          </label>
          <input
            id="ws-name"
            autoFocus
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={template.id === "job-search" ? "My job search" : template.id === "small-business" ? "Acme Studio" : "My agent"}
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
          <p className="mt-1.5 text-[12.5px] text-fg-3">The agent reads this before every conversation. You can edit it anytime in Settings.</p>

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
            asks before sending, changing, or deleting anything, and only you can use your connections.
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
