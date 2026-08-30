/*
 * PI WEB service worker.
 *
 * Minimal by design: it exists so the PWA is installable (browsers require a worker with an
 * install handler) and so later features (web push) have a worker to attach to. It must not
 * intercept or cache fetches: the app streams live session data over HTTP/SSE/WebSocket.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
