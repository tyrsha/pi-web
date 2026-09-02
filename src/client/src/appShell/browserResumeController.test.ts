import { describe, expect, it, vi } from "vitest";
import { BROWSER_RESUME_FRAME_FALLBACK_MS, BrowserResumeController, scheduleBrowserFrame } from "./browserResumeController";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolveDeferred = resolve; });
  if (resolveDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred };
}

function frameHarness() {
  const frames: { callback: () => void; canceled: boolean }[] = [];
  return {
    scheduleFrame: (callback: () => void) => {
      const frame = { callback, canceled: false };
      frames.push(frame);
      return { cancel: () => { frame.canceled = true; } };
    },
    pendingCount: () => frames.filter((frame) => !frame.canceled).length,
    runNext: () => {
      while (frames.length > 0) {
        const frame = frames.shift();
        if (frame !== undefined && !frame.canceled) {
          frame.callback();
          return;
        }
      }
      throw new Error("No scheduled frame");
    },
  };
}

describe("BrowserResumeController", () => {
  it("falls back to a timer when a resumed PWA never runs the queued animation frame", () => {
    vi.useFakeTimers();
    try {
      const requestAnimationFrame = vi.fn(() => 7);
      const cancelAnimationFrame = vi.fn();
      vi.stubGlobal("window", { requestAnimationFrame, cancelAnimationFrame });
      const callback = vi.fn();

      scheduleBrowserFrame(callback);
      vi.advanceTimersByTime(BROWSER_RESUME_FRAME_FALLBACK_MS);

      expect(requestAnimationFrame).toHaveBeenCalledOnce();
      expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
      expect(callback).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("batches overlapping focus and visible signals into one app refresh", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const frames = frameHarness();
    const refreshGate = deferred<undefined>();
    const refreshStarted = deferred<undefined>();
    const refreshCompleted = deferred<undefined>();
    const onResumeSignal = vi.fn();
    let visible = true;
    let refreshCalls = 0;
    const controller = new BrowserResumeController({
      onResumeSignal,
      refreshAfterResume: async () => {
        refreshCalls += 1;
        refreshStarted.resolve(undefined);
        await refreshGate.promise;
        refreshCompleted.resolve(undefined);
      },
      onRefreshError: (error) => { throw error; },
    }, {
      windowTarget,
      documentTarget,
      isDocumentVisible: () => visible,
      scheduleFrame: frames.scheduleFrame,
    });
    controller.connect();

    windowTarget.dispatchEvent(new Event("focus"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("focus"));

    expect(onResumeSignal).toHaveBeenCalledTimes(3);
    expect(frames.pendingCount()).toBe(1);
    expect(refreshCalls).toBe(0);

    frames.runNext();
    await refreshStarted.promise;
    expect(refreshCalls).toBe(1);

    visible = false;
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(onResumeSignal).toHaveBeenCalledTimes(3);
    expect(frames.pendingCount()).toBe(0);

    refreshGate.resolve(undefined);
    await refreshCompleted.promise;
    visible = true;
    windowTarget.dispatchEvent(new Event("focus"));
    expect(frames.pendingCount()).toBe(1);
    controller.disconnect();
    expect(frames.pendingCount()).toBe(0);
    await Promise.resolve();
    windowTarget.dispatchEvent(new Event("focus"));
    expect(onResumeSignal).toHaveBeenCalledTimes(4);
    expect(refreshCalls).toBe(1);
  });

  it("treats pageshow and online as resume signals", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const frames = frameHarness();
    const onResumeSignal = vi.fn();
    const refreshAfterResume = vi.fn(() => Promise.resolve());
    const controller = new BrowserResumeController({
      onResumeSignal,
      refreshAfterResume,
      onRefreshError: (error) => { throw error; },
    }, {
      windowTarget,
      documentTarget,
      isDocumentVisible: () => true,
      scheduleFrame: frames.scheduleFrame,
    });
    controller.connect();

    windowTarget.dispatchEvent(new Event("pageshow"));
    windowTarget.dispatchEvent(new Event("online"));
    expect(onResumeSignal).toHaveBeenCalledTimes(2);
    expect(frames.pendingCount()).toBe(1);
    frames.runNext();
    await Promise.resolve();
    expect(refreshAfterResume).toHaveBeenCalledOnce();
    controller.disconnect();
  });

  it("waits for visibility before handling a premature hidden pageshow", () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const frames = frameHarness();
    const onResumeSignal = vi.fn();
    let visible = false;
    const controller = new BrowserResumeController({
      onResumeSignal,
      refreshAfterResume: () => Promise.resolve(),
      onRefreshError: (error) => { throw error; },
    }, {
      windowTarget,
      documentTarget,
      isDocumentVisible: () => visible,
      scheduleFrame: frames.scheduleFrame,
    });
    controller.connect();

    windowTarget.dispatchEvent(new Event("pageshow"));
    windowTarget.dispatchEvent(new Event("online"));
    expect(onResumeSignal).not.toHaveBeenCalled();
    expect(frames.pendingCount()).toBe(0);

    visible = true;
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(onResumeSignal).toHaveBeenCalledWith("visibility");
    expect(frames.pendingCount()).toBe(1);
    controller.disconnect();
  });

  it("discards a pre-suspension frame and schedules fresh work when visibility returns", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const frames = frameHarness();
    const refreshAfterResume = vi.fn(() => Promise.resolve());
    let visible = true;
    const controller = new BrowserResumeController({
      onResumeSignal: () => undefined,
      refreshAfterResume,
      onRefreshError: (error) => { throw error; },
    }, {
      windowTarget,
      documentTarget,
      isDocumentVisible: () => visible,
      scheduleFrame: frames.scheduleFrame,
    });
    controller.connect();

    windowTarget.dispatchEvent(new Event("focus"));
    visible = false;
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(frames.pendingCount()).toBe(0);

    visible = true;
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(frames.pendingCount()).toBe(1);
    frames.runNext();
    await Promise.resolve();
    expect(refreshAfterResume).toHaveBeenCalledOnce();
    controller.disconnect();
  });

  it("runs one trailing refresh when another resume arrives during active work", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const frames = frameHarness();
    const firstGate = deferred<undefined>();
    const secondGate = deferred<undefined>();
    const firstStarted = deferred<undefined>();
    const secondStarted = deferred<undefined>();
    const secondCompleted = deferred<undefined>();
    let refreshCalls = 0;
    const controller = new BrowserResumeController({
      onResumeSignal: () => undefined,
      refreshAfterResume: async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          firstStarted.resolve(undefined);
          await firstGate.promise;
          return;
        }
        secondStarted.resolve(undefined);
        await secondGate.promise;
        secondCompleted.resolve(undefined);
      },
      onRefreshError: (error) => { throw error; },
    }, {
      windowTarget,
      documentTarget,
      isDocumentVisible: () => true,
      scheduleFrame: frames.scheduleFrame,
    });
    controller.connect();

    windowTarget.dispatchEvent(new Event("focus"));
    frames.runNext();
    await firstStarted.promise;

    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("focus"));
    expect(frames.pendingCount()).toBe(1);
    frames.runNext();
    expect(refreshCalls).toBe(1);

    firstGate.resolve(undefined);
    await secondStarted.promise;
    expect(refreshCalls).toBe(2);

    secondGate.resolve(undefined);
    await secondCompleted.promise;
    controller.disconnect();
  });
});
