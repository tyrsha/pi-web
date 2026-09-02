import { TrailingRefreshCoordinator } from "../controllers/trailingRefreshCoordinator";

interface BrowserEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface ScheduledFrame {
  cancel(): void;
}

/** WebKit can lose a queued animation frame while resuming a suspended standalone PWA. */
export const BROWSER_RESUME_FRAME_FALLBACK_MS = 250;

export type BrowserResumeTrigger = "focus" | "online" | "pageshow" | "visibility";

export interface BrowserResumeCallbacks {
  onResumeSignal(trigger: BrowserResumeTrigger): void;
  refreshAfterResume(): void | Promise<void>;
  onRefreshError(error: unknown): void;
}

export interface BrowserResumeControllerOptions {
  windowTarget?: BrowserEventTarget | undefined;
  documentTarget?: BrowserEventTarget | undefined;
  isDocumentVisible?: (() => boolean) | undefined;
  scheduleFrame?: ((callback: () => void) => ScheduledFrame) | undefined;
}

/** Owns browser resume listeners and batches focus/visibility refreshes per frame. */
export class BrowserResumeController {
  private readonly windowTarget: BrowserEventTarget | undefined;
  private readonly documentTarget: BrowserEventTarget | undefined;
  private readonly isDocumentVisible: () => boolean;
  private readonly scheduleFrame: (callback: () => void) => ScheduledFrame;
  private readonly refreshes = new TrailingRefreshCoordinator<"browser-resume">();
  private scheduledRefresh: ScheduledFrame | undefined;
  private connected = false;

  constructor(private readonly callbacks: BrowserResumeCallbacks, options: BrowserResumeControllerOptions = {}) {
    this.windowTarget = options.windowTarget ?? browserWindowTarget();
    this.documentTarget = options.documentTarget ?? browserDocumentTarget();
    this.isDocumentVisible = options.isDocumentVisible ?? documentIsVisible;
    this.scheduleFrame = options.scheduleFrame ?? scheduleBrowserFrame;
  }

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.windowTarget?.addEventListener("focus", this.onResumeEvent);
    this.windowTarget?.addEventListener("online", this.onResumeEvent);
    this.windowTarget?.addEventListener("pageshow", this.onResumeEvent);
    this.documentTarget?.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.windowTarget?.removeEventListener("focus", this.onResumeEvent);
    this.windowTarget?.removeEventListener("online", this.onResumeEvent);
    this.windowTarget?.removeEventListener("pageshow", this.onResumeEvent);
    this.documentTarget?.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.cancelScheduledRefresh();
  }

  private readonly onResumeEvent: EventListener = (event) => {
    if (event.type !== "focus" && event.type !== "online" && event.type !== "pageshow") return;
    // iOS standalone PWAs can dispatch pageshow before visibility becomes visible.
    // Refreshing then churns sockets and HTTP while WebKit still suspends the page.
    if (!this.isDocumentVisible()) {
      this.cancelScheduledRefresh();
      return;
    }
    this.handleResumeSignal(event.type);
  };

  private readonly onVisibilityChange: EventListener = () => {
    if (this.isDocumentVisible()) this.handleResumeSignal("visibility");
    else this.cancelScheduledRefresh();
  };

  private handleResumeSignal(trigger: BrowserResumeTrigger): void {
    this.callbacks.onResumeSignal(trigger);
    // WebKit may discard a queued animation frame while suspending an installed PWA.
    // Replace, rather than trust, any pre-suspension callback on every fresh resume signal.
    this.cancelScheduledRefresh();
    this.scheduledRefresh = this.scheduleFrame(() => {
      this.scheduledRefresh = undefined;
      if (!this.connected) return;
      void this.refreshes.request("browser-resume", async () => {
        if (this.connected) await this.callbacks.refreshAfterResume();
      }).catch((error: unknown) => { this.callbacks.onRefreshError(error); });
    });
  }

  private cancelScheduledRefresh(): void {
    this.scheduledRefresh?.cancel();
    this.scheduledRefresh = undefined;
  }
}

function browserWindowTarget(): BrowserEventTarget | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function browserDocumentTarget(): BrowserEventTarget | undefined {
  return typeof document === "undefined" ? undefined : document;
}

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

export function scheduleBrowserFrame(callback: () => void): ScheduledFrame {
  let completed = false;
  let frame: number | undefined;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const run = () => {
    if (completed) return;
    completed = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    if (timer !== undefined) globalThis.clearTimeout(timer);
    callback();
  };
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    frame = window.requestAnimationFrame(run);
    timer = globalThis.setTimeout(run, BROWSER_RESUME_FRAME_FALLBACK_MS);
  } else {
    timer = globalThis.setTimeout(run, 0);
  }
  return {
    cancel: () => {
      completed = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      globalThis.clearTimeout(timer);
    },
  };
}
