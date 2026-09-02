import type { FastifyInstance } from "fastify";
import type { PushSubscriptionRecord } from "./pushSubscriptionStore.js";

export interface PushRouteDependencies {
  readonly configured: boolean;
  readonly publicKey?: string | undefined;
  readonly store: Pick<import("./pushSubscriptionStore.js").PushSubscriptionStore, "add" | "remove">;
}

export function registerPushRoutes(app: FastifyInstance, deps: PushRouteDependencies): void {
  app.get("/push/vapid-public-key", (_request, reply) => {
    if (!deps.configured || deps.publicKey === undefined) { reply.code(503); return { error: "Web push is not configured on this server" }; }
    return { publicKey: deps.publicKey };
  });
  app.post("/push/subscribe", (request, reply) => {
    if (!deps.configured) { reply.code(503); return { error: "Web push is not configured on this server" }; }
    const subscription = parsePushSubscriptionRecord(request.body);
    if (subscription === undefined) { reply.code(400); return { error: "Invalid push subscription payload" }; }
    if (deps.store.add(subscription) === "full") { reply.code(507); return { error: "Push subscription limit reached on this server; unsubscribe an old browser and retry" }; }
    return { accepted: true };
  });
  app.delete("/push/unsubscribe", (request) => {
    const endpoint = parsePushSubscriptionEndpoint(request.body);
    if (!deps.configured || endpoint === undefined) return { removed: false };
    return { removed: deps.store.remove(endpoint) };
  });
}

/** Subscription upserts require a PWA instance id; target fields describe that instance's currently selected session. */
export function parsePushSubscriptionRecord(value: unknown): PushSubscriptionRecord | undefined {
  if (!isRecord(value)) return undefined;
  const endpoint = parsePushSubscriptionEndpoint(value); const keys = parseKeys(value["keys"]); const instanceId = requiredId(value["instanceId"]);
  if (endpoint === undefined || keys === undefined || instanceId === undefined || typeof value["foreground"] !== "boolean") return undefined;
  const sessionId = optionalId(value["sessionId"]); const projectId = optionalId(value["projectId"]); const workspaceId = optionalId(value["workspaceId"]);
  return { endpoint, ...(value["expirationTime"] === null || typeof value["expirationTime"] === "number" && Number.isFinite(value["expirationTime"]) ? { expirationTime: value["expirationTime"] } : {}), keys, instanceId, ...(sessionId === undefined ? {} : { sessionId }), ...(projectId === undefined ? {} : { projectId }), ...(workspaceId === undefined ? {} : { workspaceId }), foreground: value["foreground"] };
}
function parsePushSubscriptionEndpoint(value: unknown): string | undefined { return isRecord(value) && typeof value["endpoint"] === "string" && value["endpoint"].startsWith("https://") ? value["endpoint"] : undefined; }
function parseKeys(value: unknown): Readonly<Record<string, string>> | undefined { if (!isRecord(value)) return undefined; const result: Record<string, string> = {}; for (const [key, item] of Object.entries(value)) { if (typeof item !== "string") return undefined; result[key] = item; } return typeof result["p256dh"] === "string" && result["p256dh"] !== "" && typeof result["auth"] === "string" && result["auth"] !== "" ? result : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function optionalId(value: unknown): string | undefined { return typeof value === "string" && value !== "" && value.length <= 512 ? value : undefined; }
function requiredId(value: unknown): string | undefined { return optionalId(value); }
