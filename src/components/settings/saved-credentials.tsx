"use client";

import { CreditCard, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import type { CredentialSummary } from "@/lib/secrets";

/**
 * The logins and cards the member saved from the secure fill card, for every agent's browser.
 * Shown by site, username, or brand and last four; their secrets are never sent here. Removing
 * one is the only change: a new one is saved the next time it's filled in.
 */
export function SavedCredentials() {
  const [state, setState] = useState<{ credentials: CredentialSummary[]; enabled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      setState(await api.listCredentials());
    } catch {
      setError("Couldn't load your saved logins and cards.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api.deleteCredential(id);
      await load();
    } catch {
      setError("Couldn't remove that. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (!state && !error) return <div className="h-16 animate-pulse rounded-xl bg-subtle/60" aria-busy="true" />;

  if (state && state.credentials.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong px-4 py-5 text-[14px] text-fg-2">
        <p className="font-medium text-fg">Nothing saved yet.</p>
        <p className="mt-1 text-fg-3">
          {state.enabled
            ? "When an agent needs to sign in or pay in its browser, you fill it in on a secure card and can save it for next time."
            : "Saving logins and cards isn't set up yet. You can still fill one in each time an agent asks."}
        </p>
      </div>
    );
  }

  return (
    <div>
      {state ? (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {state.credentials.map((c) => {
            const Icon = c.kind === "card" ? CreditCard : KeyRound;
            return (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                <Icon size={16} className="shrink-0 text-fg-3" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">
                    {c.kind === "card" ? `${c.brand ?? "Card"} •••• ${c.last4}` : c.origin ? new URL(c.origin).hostname.replace(/^www\./, "") : c.label}
                  </span>
                  <span className="block truncate text-[12.5px] text-fg-3">{c.kind === "card" ? `Expires ${c.exp}` : (c.username ?? "Password only")}</span>
                </span>
                <button type="button" disabled={busy === c.id} onClick={() => void remove(c.id)} className="text-[13px] text-fg-3 hover:text-danger disabled:opacity-40">
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
    </div>
  );
}
