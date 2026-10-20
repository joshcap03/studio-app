// Opening a conversation that may have changed on the server since this tab loaded it: a task's
// run, or a notification tapped while a Studio window is open (public/sw.js asks that window to
// go there, "studio:open", rather than reloading it). Pure, for the workspace.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OpenRequest =
  /** A conversation, and the reply whose voice note to point out, if any. */
  | { kind: "conversation"; conversationId: string; play: string | null }
  /** Any other page of the app. */
  | { kind: "page"; path: string };

/** Where a tapped notification asks this page to go, or null when `data` isn't that message (or points off the app). */
export function openRequest(data: unknown, origin: string): OpenRequest | null {
  const message = data as { type?: unknown; url?: unknown } | null;
  if (message?.type !== "studio:open" || typeof message.url !== "string" || !message.url.startsWith("/")) return null;
  let target: URL;
  try {
    target = new URL(message.url, origin);
  } catch {
    return null;
  }
  if (target.origin !== origin) return null;
  const match = /^\/c\/([^/]+)\/?$/.exec(target.pathname);
  if (!match || !UUID.test(match[1])) return { kind: "page", path: target.pathname };
  const play = target.searchParams.get("play");
  return { kind: "conversation", conversationId: match[1], play: play && UUID.test(play) ? play : null };
}

/**
 * What to do with the copy of a conversation in memory when it's opened again: "keep" one this
 * tab is still streaming into (it's current); "refresh" the one on screen, loading it again in
 * place, since going to where the page already is loads nothing and dropping it would leave the
 * page waiting; "drop" any other, so going there loads it.
 */
export function reopening(conversationId: string, { onScreen, streaming }: { onScreen: string | null; streaming: boolean }): "keep" | "refresh" | "drop" {
  if (streaming) return "keep";
  return onScreen === conversationId ? "refresh" : "drop";
}
