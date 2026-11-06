// The shell's two modes with several agents (src/components/sidebar/sidebar.tsx). Remembered in a
// cookie, not browser storage, so the server renders the mode the member left in: a page load
// never shows one mode and then swaps to the other. It only picks a view; nothing is authorized by it.

export type ShellMode = "home" | "studio";

export const MODE_COOKIE = "lj.mode";

export function parseShellMode(value: string | undefined): ShellMode {
  return value === "studio" ? "studio" : "home";
}

/** Browser only. */
export function rememberShellMode(mode: ShellMode): void {
  document.cookie = `${MODE_COOKIE}=${mode}; path=/; max-age=31536000; samesite=lax`;
}
