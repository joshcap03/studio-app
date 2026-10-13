"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";

export function PasswordForm({ email }: { email: string | null }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Something went wrong. Try again.");
        setPending(false);
        return;
      }
      window.location.assign("/");
    } catch {
      setError("Couldn't reach the server. Check your connection.");
      setPending(false);
    }
  }

  return (
    <>
      <h1 className="mt-10 font-display text-[28px] leading-tight tracking-[-0.01em]">Choose a new password</h1>
      <p className="mt-1.5 text-[14px] text-fg-3">{email ? `For ${email}.` : "For your account."}</p>

      <form onSubmit={submit} className="mt-8 space-y-4" noValidate>
        {/* Lets password managers save the new password against the right account. */}
        <input type="email" autoComplete="username" value={email ?? ""} readOnly hidden />
        <div>
          <label htmlFor="password" className="text-[13px] font-medium text-fg-2">
            New password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-[15px] text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none"
            placeholder="At least 10 characters"
          />
        </div>

        <p role="alert" className="min-h-5 text-[13px] text-danger">
          {error}
        </p>

        <button
          type="submit"
          disabled={!password || pending}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-inverse text-[14px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-30"
        >
          {pending ? <span className="spinner border-on-inverse/30 border-t-on-inverse" /> : "Save password"}
          {!pending && <ArrowRight size={15} />}
        </button>
      </form>
    </>
  );
}
