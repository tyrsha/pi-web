import { pushApi } from "./api/clients";

export interface PushSubscriptionTarget {
  readonly sessionId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly foreground: boolean;
}

export interface PushSubscriptionRegistration extends PushSubscriptionJSON, PushSubscriptionTarget {
  readonly instanceId: string;
}

export interface PushManagerLike {
  getSubscription(): Promise<{ toJSON(): PushSubscriptionJSON } | null>;
}

export interface ServiceWorkerRegistrationLike {
  readonly pushManager: PushManagerLike;
}

export interface PushSubscriptionBindingDependencies {
  readonly getRegistration: () => Promise<ServiceWorkerRegistrationLike | undefined>;
  readonly subscribe: (subscription: PushSubscriptionRegistration) => Promise<unknown>;
  readonly instanceId: () => string;
  readonly isEnabled: () => boolean;
  readonly onError?: (error: unknown) => void;
}

const PUSH_INSTANCE_ID_KEY = "pi-web.push.instance-id";
const PUSH_SUBSCRIPTION_ENABLED_KEY = "pi-web.push.subscription-enabled";

type PushStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** One stable identifier per browser/PWA storage partition. Installed iOS PWAs have their own storage, so each installation gets its own id. */
export function pwaPushInstanceId(storage: Pick<Storage, "getItem" | "setItem"> = localStorage, randomId: () => string = () => crypto.randomUUID()): string {
  const existing = storage.getItem(PUSH_INSTANCE_ID_KEY);
  if (existing !== null && existing !== "") return existing;
  const instanceId = randomId();
  storage.setItem(PUSH_INSTANCE_ID_KEY, instanceId);
  return instanceId;
}

/** Persist the user's explicit local choice, so a disabled PWA never probes Web Push APIs on resume. */
export function setPwaPushSubscriptionEnabled(enabled: boolean, storage?: PushStorage): void {
  const target = storage ?? browserPushStorage();
  if (target === undefined) return;
  if (enabled) target.setItem(PUSH_SUBSCRIPTION_ENABLED_KEY, "true");
  else target.removeItem(PUSH_SUBSCRIPTION_ENABLED_KEY);
}

export function isPwaPushSubscriptionEnabled(storage?: Pick<Storage, "getItem">): boolean {
  return (storage ?? browserPushStorage())?.getItem(PUSH_SUBSCRIPTION_ENABLED_KEY) === "true";
}

function browserPushStorage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export function pushSubscriptionRegistration(subscription: PushSubscriptionJSON, instanceId: string, target: PushSubscriptionTarget): PushSubscriptionRegistration {
  return {
    ...subscription,
    instanceId,
    foreground: target.foreground,
    ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }),
    ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
    ...(target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId }),
  };
}

/**
 * Keeps an existing browser subscription mapped to this PWA's current session.
 * Calls are coalesced and serialized: a slow earlier request may briefly reach the daemon, but
 * the newest target is always sent afterwards, so a session switch cannot leave a stale mapping.
 */
export class PushSubscriptionBinding {
  private desired: PushSubscriptionTarget | undefined;
  private lastSentKey: string | undefined;
  private draining = false;
  private enabled: boolean;
  private readonly onError: (error: unknown) => void;

  constructor(private readonly deps: PushSubscriptionBindingDependencies = browserBindingDependencies()) {
    this.enabled = deps.isEnabled();
    this.onError = deps.onError ?? (() => undefined);
  }

  sync(target: PushSubscriptionTarget): void {
    this.desired = target;
    if (this.enabled && !this.draining) void this.drain();
  }

  /** Enables mapping only after an explicit successful subscription; disabling avoids all Web Push API work. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.lastSentKey = undefined;
    if (enabled && this.desired !== undefined && !this.draining) void this.drain();
  }

  /** Call after enable only, so an existing endpoint is re-read instead of trusting stale local state. */
  invalidate(): void {
    this.lastSentKey = undefined;
    if (this.enabled && this.desired !== undefined && !this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.enabled && this.desired !== undefined) {
        const target = this.desired;
        const targetKey = JSON.stringify(target);
        if (targetKey === this.lastSentKey) break;
        try {
          const registration = await this.deps.getRegistration();
          if (!this.isEnabled()) return;
          const subscription = registration === undefined ? null : await registration.pushManager.getSubscription();
          if (!this.isEnabled()) return;
          if (subscription === null) {
            this.lastSentKey = targetKey;
            continue;
          }
          await this.deps.subscribe(pushSubscriptionRegistration(subscription.toJSON(), this.deps.instanceId(), target));
          if (targetKey === JSON.stringify(this.desired)) this.lastSentKey = targetKey;
        } catch (error) {
          this.onError(error);
          break;
        }
      }
    } finally {
      this.draining = false;
      // The loop already consumes target changes after successful requests. On
      // failure, wait for the next sync/enable/invalidate signal instead of
      // recursively retrying: immediately rejected browser APIs can otherwise
      // create an endless microtask chain that starves rendering and input.
    }
  }

  private isEnabled(): boolean {
    return this.enabled;
  }
}

function browserBindingDependencies(): PushSubscriptionBindingDependencies {
  return {
    getRegistration: async () => "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() ?? undefined : undefined,
    subscribe: (subscription) => pushApi.subscribe(subscription),
    instanceId: () => pwaPushInstanceId(),
    isEnabled: () => isPwaPushSubscriptionEnabled(),
    onError: (error) => { console.warn("Failed to synchronize PWA push subscription", error); },
  };
}
