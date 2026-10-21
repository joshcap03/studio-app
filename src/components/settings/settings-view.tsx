"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { disablePush, enablePush, pushState, type PushState } from "@/lib/client/push";
import type { AccountProfile } from "@/lib/tenant-core";
import { ConnectionsList } from "./connections-list";
import { SavedCredentials } from "./saved-credentials";
import { SaveRow, Section, input, submitOnModEnter, useWarnUnsaved } from "./section";

interface Props {
  email: string | null;
  /** The member's personal guardrail, shown read-only; null when they don't have one. */
  guardrail: string | null;
  /** The person's own profile, shared by all their agents. */
  account: AccountProfile;
}

// What belongs to the person, shared by all their agents. Each agent's own setup lives at /agent.
export function SettingsView({ email, guardrail, account }: Props) {
  return (
    <div className="mt-10 space-y-14">
      {guardrail ? (
        <Section
          title="Personal guardrail"
          description="On. The agent follows these rules for you everywhere, ahead of any other instructions. They can't be changed here."
        >
          <p className="rounded-xl border border-line bg-subtle/50 px-4 py-3 text-[13.5px] leading-relaxed whitespace-pre-wrap text-fg-2">{guardrail}</p>
        </Section>
      ) : null}
      <YouSection initial={account} />
      <Section
        title="Connected apps"
        description="Apps your agents can use for you. Every one of your agents shares these. It asks before changing anything, and only you can use your connections."
      >
        <ConnectionsList returnTo="/settings" />
      </Section>
      <Section title="Saved logins & cards" description="Your agents use these in their browser only when you pick one. They never see them.">
        <SavedCredentials />
      </Section>
      <NotificationsSection />
      <Section title="Account">
        <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3 text-[14px]">
          <span className="truncate text-fg-2">{email}</span>
          <button
            type="button"
            onClick={() => void api.signOut().finally(() => window.location.assign("/login"))}
            className="text-[13.5px] font-medium text-fg-2 hover:text-fg"
          >
            Sign out
          </button>
        </div>
      </Section>
    </div>
  );
}

const PUSH_NOTES: Record<PushState, string> = {
  unsupported: "This browser can't show notifications.",
  "needs-install": "On iPhone, add Studio to your Home Screen first: tap Share, then Add to Home Screen, and open it from there.",
  unavailable: "Notifications aren't set up on this server yet.",
  denied: "Notifications are blocked for Studio. Allow them in this device's settings, then come back.",
  off: "Get a notification when a task finishes or needs your OK while you're away.",
  on: "You'll get a notification when a task finishes or needs your OK while you're away.",
};

function NotificationsSection() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void pushState().then(setState, () => setState("unsupported"));
  }, []);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (state === "on") {
        await disablePush();
        setState("off");
      } else {
        setState(await enablePush());
      }
    } catch (e) {
      setError((e as Error).message || "Couldn't change notifications. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const switchable = state === "on" || state === "off";
  return (
    <Section title="Notifications on this device">
      <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-3">
        <p className="text-[13.5px] text-fg-2">{state ? PUSH_NOTES[state] : "Checking…"}</p>
        {switchable ? (
          <button
            type="button"
            role="switch"
            aria-checked={state === "on"}
            aria-label="Notifications on this device"
            disabled={busy}
            onClick={() => void toggle()}
            className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-60 ${state === "on" ? "bg-fg" : "bg-line-strong"}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-surface shadow-sm transition-transform ${state === "on" ? "translate-x-4" : ""}`}
            />
          </button>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-[12.5px] text-danger">{error}</p> : null}
    </Section>
  );
}

function YouSection({ initial }: { initial: AccountProfile }) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const dirty = draft.name !== saved.name || draft.about !== saved.about;
  useWarnUnsaved(dirty);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!dirty || status === "saving") return;
    setStatus("saving");
    setError(null);
    try {
      const { account } = await api.updateAccount(draft);
      setSaved(account);
      setDraft(account);
      setStatus("saved");
    } catch (e) {
      setStatus("error");
      setError((e as Error).message || "Couldn't save. Try again.");
    }
  }

  return (
    <Section title="You" description="Every one of your agents reads this, so you only have to say it once.">
      <form onSubmit={save} onKeyDown={submitOnModEnter} className="space-y-5">
        <div>
          <label htmlFor="your-name" className="text-[13px] font-medium text-fg-2">
            Your name
          </label>
          <input
            id="your-name"
            maxLength={80}
            autoComplete="name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={`mt-1.5 h-10 ${input}`}
          />
        </div>
        <div>
          <label htmlFor="about-you" className="text-[13px] font-medium text-fg-2">
            About you
          </label>
          <textarea
            id="about-you"
            rows={4}
            maxLength={4000}
            value={draft.about}
            onChange={(e) => setDraft({ ...draft, about: e.target.value })}
            placeholder="Where you are, what you do, how you like to work…"
            className={`mt-1.5 resize-y py-3 leading-relaxed ${input}`}
          />
        </div>
        <SaveRow dirty={dirty} status={status} error={error} label="Save" />
      </form>
    </Section>
  );
}

