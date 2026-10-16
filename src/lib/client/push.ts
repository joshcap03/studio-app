// Notifications on this device (Web Push): the service worker, and subscribing or
// unsubscribing this browser for the signed-in member.

export type PushState =
  /** The browser can't do Web Push at all. */
  | "unsupported"
  /** iPhone/iPad Safari: only works once Studio is added to the Home Screen. */
  | "needs-install"
  /** The server has no push keys. */
  | "unavailable"
  /** The member blocked notifications for this site. */
  | "denied"
  | "off"
  | "on";

function supported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isAppleMobile(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isInstalled(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  } catch {
    return null;
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!supported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

async function publicKey(): Promise<string | null> {
  const res = await fetch("/api/push", { cache: "no-store" });
  if (!res.ok) return null;
  return ((await res.json()) as { publicKey: string | null }).publicKey;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isAppleMobile() && !isInstalled() ? "needs-install" : "unsupported";
  if (!(await publicKey())) return "unavailable";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && (await currentSubscription()) ? "on" : "off";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Asks for permission (call from a tap: iOS requires it) and subscribes this device. */
export async function enablePush(): Promise<PushState> {
  const key = await publicKey();
  if (!key) return "unavailable";
  if ((await Notification.requestPermission()) !== "granted") return Notification.permission === "denied" ? "denied" : "off";
  const registration = (await registerServiceWorker()) && (await navigator.serviceWorker.ready);
  if (!registration) return "unsupported";
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  }
  const res = await fetch("/api/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't turn on notifications.");
  return "on";
}

/**
 * Stops notifications on this device: removes the member's subscription and unsubscribes the
 * browser, so the push service rejects anything still addressed to it (by anyone).
 */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await fetch("/api/push", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => undefined);
  await subscription.unsubscribe().catch(() => undefined);
}
