"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";

type Mode = "signin" | "signup" | "forgot";

const COPY: Record<Mode, { title: string; subtitle: string; submit: string; switchText: string; switchAction: string }> = {
  signin: {
    title: "Welcome back",
    subtitle: "Sign in to pick up where you left off.",
    submit: "Sign in",
    switchText: "New here?",
    switchAction: "Create an account",
  },
  signup: {
    title: "Create your account",
    subtitle: "An AI agent you shape for any job, working in the apps you already use.",
    submit: "Create account",
    switchText: "Already have an account?",
    switchAction: "Sign in",
  },
  forgot: {
    title: "Reset your password",
    subtitle: "Enter your email and we'll send you a link to choose a new one.",
    submit: "Send reset link",
    switchText: "Remembered it?",
    switchAction: "Sign in",
  },
};

const ENDPOINT: Record<Mode, string> = { signin: "/api/auth/signin", signup: "/api/auth/signup", forgot: "/api/auth/reset" };

export function AuthForm({ destination, initialMode, notice }: { destination: string; initialMode: Mode; notice: string | null }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(notice);
  const [pending, setPending] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);
  const copy = COPY[mode];

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT[mode], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "forgot" ? { email } : { email, password }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; confirmEmail?: boolean } | null;
      if (!res.ok) {
        setError(body?.error ?? "Something went wrong. Try again.");
        setPending(false);
        return;
      }
      if (mode === "forgot" || body?.confirmEmail) {
        setCheckEmail(true);
        setPending(false);
        return;
      }
      window.location.assign(mode === "signup" ? "/onboarding" : destination);
    } catch {
      setError("Couldn't reach the server. Check your connection.");
      setPending(false);
    }
  }

  if (checkEmail) {
    return (
      <div className="mt-10 animate-fade-up">
        <h1 className="font-display text-[28px] leading-tight tracking-[-0.01em]">Check your email</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-fg-2">
          {mode === "forgot" ? (
            <>
              If <span className="font-medium text-fg">{email}</span> has an account, we sent it a link to choose a new password.
            </>
          ) : (
            <>
              We sent a confirmation link to <span className="font-medium text-fg">{email}</span>. Open it to finish setting up.
            </>
          )}
        </p>
      </div>
    );
  }

  const field =
    "h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-[15px] text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none";

  return (
    <>
      <h1 className="mt-10 font-display text-[28px] leading-tight tracking-[-0.01em]">{copy.title}</h1>
      <p className="mt-1.5 text-[14px] text-fg-3">{copy.subtitle}</p>

      <form onSubmit={submit} className="mt-8 space-y-4" noValidate>
        <div>
          <label htmlFor="email" className="text-[13px] font-medium text-fg-2">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`mt-1.5 ${field}`}
            placeholder="you@example.com"
          />
        </div>
        {mode !== "forgot" && (
          <div>
            <div className="flex items-baseline justify-between">
              <label htmlFor="password" className="text-[13px] font-medium text-fg-2">
                Password
              </label>
              {mode === "signin" && (
                <button
                  type="button"
                  onClick={() => {
                    setMode("forgot");
                    setError(null);
                  }}
                  className="text-[12.5px] text-fg-3 underline-offset-4 hover:text-fg hover:underline"
                >
                  Forgot password?
                </button>
              )}
            </div>
            <input
              id="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
              minLength={mode === "signup" ? 10 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`mt-1.5 ${field}`}
              placeholder={mode === "signup" ? "At least 10 characters" : ""}
            />
          </div>
        )}

        <p role="alert" className="min-h-5 text-[13px] text-danger">
          {error}
        </p>

        <button
          type="submit"
          disabled={!email || (mode !== "forgot" && !password) || pending}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-inverse text-[14px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-30"
        >
          {pending ? <span className="spinner border-on-inverse/30 border-t-on-inverse" /> : copy.submit}
          {!pending && <ArrowRight size={15} />}
        </button>
      </form>

      <p className="mt-6 text-[13.5px] text-fg-3">
        {copy.switchText}{" "}
        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
          }}
          className="font-medium text-fg underline-offset-4 hover:underline"
        >
          {copy.switchAction}
        </button>
      </p>
    </>
  );
}
