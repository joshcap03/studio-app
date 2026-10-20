// Studio's service worker: shows push notifications and opens the conversation they're
// about. No offline caching; every page still comes from the network.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/";
  event.waitUntil(
    self.registration.showNotification(data.title || "Studio", {
      body: data.body || "",
      tag: data.tag || url,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url },
    }),
  );
});

// The chat's pages, which move between themselves without a reload (src/components/workspace).
const CHAT_PAGE = /^\/(?:$|[cp]\/|tasks(?:\/|$)|library(?:\/|$))/;

// A tap opens what the notification is about in a Studio window that's already open, if there
// is one. On a chat page, the page moves there itself (studio:open), without reloading, so a
// voice note's play button is ready to tap; another page is sent there. A window this worker
// doesn't control can't hear either, so a new one opens instead.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin + "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window" });
      const client = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (!client) return self.clients.openWindow(url);
      await client.focus();
      if (CHAT_PAGE.test(new URL(client.url).pathname)) {
        client.postMessage({ type: "studio:open", url: url.slice(self.location.origin.length) });
        return;
      }
      if ("navigate" in client) return client.navigate(url);
      return self.clients.openWindow(url);
    })(),
  );
});
