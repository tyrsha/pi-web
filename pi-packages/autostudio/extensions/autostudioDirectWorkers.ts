import { isAbsolute } from "node:path";
import { createSessionHost, type DaemonRequest } from "./autostudioSessions.js";

export const DIRECT_WORKER_PROVIDER = "autostudio-pi-web";

interface StartInput {
  prompt: string;
  cwd: string;
  agent: string;
  sessionId?: string;
  options: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function selectedModel(options: Record<string, unknown>): { provider: string; id: string } | undefined {
  if (Object.keys(options).some((key) => key !== "model")) throw new Error("Tracked worker options support only model");
  const model = options["model"];
  if (model === undefined) return undefined;
  if (typeof model !== "string" || model.trim() !== model || model.indexOf("/") <= 0 || model.endsWith("/")) {
    throw new Error("Tracked worker model must be provider/model-id");
  }
  const separator = model.indexOf("/");
  return { provider: model.slice(0, separator), id: model.slice(separator + 1) };
}

// pi-subagents persists this opaque handle. No session map, custom polling or
// private session-file reads are needed to reattach after an extension reload.
function jobId(id: string, cwd: string): string {
  const value = JSON.stringify([id, cwd]);
  if (value.length > 256) throw new Error("Worker workspace exceeds the external-job handle limit");
  return value;
}

function jobReference(value: string): { id: string; cwd: string } {
  const parts: unknown = JSON.parse(value);
  if (!Array.isArray(parts) || parts.length !== 2 || typeof parts[0] !== "string" || parts[0] === ""
    || typeof parts[1] !== "string" || !isAbsolute(parts[1])) throw new Error("Invalid tracked worker handle");
  return { id: parts[0], cwd: parts[1] };
}

/** Process-scoped, stateless provider for configured agents used by subagent/runs.run. */
export function createDirectWorkerProvider(request: DaemonRequest) {
  const result = async (providerJobId: string) => {
    const { id, cwd } = jobReference(providerJobId);
    const state = await createSessionHost(request, cwd, id).status(id);
    const output = state.output?.trim();
    return { providerJobId, state: state.state, ...(output !== undefined && output !== "" ? { output } : {}) };
  };
  const status = async (providerJobId: string) => {
    const current = await result(providerJobId);
    return { providerJobId, state: current.state };
  };
  return {
    name: DIRECT_WORKER_PROVIDER,
    async start(input: StartInput) {
      if (input.sessionId === undefined || input.sessionId === "") throw new Error("Tracked workers require the originating Pi session identity");
      if (!isAbsolute(input.cwd)) throw new Error("Tracked workers require an absolute workspace");
      // Preflight the daemon's UUID-sized handle before creating a child.
      jobId("0".repeat(36), input.cwd);
      const model = selectedModel(input.options);
      const sessions = await request("GET", `/sessions?${new URLSearchParams({ cwd: input.cwd }).toString()}`);
      if (!Array.isArray(sessions)) throw new Error("Pi Web returned an invalid session listing");
      // pi-subagents may supply the session file instead of its UUID. Resolve
      // both through the daemon's public listing, never filename heuristics.
      const parent: unknown = sessions.find((row: unknown) => isRecord(row) && (row["id"] === input.sessionId || row["path"] === input.sessionId));
      if (!isRecord(parent) || typeof parent["id"] !== "string" || parent["cwd"] !== input.cwd) {
        throw new Error("Originating session is not in the worker workspace; refusing independent execution");
      }
      const host = createSessionHost(request, input.cwd, parent["id"], model);
      const name = input.agent.startsWith("autostudio-") ? `Autostudio ${input.agent.slice(11)}` : `Autostudio ${input.agent}`;
      const child = await host.start({ prompt: input.prompt, cwd: input.cwd, name });
      return { providerJobId: jobId(child.id, input.cwd), state: "running" as const, handleUrl: child.url, conversationUrl: child.url };
    },
    status,
    reattach: status,
    result,
  };
}
