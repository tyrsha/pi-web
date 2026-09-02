import type { SessionUiEvent } from "../../shared/apiTypes.js";
import type { PushSubscriptionStore, PushSubscriptionRecord } from "./pushSubscriptionStore.js";

export interface PushNotificationMessage { readonly title: string; readonly body: string; readonly kind: "message" | "error" | "input" | "stopped"; }
export type PushSender = (subscription: Pick<PushSubscriptionRecord, "endpoint"> & { expirationTime?: number | null; keys: Readonly<Record<string, string>> }, payload: string) => Promise<void>;
export interface PushEventSource { subscribe(listener: (sessionId: string, event: SessionUiEvent) => void): () => void; }
const PUSH_NOTIFICATION_TITLE = "PI WEB";
export const PUSH_NOTIFICATION_BODY_MAX_CHARS = 200;
export const DEFAULT_PUSH_COOLDOWN_MS = 30_000;
/** A queued follow-up prompt ends one run immediately before starting the next; wait before calling it stopped. */
export const STOPPED_NOTIFICATION_DELAY_MS = 1_000;
export interface SessionDeepLinkTarget { readonly projectId: string; readonly workspaceId: string; }
export interface WebPushNotifierOptions {
  readonly subscriptions: Pick<PushSubscriptionStore, "list" | "remove">;
  readonly cooldownMs?: number | undefined;
  readonly completionDelayMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly onError?: ((message: string) => void) | undefined;
  readonly resolveCwd?: ((sessionId: string) => string | undefined) | undefined;
  readonly resolveDeepLink?: ((cwd: string) => Promise<SessionDeepLinkTarget | undefined> | SessionDeepLinkTarget | undefined) | undefined;
}

/** Delivers only to background PWA instances currently mapped to the emitting session. */
export class WebPushNotifier {
  private readonly cooldownMs: number;
  private readonly completionDelayMs: number;
  private readonly now: () => number;
  private readonly onError: (message: string) => void;
  private readonly lastSentAt = new Map<string, number>();
  /** A session can emit repeated terminal events while a run settles; notify once until the next run starts. */
  private readonly stoppedSessions = new Set<string>();
  private readonly pendingCompletionNotifications = new Map<string, ReturnType<typeof setTimeout>>();
  /** An agent may end several assistant messages around tool calls; only its last visible result is notify-worthy. */
  private readonly lastAssistantMessages = new Map<string, PushNotificationMessage>();

