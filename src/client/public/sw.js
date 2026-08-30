// PI WEB service worker — intentionally minimal on fetches, full-featured for push.
//
// No fetch handling on purpose: the app streams live session data (HTTP and WebSocket) and relies
// on the network, so intercepting requests here could only add stale or broken traffic.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** Render server-pushed notifications (assistant message completions and session errors). */
self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : undefined;
  } catch {
    data = undefined; // Malformed payloads must never break the worker.
  }
  const title = typeof data?.title === "string" && data.title !== "" ? data.title : "PI WEB";
  const body = typeof data?.body === "string" ? data.body : "";
  const notificationData = data?.data && typeof data.data === "object" ? data.data : {};
  // Icon paths stay relative to the worker scope so nested deployments resolve inside their prefix.
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: `${self.registration.scope}pwa-icon-192.png`,
    data: notificationData,
  }));
});

/** Focus (or open) the app and route into the session that produced the notification. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = typeof event.notification.data?.sessionId === "string" ? event.notification.data.sessionId : "";
  const targetUrl = new URL(self.registration.scope);
  if (sessionId !== "") targetUrl.searchParams.set("session", sessionId);
  event.waitUntil((async () => {
    for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
      try {
        await client.focus();
        if (sessionId !== "") await client.navigate(targetUrl.toString());
        return;
      } catch {
        // Unreachable clients are skipped; the next one wins.
      }
    }
    if (sessionId !== "") return self.clients.openWindow(targetUrl.toString());
  })());
});
