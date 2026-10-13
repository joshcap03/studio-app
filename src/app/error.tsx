"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <h1 className="font-display text-[26px] tracking-[-0.01em]">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-[14px] text-fg-3">The workspace hit an unexpected error. Your conversations are safe.</p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 h-9 rounded-lg bg-inverse px-4 text-[13.5px] font-medium text-on-inverse transition-opacity hover:opacity-90"
      >
        Try again
      </button>
    </main>
  );
}
