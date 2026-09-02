import { resolveAppUrl } from "../appUrl";

export type ResumeDiagnosticEvent =
  | "suspend"
  | "signal.focus"
  | "signal.online"
  | "signal.pageshow"
  | "signal.visibility"
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

/** Emits bounded, content-free resume breadcrumbs so an on-device iOS stall can be reconstructed from server logs. */
export class ResumeDiagnostics {
  private readonly startedAt: number;
  private sequence = 0;
  private enabled = false;

  constructor(private readonly deps: ResumeDiagnosticsDependencies = browserResumeDiagnosticsDependencies()) {
    this.startedAt = deps.now();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  record(event: ResumeDiagnosticEvent): void {
    if (!this.enabled) return;
    this.sequence += 1;
    this.deps.send(JSON.stringify({
      pageId: this.deps.pageId(),
      sequence: this.sequence,
      event,
      visible: this.deps.isVisible(),
      online: this.deps.isOnline(),
      elapsedMs: Math.max(0, Math.round(this.deps.now() - this.startedAt)),
    }));
  }
}

function browserResumeDiagnosticsDependencies(): ResumeDiagnosticsDependencies {
  const pageId = browserDiagnosticPageId();
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

function browserDiagnosticPageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID().replaceAll("-", "");
  return Math.random().toString(36).slice(2).padEnd(8, "0");
}
