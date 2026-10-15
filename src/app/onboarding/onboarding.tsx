"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { ConnectionsList } from "@/components/settings/connections-list";

type Step = "workspace" | "connect";

const STEPS: { id: Step | "chat"; label: string }[] = [
  { id: "workspace", label: "Workspace" },
  { id: "connect", label: "Connect apps" },
  { id: "chat", label: "Start chatting" },
];

export function Onboarding({ initialStep, workspaceName, canCancel }: { initialStep: Step; workspaceName: string | null; canCancel: boolean }) {
  const [step, setStep] = useState<Step>(initialStep);
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
      body: JSON.stringify({ name, businessContext: about }),
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
          <h1 className="font-display text-[28px] leading-tight tracking-[-0.01em]">Set up your workspace</h1>
          <p className="mt-1.5 text-[14px] text-fg-3">A few details so the agent knows who it&apos;s working for.</p>

          <label htmlFor="ws-name" className="mt-8 block text-[13px] font-medium text-fg-2">
            Business name
          </label>
          <input
            id="ws-name"
            autoFocus
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Studio"
            className="mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-[15px] outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none"
          />

          <label htmlFor="ws-about" className="mt-5 block text-[13px] font-medium text-fg-2">
            What does the business do? <span className="font-normal text-fg-3">Optional</span>
          </label>
          <textarea
            id="ws-about"
            rows={4}
            maxLength={8000}
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            placeholder="What you sell, who buys it, and the tools you run on. For example: we sell handmade candles on Shopify and wholesale to about 20 shops…"
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
            Give the agent access to the tools {created ? <span className="text-fg-2">{created}</span> : "your business"} runs on. It
            asks before sending, changing, or deleting anything, and only you can use your connections.
          </p>
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
