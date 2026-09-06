import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("production client build contents", () => {
  it("emits deployment-relative HTML and PWA URLs", async () => {
    const outDir = join(repoRoot, "dist/client");
    const html = await readFile(join(outDir, "index.html"), "utf8");
    const references = htmlAssetReferences(html);
    expect(references).toContain("./favicon.svg");
    expect(references).toContain("./apple-touch-icon.png");
    expect(references).toContain("./manifest.webmanifest");
    const manifestLink = /<link\b[^>]*\brel="manifest"[^>]*>/.exec(html)?.[0];
    expect(manifestLink).toBeDefined();
    expect(manifestLink).toContain('crossorigin="use-credentials"');
    expect(references).toContainEqual(expect.stringMatching(/^\.\/assets\/index-[^/]+\.js$/));
    expect(references.filter((reference) => reference.startsWith("/"))).toEqual([]);

    const manifest = JSON.parse(await readFile(join(outDir, "manifest.webmanifest"), "utf8"));
    expect(manifest).toMatchObject({
      start_url: "./",
      scope: "./",
      icons: [
        { src: "./pwa-icon-192.png" },
        { src: "./pwa-icon-512.png" },
      ],
    });

    const serviceWorker = await readFile(join(outDir, "sw.js"), "utf8");
    expect(serviceWorker).toContain("skipWaiting");
    expect(serviceWorker).toContain("clients.claim()");
    expect(serviceWorker).toContain('addEventListener("push"');
    expect(serviceWorker).toContain("showNotification");
    expect(serviceWorker).toContain("tag:");
    expect(serviceWorker).toContain('addEventListener("notificationclick"');
    expect(serviceWorker).toContain("visibilityState");
    expect(serviceWorker).toContain('addEventListener("message"');
    expect(serviceWorker).toContain("clear-push-notifications");
    expect(serviceWorker).toContain("getNotifications");
    expect(serviceWorker).toContain("event.waitUntil(self.clients.openWindow(targetUrl.toString()))");
    expect(serviceWorker).not.toContain("client.navigate");
    expect(serviceWorker).toContain("client.focus");
    expect(serviceWorker).not.toContain("pi-web:open-session");
    expect(serviceWorker).not.toContain("open-session-ack");
    expect(serviceWorker).toContain('set("cwd"');
    expect(serviceWorker).toContain('set("project"');
    expect(serviceWorker).toContain('set("workspace"');
    // Live session streams must not be intercepted by the service worker.
    expect(serviceWorker).not.toContain('addEventListener("fetch"');
  });
});

function htmlAssetReferences(html) {
  return Array.from(html.matchAll(/\b(?:href|src)="([^"]+)"/g), (match) => match[1] ?? "");
}
