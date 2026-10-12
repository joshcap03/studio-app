export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <h1 className="font-display text-[26px] tracking-[-0.01em]">Page not found</h1>
      <a href="/" className="mt-4 text-[14px] text-fg-2 underline underline-offset-4 hover:text-fg">
        Back to the workspace
      </a>
    </main>
  );
}
