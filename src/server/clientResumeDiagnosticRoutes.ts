import type { FastifyInstance } from "fastify";

const EVENT_RECORD = {
  suspend: true,
  "signal.focus": true,
  "signal.online": true,
  "signal.pageshow": true,
  "signal.visibility": true,
  "refresh.start": true,
  "sockets.replaced": true,
  "unread.start": true,
  "unread.complete": true,
  "unread.failed": true,
  "session.start": true,
  "session.complete": true,
  "session.failed": true,
  "machines.start": true,
  "machines.complete": true,
  "machines.failed": true,
  "deletions.start": true,
  "deletions.complete": true,
  "deletions.failed": true,
  "surface.start": true,
  "surface.complete": true,
  "surface.failed": true,
  "topology.start": true,
  "topology.complete": true,
  "topology.failed": true,
  "refresh.complete": true,
  "refresh.failed": true,
} as const;

type ResumeEvent = keyof typeof EVENT_RECORD;

interface ClientResumeDiagnostic {
  pageId: string;
  sequence: number;
  event: ResumeEvent;
  visible: boolean;
  online: boolean;
  elapsedMs: number;
}

/** Accept deliberately small, content-free iOS PWA resume breadcrumbs for journal inspection. */
export function registerClientResumeDiagnosticRoutes(app: FastifyInstance): void {
  app.post<{ Body: unknown }>("/api/client-diagnostics/resume", async (request, reply) => {
    const diagnostic = parseClientResumeDiagnostic(request.body);
    if (diagnostic === undefined) return reply.code(400).send({ error: "Invalid client resume diagnostic" });
    request.log.info({ clientResume: diagnostic }, "client resume diagnostic");
    return reply.code(202).send({ accepted: true });
  });
}

export function parseClientResumeDiagnostic(value: unknown): ClientResumeDiagnostic | undefined {
  if (!isRecord(value)) return undefined;
  const pageId = value["pageId"];
  const sequence = value["sequence"];
  const event = value["event"];
  const visible = value["visible"];
  const online = value["online"];
  const elapsedMs = value["elapsedMs"];
  if (typeof pageId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(pageId)) return undefined;
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1 || sequence > 10_000) return undefined;
  if (!isResumeEvent(event)) return undefined;
  if (typeof visible !== "boolean" || typeof online !== "boolean") return undefined;
  if (typeof elapsedMs !== "number" || !Number.isInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 86_400_000) return undefined;
  return { pageId, sequence, event, visible, online, elapsedMs };
}

function isResumeEvent(value: unknown): value is ResumeEvent {
  return typeof value === "string" && Object.hasOwn(EVENT_RECORD, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
