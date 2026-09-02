import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { piWebDataDir } from "../../config.js";

/** A stored Web Push subscription, owned by one browser/PWA instance and its current session target. */
export interface PushSubscriptionRecord {
  readonly endpoint: string;
  readonly expirationTime?: number | null;
  readonly keys: Readonly<Record<string, string>>;
  /** Stable browser/PWA-storage-partition id; endpoint reuse updates this record's target. */
  readonly instanceId: string;
  readonly sessionId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly workspaceId?: string | undefined;
  /** True only while that PWA is visibly showing its mapped target. */
  readonly foreground: boolean;
}

interface PushSubscriptionsFile { version: number; subscriptions: unknown[]; }

export const PUSH_SUBSCRIPTION_FILE_VERSION = 2 as const;
const MAX_STORED_SUBSCRIPTIONS = 256;

export interface PushSubscriptionStoreOptions {
  onPersistenceError?: ((operation: "load" | "save", error: unknown) => void) | undefined;
}

/** Durable endpoint store. Endpoint updates replace the mapping, allowing one PWA to follow a session switch. */
export class PushSubscriptionStore {
  private readonly subscriptions = new Map<string, PushSubscriptionRecord>();
  private readonly pendingSaves = new Set<Promise<void>>();
  private saveTail: Promise<void> = Promise.resolve();
  private readonly onPersistenceError: (operation: "load" | "save", error: unknown) => void;

  constructor(readonly filePath: string, options: PushSubscriptionStoreOptions = {}) {
    this.onPersistenceError = options.onPersistenceError ?? (() => undefined);
  }

  async load(): Promise<void> {
    let source: string;
    try { source = await readFile(this.filePath, "utf8"); }
    catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      this.reportPersistenceError("load", error); throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(source); }
    catch (error) {
      this.reportPersistenceError("load", error);
      throw new Error(`PI WEB push subscription store is not valid JSON: ${this.filePath}`, { cause: error });
    }
    if (!isValidFile(parsed)) {
      const error = new Error(`PI WEB push subscription store is not a valid push subscriptions file: ${this.filePath}`);
      this.reportPersistenceError("load", error); throw error;
    }
    this.subscriptions.clear();
    for (const candidate of parsed.subscriptions) {
      const record = parseStoredSubscription(candidate);
      if (record !== undefined && !this.subscriptions.has(record.endpoint)) this.subscriptions.set(record.endpoint, record);
    }
  }

  async save(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid.toString()}-${randomUUID()}.tmp`;
      try {
        await writeFile(tempPath, `${JSON.stringify({ version: PUSH_SUBSCRIPTION_FILE_VERSION, subscriptions: [...this.subscriptions.values()] } satisfies PushSubscriptionsFile, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await rename(tempPath, this.filePath);
      } finally { await rm(tempPath, { force: true }).catch(() => undefined); }
    } catch (error) { this.reportPersistenceError("save", error); }
  }

  list(): readonly PushSubscriptionRecord[] { return [...this.subscriptions.values()]; }
  get size(): number { return this.subscriptions.size; }
  async flush(): Promise<void> { while (this.pendingSaves.size > 0) await Promise.all([...this.pendingSaves]); }

  /** Adds a new endpoint, or atomically replaces an existing endpoint's PWA/session mapping. */
  add(subscription: PushSubscriptionRecord): "added" | "updated" | "duplicate" | "full" {
    const existing = this.subscriptions.get(subscription.endpoint);
    if (existing !== undefined) {
      if (sameSubscription(existing, subscription)) return "duplicate";
      this.subscriptions.set(subscription.endpoint, subscription); this.trackSave(); return "updated";
    }
    if (this.size >= MAX_STORED_SUBSCRIPTIONS) return "full";
    this.subscriptions.set(subscription.endpoint, subscription); this.trackSave(); return "added";
  }

  remove(endpoint: string): boolean { const removed = this.subscriptions.delete(endpoint); if (removed) this.trackSave(); return removed; }

  private trackSave(): void {
    const pending = this.saveTail.then(() => this.save()); this.saveTail = pending; this.pendingSaves.add(pending);
    void pending.finally(() => { this.pendingSaves.delete(pending); });
  }
  private reportPersistenceError(operation: "load" | "save", error: unknown): void {
    try { this.onPersistenceError(operation, error); }
    catch { return; }
  }
}

export function defaultPushSubscriptionFilePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string { return join(piWebDataDir(env, cwd), "push-subscriptions.json"); }

function sameSubscription(left: PushSubscriptionRecord, right: PushSubscriptionRecord): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function isNodeError(value: unknown): value is NodeJS.ErrnoException { return typeof value === "object" && value !== null && "code" in value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isValidFile(value: unknown): value is PushSubscriptionsFile { return isRecord(value) && value["version"] === PUSH_SUBSCRIPTION_FILE_VERSION && Array.isArray(value["subscriptions"]); }
function parseStoredSubscription(value: unknown): PushSubscriptionRecord | undefined {
  if (!isRecord(value) || typeof value["endpoint"] !== "string" || value["endpoint"] === "") return undefined;
  const keys = parseKeys(value["keys"]); const instanceId = requiredString(value["instanceId"]);
  if (keys === undefined || instanceId === undefined || typeof value["foreground"] !== "boolean") return undefined;
  const sessionId = optionalString(value["sessionId"]); const projectId = optionalString(value["projectId"]); const workspaceId = optionalString(value["workspaceId"]);
  return { endpoint: value["endpoint"], ...(value["expirationTime"] === null || typeof value["expirationTime"] === "number" && Number.isFinite(value["expirationTime"]) ? { expirationTime: value["expirationTime"] } : {}), keys, instanceId, ...(sessionId === undefined ? {} : { sessionId }), ...(projectId === undefined ? {} : { projectId }), ...(workspaceId === undefined ? {} : { workspaceId }), foreground: value["foreground"] };
}
function parseKeys(value: unknown): Readonly<Record<string, string>> | undefined { if (!isRecord(value)) return undefined; const result: Record<string, string> = {}; for (const [key, item] of Object.entries(value)) { if (typeof item !== "string") return undefined; result[key] = item; } return typeof result["p256dh"] === "string" && result["p256dh"] !== "" && typeof result["auth"] === "string" && result["auth"] !== "" ? result : undefined; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value !== "" && value.length <= 512 ? value : undefined; }
function requiredString(value: unknown): string | undefined { return optionalString(value); }
