"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";

export function LoginForm({ destination }: { destination: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!password || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Couldn't sign in. Try again.");
        setPending(false);
        return;
      }
      window.location.assign(destination);
    } catch {
      setError("Couldn't reach the server. Check your connection.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-8" noValidate>
      <label htmlFor="password" className="text-[13px] font-medium text-fg-2">
        Password
      </label>
      <div className="mt-2 flex items-center gap-2 rounded-xl border border-line bg-surface p-1 pl-3.5 shadow-composer transition-colors focus-within:border-line-strong">
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (error) setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
          className="h-9 min-w-0 flex-1 bg-transparent text-[15px] outline-none focus-visible:outline-none placeholder:text-fg-4"
          placeholder="Enter password"
        />
        <button
          type="submit"
          disabled={!password || pending}
          aria-label="Sign in"
          className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-inverse text-on-inverse transition-[opacity,transform] hover:opacity-90 active:scale-95 disabled:opacity-25"
        >
          {pending ? <span className="spinner border-on-inverse/30 border-t-on-inverse" /> : <ArrowRight size={16} strokeWidth={2} />}
        </button>
      </div>
      <p id="login-error" role="alert" className="mt-3 min-h-5 text-[13px] text-danger">
        {error}
      </p>
    </form>
  );
}
