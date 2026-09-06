import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const workerScript = readFileSync(new URL("./client/public/sw.js", import.meta.url), "utf8");
const scope = "https://example.test/nested/pi-web/";

interface NotificationClickEvent {
  notification: { data: unknown; close: () => void };
  waitUntil: (promise: Promise<unknown>) => void;
}

function windowClient() {
  return {
    url: scope,
    navigate: vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue(null),
    focus: vi.fn<() => Promise<unknown>>().mockResolvedValue(null),
  };
}

function clientsBoundary(windows: ReturnType<typeof windowClient>[] = []) {
  return {
    matchAll: vi.fn<() => Promise<ReturnType<typeof windowClient>[]>>().mockResolvedValue(windows),
    openWindow: vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue(null),
  };
}

// Execute the shipped script unchanged; only the worker's browser boundary is injected.
function notificationClick(clients: ReturnType<typeof clientsBoundary>, data: unknown) {
  const listeners = new Map<string, (event: NotificationClickEvent) => void>();
  runInNewContext(workerScript, {
    URL,
    self: {
      registration: { scope },
      clients,
      addEventListener: (name: string, listener: (event: NotificationClickEvent) => void) => {
        listeners.set(name, listener);
      },
    },
  }, { filename: "sw.js" });
  const listener = listeners.get("notificationclick");
  if (!listener) throw new Error("Worker did not register notificationclick");
  const close = vi.fn();
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
  listener({ notification: { data, close }, waitUntil });
  expect(close).toHaveBeenCalledExactlyOnceWith();
  expect(waitUntil).toHaveBeenCalledTimes(1);
  const completion = waitUntil.mock.calls[0]?.[0];
  if (!completion) throw new Error("Notification click did not extend its lifetime");
  return completion;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("service worker notification clicks", () => {
  it("opens the canonical encoded session route inside the deployment scope", async () => {
    const clients = clientsBoundary();
    const completion = notificationClick(clients, {
      sessionId: "session /?&=é",
      projectId: "project /&",
      workspaceId: "workspace ?#",
      cwd: "/home/me/a b&c",
    });

    expect(clients.openWindow).toHaveBeenCalledExactlyOnceWith(
      `${scope}?session=session+%2F%3F%26%3D%C3%A9&project=project+%2F%26&workspace=workspace+%3F%23&view=chat&cwd=%2Fhome%2Fme%2Fa+b%26c`,
    );
    expect(clients.matchAll).not.toHaveBeenCalled();
    await completion;
  });

  it.each(["matchAll", "navigate", "focus"] as const)(
    "opens a session immediately without touching a pending %s boundary",
    async (pendingBoundary) => {
      const client = windowClient();
      const clients = clientsBoundary([client]);
      const pending = deferred<ReturnType<typeof windowClient>[]>();
      if (pendingBoundary === "matchAll") clients.matchAll.mockReturnValue(pending.promise);
      else client[pendingBoundary].mockReturnValue(pending.promise);

      try {
        const completion = notificationClick(clients, { sessionId: "next" });
        // Assert before awaiting: no client enumeration/navigation/focus may gate openWindow.
        expect(clients.openWindow).toHaveBeenCalledExactlyOnceWith(`${scope}?session=next`);
        expect(clients.matchAll).not.toHaveBeenCalled();
        expect(client.navigate).not.toHaveBeenCalled();
        expect(client.focus).not.toHaveBeenCalled();
        await completion;
      } finally {
        pending.resolve([]);
      }
    },
  );

  it("passes openWindow's promise to waitUntil and accepts null without a fallback", async () => {
    const clients = clientsBoundary();
    const opened = deferred<null>();
    clients.openWindow.mockReturnValue(opened.promise);
    try {
      const completion = notificationClick(clients, { sessionId: "session" });
      expect(completion).toBe(opened.promise);
      opened.resolve(null);
      await expect(completion).resolves.toBeNull();
      expect(clients.openWindow).toHaveBeenCalledTimes(1);
      expect(clients.matchAll).not.toHaveBeenCalled();
    } finally {
      opened.resolve(null);
    }
  });

  it("surfaces an openWindow rejection through waitUntil", async () => {
    const clients = clientsBoundary();
    const error = new Error("Window opening denied");
    clients.openWindow.mockRejectedValue(error);

    await expect(notificationClick(clients, { sessionId: "session" })).rejects.toBe(error);
    expect(clients.openWindow).toHaveBeenCalledTimes(1);
    expect(clients.matchAll).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { sessionId: "" }, { sessionId: 42 }])(
    "keeps non-session clicks focus-only for %j",
    async (data) => {
      const first = windowClient();
      const second = windowClient();
      const clients = clientsBoundary([first, second]);

      await notificationClick(clients, data);

      expect(clients.matchAll).toHaveBeenCalledExactlyOnceWith({ type: "window", includeUncontrolled: true });
      expect(first.focus).toHaveBeenCalledExactlyOnceWith();
      expect(second.focus).not.toHaveBeenCalled();
      expect(first.navigate).not.toHaveBeenCalled();
      expect(second.navigate).not.toHaveBeenCalled();
      expect(clients.openWindow).not.toHaveBeenCalled();
    },
  );

  it("keeps skipping unreachable clients on non-session clicks", async () => {
    const first = windowClient();
    const second = windowClient();
    first.focus.mockRejectedValue(new Error("Client disappeared"));
    const clients = clientsBoundary([first, second]);

    await notificationClick(clients, {});

    expect(first.focus).toHaveBeenCalledTimes(1);
    expect(second.focus).toHaveBeenCalledTimes(1);
    expect(first.navigate).not.toHaveBeenCalled();
    expect(second.navigate).not.toHaveBeenCalled();
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not open a non-session window when all clients are unavailable (unreachable: %s)", async (unreachable) => {
    const client = windowClient();
    client.focus.mockRejectedValue(new Error("Client disappeared"));
    const clients = clientsBoundary(unreachable ? [client] : []);

    await expect(notificationClick(clients, {})).resolves.toBeUndefined();

    expect(clients.openWindow).not.toHaveBeenCalled();
    expect(client.navigate).not.toHaveBeenCalled();
  });
});