  constructor(readonly send: PushSender, private readonly options: WebPushNotifierOptions) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_PUSH_COOLDOWN_MS;
    this.completionDelayMs = options.completionDelayMs ?? STOPPED_NOTIFICATION_DELAY_MS;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
  }
  subscribeToEvents(source: PushEventSource): () => void { return source.subscribe((sessionId, event) => { this.onSessionEvent(sessionId, event); }); }
  onSessionEvent(sessionId: string, event: SessionUiEvent): void {
    if (event.type === "agent.start") {
      this.stoppedSessions.delete(sessionId);
      this.lastAssistantMessages.delete(sessionId);
      this.cancelPendingCompletionNotification(sessionId);
      return;
    }
    if (event.type === "agent.end") {
      this.scheduleCompletionNotification(sessionId);
      return;
    }

    const message = pushMessageForSessionEvent(event);
    if (message === undefined) return;
    if (message.kind === "message") {
      this.lastAssistantMessages.set(sessionId, message);
      return;
    }
    this.deliverIfAllowed(message, sessionId);
  }
  private scheduleCompletionNotification(sessionId: string): void {
    if (this.stoppedSessions.has(sessionId)) return;
    this.stoppedSessions.add(sessionId);
    const message = this.lastAssistantMessages.get(sessionId) ?? { title: PUSH_NOTIFICATION_TITLE, body: "Agent stopped", kind: "stopped" } satisfies PushNotificationMessage;
    this.lastAssistantMessages.delete(sessionId);
    this.pendingCompletionNotifications.set(sessionId, setTimeout(() => {
      this.pendingCompletionNotifications.delete(sessionId);
      this.deliverIfAllowed(message, sessionId);
    }, this.completionDelayMs));
  }

  private cancelPendingCompletionNotification(sessionId: string): void {
    const timer = this.pendingCompletionNotifications.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pendingCompletionNotifications.delete(sessionId);
  }

  private deliverIfAllowed(message: PushNotificationMessage, sessionId: string): void {
    // Input waits must not be suppressed by an immediately preceding completion; throttle independently by kind.
    const key = `${sessionId}\u0000${message.kind}`;
    const now = this.now();
    if (message.kind !== "stopped" && now - (this.lastSentAt.get(key) ?? Number.NEGATIVE_INFINITY) < this.cooldownMs) return;
    this.lastSentAt.set(key, now);
    void this.deliver(message, sessionId);
  }

  private async deliver(message: PushNotificationMessage, sessionId: string): Promise<void> {
    const cwd = this.options.resolveCwd?.(sessionId);
    let deepLink: SessionDeepLinkTarget | undefined;
    if (cwd !== undefined && this.options.resolveDeepLink !== undefined) try { deepLink = await this.options.resolveDeepLink(cwd); } catch { deepLink = undefined; }
    const payload = JSON.stringify({ title: message.title, body: message.body, data: { kind: message.kind, sessionId, cwd, projectId: deepLink?.projectId, workspaceId: deepLink?.workspaceId } });
    const subscriptions = this.options.subscriptions.list().filter((subscription) => subscription.sessionId === sessionId && !subscription.foreground);
    if (subscriptions.length === 0) return;
    const outcomes = await Promise.allSettled(subscriptions.map((subscription) => {
      try { return this.send(subscription, payload); }
      catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    }));
    let removedExpired = 0; let otherFailures = 0;
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status !== "rejected") continue;
      const status = statusCodeOf(outcome.reason); const subscription = subscriptions[index];
      if (status === 404 || status === 410) { if (subscription !== undefined) this.options.subscriptions.remove(subscription.endpoint); removedExpired += 1; } else otherFailures += 1;
    }
    if (removedExpired > 0) this.onError(`removed ${String(removedExpired)} expired push subscription(s)`);
    if (otherFailures > 0) this.onError(`web push delivery failed for ${String(otherFailures)} of ${String(subscriptions.length)} subscriptions`);
  }
}

export function pushMessageForSessionEvent(event: SessionUiEvent): PushNotificationMessage | undefined {
  if (event.type === "message.end") { const text = assistantTextOf(event.message); return text === undefined ? undefined : { title: PUSH_NOTIFICATION_TITLE, body: truncateForPush(text), kind: "message" }; }
  if (event.type === "session.error") return { title: PUSH_NOTIFICATION_TITLE, body: event.message.trim() === "" ? "Session error" : truncateForPush(event.message), kind: "error" };
  if (event.type === "agent.end") return { title: PUSH_NOTIFICATION_TITLE, body: "Agent stopped", kind: "stopped" };
  if (event.type === "ask.opened" || event.type === "dialog.opened") return { title: PUSH_NOTIFICATION_TITLE, body: "This session needs your input", kind: "input" };
  return undefined;
}
function assistantTextOf(message: unknown): string | undefined {
  if (!isRecord(message) || message["role"] !== "assistant" || !Array.isArray(message["content"])) return undefined;
  const parts: string[] = [];
  for (const part of message["content"]) {
    if (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string") parts.push(part["text"]);
  }
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}
export function truncateForPush(text: string, maxChars: number = PUSH_NOTIFICATION_BODY_MAX_CHARS): string { const normalized = text.replace(/\s+/g, " ").trim(); if (normalized.length <= maxChars) return normalized; const cut = normalized.slice(0, maxChars); const space = cut.lastIndexOf(" "); const end = space > Math.floor(maxChars / 2) ? space : maxChars; return `${normalized.slice(0, end).trimEnd()}…`; }
function statusCodeOf(reason: unknown): number | undefined { return isRecord(reason) && typeof reason["statusCode"] === "number" ? reason["statusCode"] : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
