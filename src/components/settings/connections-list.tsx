"use client";

import { Check, Plug } from "lucide-react";
import { useEffect, useState } from "react";
import type { ConnectionsState } from "@/lib/types";

/**
 * The signed-in member's own connected apps. Connecting sends them to the provider's
 * authorization page; credentials never pass through this app.
 */
export function ConnectionsList({ returnTo }: { returnTo: "/onboarding" | "/settings" }) {
  const [state, setState] = useState<ConnectionsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/workspace/connections");
    if (!res.ok) {
      setError("Couldn't load your connected apps.");
      return;
    }
    setState((await res.json()) as ConnectionsState);
  }

  useEffect(() => {
    void load();
  }, []);

  async function connect(slug: string) {
    setBusy(slug);
    setError(null);
    const res = await fetch(`/api/workspace/connections/${slug}?return=${encodeURIComponent(returnTo)}`, { method: "POST" });
    const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
    if (!res.ok || !body?.url) {
      setError(body?.error ?? "Couldn't start connecting. Try again.");
      setBusy(null);
      return;
    }
    window.location.assign(body.url);
  }

  async function remove(slug: string) {
    setBusy(slug);
    await fetch(`/api/workspace/connections/${slug}`, { method: "DELETE" });
    await load();
    setBusy(null);
  }

  if (!state && !error) {
    return <div className="h-24 animate-pulse rounded-xl bg-subtle/60" aria-busy="true" />;
  }

  if (state && !state.configured) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong px-4 py-5 text-[14px] text-fg-2">
        <p className="font-medium text-fg">Connected apps aren&apos;t set up on this server yet.</p>
        <p className="mt-1 text-fg-3">
          Once Composio is configured, you&apos;ll connect Gmail, Google Sheets, and more here. Each person&apos;s
          connections stay private to them.
        </p>
      </div>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {state?.toolkits.map((t) => (
          <li key={t.slug} className="flex items-center gap-3 px-4 py-3">
            <span className="flex size-8 items-center justify-center rounded-lg bg-subtle text-fg-2">
              <Plug size={15} strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium">{t.name}</span>
              <span className="block truncate text-[12.5px] text-fg-3">
                {t.status === "connected" ? "Connected" : t.status === "pending" ? "Waiting for authorization" : t.description ?? "Not connected"}
              </span>
            </span>
            {t.status === "connected" ? (
              <span className="flex items-center gap-3">
                <Check size={15} className="text-success" aria-label="Connected" />
                <button
                  type="button"
                  disabled={busy === t.slug}
                  onClick={() => remove(t.slug)}
                  className="text-[13px] text-fg-3 hover:text-danger disabled:opacity-40"
                >
                  Disconnect
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => connect(t.slug)}
                className="h-8 rounded-lg border border-line px-3 text-[13px] font-medium text-fg transition-colors hover:border-line-strong hover:bg-subtle disabled:opacity-40"
              >
                {busy === t.slug ? "Opening…" : "Connect"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
