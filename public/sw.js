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

// How long a chat page has to say it heard studio:open before it's sent there instead.
const HEARD_MS = 1000;

/** Whether `client` heard `message`: the chat page answers on the port it's given. */
function heard(client, message) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const done = (yes) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(yes);
    };
    const timer = setTimeout(() => done(false), HEARD_MS);
    channel.port1.onmessage = () => done(true);
    client.postMessage(message, [channel.port2]);
  });
}

// A tap opens what the notification is about in a Studio window that's already open, if there
// is one. On a chat page, the page moves there itself (studio:open), without reloading, so a
// voice note's play button is ready to tap. A page that doesn't say it heard (one loaded before
// this worker, which doesn't listen for it, or one still starting) is sent there, like any other
// page. A window this worker doesn't control can't hear either, so a new one opens instead.
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
      if (CHAT_PAGE.test(new URL(client.url).pathname) && (await heard(client, { type: "studio:open", url: url.slice(self.location.origin.length) }))) return;
      if ("navigate" in client) return client.navigate(url);
      return self.clients.openWindow(url);
    })(),
  );
});
