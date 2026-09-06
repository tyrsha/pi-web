import { describe, expect, it, vi } from "vitest";
import { isPwaPushSubscriptionEnabled, PushSubscriptionBinding, setPwaPushSubscriptionEnabled, type PushSubscriptionBindingDependencies, type PushSubscriptionRegistration, type PushSubscriptionTarget } from "./pushSubscriptionBinding.js";

const TARGET: PushSubscriptionTarget = { sessionId: "session-1", projectId: "project-1", workspaceId: "workspace-1", foreground: false };
const SUBSCRIPTION = { endpoint: "https://push.example/one", keys: { p256dh: "p256dh", auth: "auth" } };

interface BrowserSubscription { toJSON(): PushSubscriptionJSON }
interface BrowserRegistration { pushManager: { getSubscription(): Promise<BrowserSubscription | null> } }

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function bindingDependencies(enabled: boolean): {
  readonly deps: PushSubscriptionBindingDependencies;
  readonly getRegistration: ReturnType<typeof vi.fn<() => Promise<BrowserRegistration>>>;
  readonly getSubscription: ReturnType<typeof vi.fn<() => Promise<BrowserSubscription>>>;
  readonly subscribe: ReturnType<typeof vi.fn<(subscription: PushSubscriptionRegistration) => Promise<void>>>;
} {
  const getSubscription = vi.fn<() => Promise<BrowserSubscription>>(() => Promise.resolve({ toJSON: () => SUBSCRIPTION }));
  const getRegistration = vi.fn<() => Promise<BrowserRegistration>>(() => Promise.resolve({ pushManager: { getSubscription } }));
  const subscribe = vi.fn<(subscription: PushSubscriptionRegistration) => Promise<void>>(() => Promise.resolve());
  return { deps: { getRegistration, subscribe, instanceId: () => "instance-1", isEnabled: () => enabled }, getRegistration, getSubscription, subscribe };
}

describe("PWA push subscription binding", () => {
  it.each(["registration", "subscription", "subscribe", "storage"] as const)("stops after a %s failure and retries the latest target on a later sync", async (stage) => {
    vi.useFakeTimers();
    try {
      const harness = bindingDependencies(true);
      const error = new Error("Push binding unavailable");
      const onError = vi.fn();
      const instanceId = vi.fn(() => "instance-1");
      // Bound the failing fake: the regression used to spin forever on persistent
      // rejection, starving even the test runner's timeout. Three failures expose
      // the unwanted immediate retries without hanging the suite.
      if (stage === "registration") harness.getRegistration.mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockRejectedValueOnce(error);
      if (stage === "subscription") harness.getSubscription.mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockRejectedValueOnce(error);
      if (stage === "subscribe") harness.subscribe.mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockRejectedValueOnce(error);
      if (stage === "storage") {
        const fail = () => { throw error; };
        instanceId.mockImplementationOnce(fail).mockImplementationOnce(fail).mockImplementationOnce(fail);
      }
      const binding = new PushSubscriptionBinding({ ...harness.deps, instanceId, onError });

      binding.sync(TARGET);
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
      expect(harness.getRegistration).toHaveBeenCalledOnce();

      harness.getRegistration.mockReset().mockResolvedValue({ pushManager: { getSubscription: harness.getSubscription } });
      harness.getSubscription.mockReset().mockResolvedValue({ toJSON: () => SUBSCRIPTION });
      harness.subscribe.mockReset().mockResolvedValue();
      instanceId.mockReset().mockReturnValue("instance-1");
      const latest = { ...TARGET, sessionId: "session-2", foreground: true };
      binding.sync(latest);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.subscribe).toHaveBeenCalledExactlyOnceWith({ ...SUBSCRIPTION, instanceId: "instance-1", ...latest });
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still sends a trailing target change after a successful in-flight sync", async () => {
    const harness = bindingDependencies(true);
    let finish: (() => void) | undefined;
    harness.subscribe.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const binding = new PushSubscriptionBinding(harness.deps);
    binding.sync(TARGET);
    await vi.waitFor(() => { expect(harness.subscribe).toHaveBeenCalledOnce(); });
    const latest = { ...TARGET, sessionId: "session-2" };
    binding.sync(latest);
    expect(harness.subscribe).toHaveBeenCalledOnce();
    finish?.();
    await vi.waitFor(() => { expect(harness.subscribe).toHaveBeenCalledTimes(2); });
    expect(harness.subscribe).toHaveBeenLastCalledWith({ ...SUBSCRIPTION, instanceId: "instance-1", ...latest });
  });
  it("persists the explicit enabled choice per PWA storage partition", () => {
    const storage = memoryStorage();
    expect(isPwaPushSubscriptionEnabled(storage)).toBe(false);
    setPwaPushSubscriptionEnabled(true, storage);
    expect(isPwaPushSubscriptionEnabled(storage)).toBe(true);
    setPwaPushSubscriptionEnabled(false, storage);
    expect(isPwaPushSubscriptionEnabled(storage)).toBe(false);
  });

  it("does not touch Service Worker or PushManager APIs while push is disabled", async () => {
    const harness = bindingDependencies(false);
    const binding = new PushSubscriptionBinding(harness.deps);

    binding.sync(TARGET);
    await Promise.resolve();
    expect(harness.getRegistration).not.toHaveBeenCalled();
    expect(harness.getSubscription).not.toHaveBeenCalled();
    expect(harness.subscribe).not.toHaveBeenCalled();

    binding.setEnabled(true);
    await vi.waitFor(() => { expect(harness.subscribe).toHaveBeenCalledOnce(); });
    expect(harness.subscribe).toHaveBeenCalledWith({ ...SUBSCRIPTION, instanceId: "instance-1", ...TARGET });
  });

  it("does not continue a pending Web Push lookup after the user disables push", async () => {
    let resolveRegistration: ((registration: BrowserRegistration) => void) | undefined;
    const registration = new Promise<BrowserRegistration>((resolve) => { resolveRegistration = resolve; });
    const getSubscription = vi.fn<() => Promise<BrowserSubscription>>(() => Promise.resolve({ toJSON: () => SUBSCRIPTION }));
    const getRegistration = vi.fn<() => Promise<BrowserRegistration>>(() => registration);
    const subscribe = vi.fn<(subscription: PushSubscriptionRegistration) => Promise<void>>(() => Promise.resolve());
    const deps: PushSubscriptionBindingDependencies = { getRegistration, subscribe, instanceId: () => "instance-1", isEnabled: () => true };
    const binding = new PushSubscriptionBinding(deps);

    binding.sync(TARGET);
    await vi.waitFor(() => { expect(getRegistration).toHaveBeenCalledOnce(); });
    binding.setEnabled(false);
    resolveRegistration?.({ pushManager: { getSubscription } });
    await Promise.resolve();
    await Promise.resolve();

    expect(getSubscription).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });
});
