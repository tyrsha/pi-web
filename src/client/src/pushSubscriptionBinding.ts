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
  readonly onError?: (error: unknown) => void;
}

const PUSH_INSTANCE_ID_KEY = "pi-web.push.instance-id";

/** One stable identifier per browser/PWA storage partition. Installed iOS PWAs have their own storage, so each installation gets its own id. */
export function pwaPushInstanceId(storage: Pick<Storage, "getItem" | "setItem"> = localStorage, randomId: () => string = () => crypto.randomUUID()): string {
  const existing = storage.getItem(PUSH_INSTANCE_ID_KEY);
  if (existing !== null && existing !== "") return existing;
  const instanceId = randomId();
  storage.setItem(PUSH_INSTANCE_ID_KEY, instanceId);
  return instanceId;
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
  private readonly onError: (error: unknown) => void;

  constructor(private readonly deps: PushSubscriptionBindingDependencies = browserBindingDependencies()) {
    this.onError = deps.onError ?? (() => undefined);
  }

  sync(target: PushSubscriptionTarget): void {
    this.desired = target;
    if (!this.draining) void this.drain();
  }

  /** Call after an enable/disable operation so an existing endpoint is re-read instead of trusting stale local state. */
  invalidate(): void {
    this.lastSentKey = undefined;
    if (this.desired !== undefined && !this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.desired !== undefined) {
        const target = this.desired;
        const targetKey = JSON.stringify(target);
        if (targetKey === this.lastSentKey) break;
        try {
          const registration = await this.deps.getRegistration();
          const subscription = registration === undefined ? null : await registration.pushManager.getSubscription();
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
      if (this.desired !== undefined && JSON.stringify(this.desired) !== this.lastSentKey) void this.drain();
    }
  }
}

function browserBindingDependencies(): PushSubscriptionBindingDependencies {
  return {
    getRegistration: async () => "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() ?? undefined : undefined,
    subscribe: (subscription) => pushApi.subscribe(subscription),
    instanceId: () => pwaPushInstanceId(),
  };
}
