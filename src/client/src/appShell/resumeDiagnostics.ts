import { resolveAppUrl } from "../appUrl";
import { clientPageId } from "./clientPageId";

export type ResumeDiagnosticEvent =
  | "boot.start"
  | "boot.complete"
  | "boot.failed"
  | "suspend"
  | "signal.focus"
  | "signal.online"
  | "signal.pageshow"
  | "signal.visibility"
  | "lifecycle.pageshow"
  | "lifecycle.pagehide"
  | "runtime.error"
  | "runtime.unhandledrejection"
  | "input.pointerdown"
  | "input.touchstart"
  | "input.click"
  | "render.updated"
  | "refresh.start"
  | "sockets.replaced"
  | "refresh.complete"
  | "refresh.failed"
  | ResumeDiagnosticStepEvent;

export type ResumeDiagnosticStep = "unread" | "session" | "machines" | "deletions" | "surface" | "topology";
type ResumeDiagnosticPhase = "start" | "complete" | "failed";
type ResumeDiagnosticStepEvent = `${ResumeDiagnosticStep}.${ResumeDiagnosticPhase}`;

const STEP_EVENTS: Record<ResumeDiagnosticStep, Record<ResumeDiagnosticPhase, ResumeDiagnosticStepEvent>> = {
  unread: { start: "unread.start", complete: "unread.complete", failed: "unread.failed" },
  session: { start: "session.start", complete: "session.complete", failed: "session.failed" },
  machines: { start: "machines.start", complete: "machines.complete", failed: "machines.failed" },
  deletions: { start: "deletions.start", complete: "deletions.complete", failed: "deletions.failed" },
  surface: { start: "surface.start", complete: "surface.complete", failed: "surface.failed" },
  topology: { start: "topology.start", complete: "topology.complete", failed: "topology.failed" },
};

export function resumeDiagnosticStepEvent(step: ResumeDiagnosticStep, phase: ResumeDiagnosticPhase): ResumeDiagnosticStepEvent {
  return STEP_EVENTS[step][phase];
}

export interface ResumeDiagnosticsDependencies {
  readonly send: (body: string) => void;
  readonly pageId: () => string;
  readonly now: () => number;
  readonly isVisible: () => boolean;
  readonly isOnline: () => boolean;
}

interface ResumeDiagnosticRecord {
  pageId: string;
  sequence: number;
  event: ResumeDiagnosticEvent;
  visible: boolean;
  online: boolean;
  elapsedMs: number;
  build: string;
}

const RESUME_DIAGNOSTIC_BATCH_DELAY_MS = 100;

/** Bundle marker so server logs prove whether a hung page runs the timeout fix. Bump on resume-path changes. */
export const RESUME_DIAGNOSTICS_BUILD = "20260904-resume-timeout";

/** Emits bounded, content-free resume breadcrumbs so an on-device iOS stall can be reconstructed from server logs. */
export class ResumeDiagnostics {
  private readonly startedAt: number;
  private sequence = 0;
  private enabled = false;
  private queued: ResumeDiagnosticRecord[] = [];
  private flushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  constructor(private readonly deps: ResumeDiagnosticsDependencies = browserResumeDiagnosticsDependencies()) {
    this.startedAt = deps.now();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  record(event: ResumeDiagnosticEvent): void {
    if (!this.enabled) return;
    this.sequence += 1;
    this.queued.push({
      pageId: this.deps.pageId(),
      sequence: this.sequence,
      event,
      visible: this.deps.isVisible(),
      online: this.deps.isOnline(),
      elapsedMs: Math.max(0, Math.round(this.deps.now() - this.startedAt)),
      build: RESUME_DIAGNOSTICS_BUILD,
    });
    if (event === "suspend") this.flush();
    else this.flushTimer ??= globalThis.setTimeout(() => { this.flush(); }, RESUME_DIAGNOSTIC_BATCH_DELAY_MS);
  }

  private flush(): void {
    if (this.flushTimer !== undefined) globalThis.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.queued.length === 0) return;
    const events = this.queued;
    this.queued = [];
    this.deps.send(JSON.stringify({ events }));
  }
}

function browserResumeDiagnosticsDependencies(): ResumeDiagnosticsDependencies {
  const pageId = clientPageId();
  return {
    send: (body) => {
      void fetch(resolveAppUrl("api/client-diagnostics/resume"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => undefined);
    },
    pageId: () => pageId,
    now: () => performance.now(),
    isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
    isOnline: () => typeof navigator === "undefined" || navigator.onLine,
  };
}
