import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface DelegationHost {
  start(input: { prompt: string; cwd: string; name: string }): Promise<{ id: string; url: string }>;
  status(id: string): Promise<{ state: "running" | "completed" | "failed" | "stopped"; output?: string }>;
}

export interface DelegationResult {
  exitCode: number;
  output: string;
  truncated: boolean;
}

type DelegationContext = Pick<ExtensionContext, "cwd"> & {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile">;
};
type Progress = (message: string, type?: "info" | "warning" | "error") => void;

// Keep the public provider boundary structural: the dependency exports raw TS
// sources whose compiler settings differ from this host's settings.
interface ExternalJobHandle {
  providerJobId: string;
  state: "queued" | "running" | "completed" | "failed" | "stopped" | "blocked";
  handleUrl?: string;
}

interface ExternalJobProvider {
  name: string;
  start(input: { prompt: string; cwd: string; agent: string; sessionId?: string }): Promise<ExternalJobHandle>;
  status(id: string): Promise<ExternalJobHandle>;
  reattach(id: string): Promise<ExternalJobHandle>;
  result(id: string): Promise<ExternalJobHandle & { output?: string }>;
}

interface ExternalJobProviderModule {
  registerExternalJobProvider(provider: ExternalJobProvider): () => void;
}

function isProviderModule(value: unknown): value is ExternalJobProviderModule {
  return isRecord(value) && typeof value["registerExternalJobProvider"] === "function";
}

function isRegistration(value: unknown): value is { dispose(): void } {
  return isRecord(value) && typeof value["dispose"] === "function";
}

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";
// pi-subagents 0.65.1 ping.capabilities.events.asyncComplete.
const ASYNC_COMPLETE = "subagent:async-complete";
const OUTPUT_EVAL_CHARS = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function failure(message: string): DelegationResult {
  return { exitCode: 1, output: message, truncated: false };
}

function completionResult(event: Record<string, unknown>): DelegationResult {
  // result-watcher emits the persisted result payload, NOT an AgentToolResult:
  // top-level success/state/exitCode/summary and results[].output/error/truncated.
  const children = Array.isArray(event["results"]) ? event["results"].map(record).filter((child) => child !== undefined) : [];
  const unsuccessful = (row: Record<string, unknown>): boolean =>
    row["success"] === false || row["stopped"] === true || row["interrupted"] === true || row["timedOut"] === true
    || ["failed", "stopped", "paused", "partial"].includes(String(row["state"] ?? row["status"]))
    || (typeof row["exitCode"] === "number" && row["exitCode"] !== 0);
  const succeeded = event["success"] === true && !unsuccessful(event) && !children.some(unsuccessful);
  const output = children.map((child) => typeof child["output"] === "string" && child["output"] !== ""
    ? child["output"] : typeof child["error"] === "string" ? child["error"] : "").filter(Boolean).join("\n\n")
    || (typeof event["summary"] === "string" ? event["summary"] : typeof event["error"] === "string" ? event["error"] : "");
  return {
    exitCode: succeeded ? 0 : typeof event["exitCode"] === "number" && event["exitCode"] !== 0 ? event["exitCode"] : 1,
    output,
    truncated: event["truncated"] === true || children.some((child) => child["truncated"] === true) || output.length > OUTPUT_EVAL_CHARS,
  };
}

/** Call after the separately installed pi-subagents owner is ready; dispose on session shutdown. */
export async function createDelegation(
  pi: Pick<ExtensionAPI, "events">,
  ctx: DelegationContext,
  host: DelegationHost,
  roles: Record<string, string>,
  progress: Progress,
): Promise<{ dispatch(role: string, task: string): Promise<DelegationResult>; dispose(): void }> {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  const cwd = ctx.cwd;
  // A variable specifier prevents tsc from traversing third-party raw TS exports.
  // Import before acquiring registrations so an unavailable dependency leaks none.
  const providerSpecifier = "pi-subagents/external-job-provider";
  const providerModule: unknown = await import(providerSpecifier);
  if (!isProviderModule(providerModule)) throw new Error("pi-subagents external-job-provider API is unavailable.");
  // The provider registry is process-global. Include both session identity and
  // instance identity so overlapping reloads cannot redirect existing jobs.
  const scope = `${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}-${randomUUID()}`;
  const providerName = `autostudio-${scope}`;
  const agents = new Map<string, string>();
  const agentRoles = new Map<string, string>();
  const registrations: { dispose(): void }[] = [];
  const pending = new Set<() => void>();
  let disposed = false;

  const report: Progress = (message, type) => {
    try {
      progress(message, type);
    } catch (error) {
      // Presentation is not execution: never lose a real host handle or cleanup
      // because a UI has disconnected. Keep observer failures diagnosable.
      console.error("Autostudio progress callback failed:", error);
    }
  };
  const ensureActive = (): void => {
    if (disposed) throw new Error("Autostudio delegation is disposed.");
  };
  const status = async (id: string): Promise<ExternalJobHandle> => {
    ensureActive();
    const result = await host.status(id);
    return { providerJobId: id, state: result.state };
  };
  const unregisterProvider = providerModule.registerExternalJobProvider({
    name: providerName,
    async start(input) {
      ensureActive();
      if (input.sessionId !== undefined && input.sessionId !== sessionId && input.sessionId !== sessionFile) {
        throw new Error("External job belongs to a different Autostudio session.");
      }
      const role = agentRoles.get(input.agent);
      if (role === undefined) throw new Error("Unknown Autostudio runtime agent.");
      // pi-subagents composes the registered system prompt and task for us.
      const started = await host.start({ prompt: input.prompt, cwd: input.cwd, name: `Autostudio ${role}` });
      report(`Autostudio: ${role} started — [Open session](<${started.url}>)`, "info");
      return { providerJobId: started.id, state: "running", handleUrl: started.url };
    },
    status,
    reattach: status,
    async result(id) {
      ensureActive();
      const result = await host.status(id);
      // The public provider validator requires nonempty, trimmed output (<=1 MiB).
      // Let oversized reports fail explicitly rather than silently losing evidence.
      const output = result.output?.trim();
      return { providerJobId: id, state: result.state, ...(output !== undefined && output !== "" ? { output } : {}) };
    },
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const cancel of pending) cancel();
    for (const registration of registrations) registration.dispose();
    unregisterProvider();
    // Host sessions remain host-owned; disposing this waiter is not cancellation.
  }

  try {
    for (const [index, [role, systemPrompt]] of Object.entries(roles).entries()) {
      const name = `autostudio-${scope}-${String(index)}`;
      // Documented synchronous registration event: the installed owner writes
      // result before emit returns. Do not load a second agent registry/owner.
      const request: { version: 1; name: string; definition: Record<string, unknown>; result?: unknown } = {
        version: 1,
        name,
        definition: {
          description: `Autostudio ${role}`,
          systemPrompt: systemPrompt.trim(),
          defaultContext: "fresh",
          defaultAsync: true,
          runner: { type: "external-job", provider: providerName },
        },
      };
      pi.events.emit("pi-subagents:runtime-agent-register:v1", request);
      if (request.result === undefined) throw new Error("pi-subagents is not installed or not ready for runtime agent registration.");
      const result = record(request.result);
      if (result?.["ok"] === false && result["error"] instanceof Error) throw result["error"];
      if (result?.["ok"] !== true || !isRegistration(result["registration"])) {
        throw new Error("pi-subagents returned a malformed runtime agent registration result.");
      }
      registrations.push(result["registration"]);
      agents.set(role, name);
      agentRoles.set(name, role);
    }
  } catch (error) {
    dispose();
    throw error;
  }

  function dispatch(role: string, task: string): Promise<DelegationResult> {
    if (disposed) return Promise.resolve(failure("Autostudio delegation is disposed."));
    const agent = agents.get(role);
    if (agent === undefined) return Promise.resolve(failure(`Unknown Autostudio role: ${role}`));
    const requestId = randomUUID();
    return new Promise((resolve) => {
      let settled = false;
      let runId: string | undefined;
      const early = new Map<string, Record<string, unknown>>();
      let unsubscribeReply = (): void => { /* No subscription yet. */ };
      let unsubscribeCompletion = (): void => { /* No subscription yet. */ };
      const finish = (result: DelegationResult, state: string): void => {
        if (settled) return;
        settled = true;
        unsubscribeReply();
        unsubscribeCompletion();
        early.clear();
        pending.delete(cancel);
        resolve(result);
        report(`Autostudio: ${role} ${state} (exit ${String(result.exitCode)}).`, result.exitCode === 0 ? "info" : "warning");
      };
      const complete = (event: Record<string, unknown>): void => {
        const result = completionResult(event);
        const stopped = event["state"] === "stopped" || event["stopped"] === true;
        finish(result, stopped ? "stopped" : result.exitCode === 0 ? "completed" : "failed");
      };
      const cancel = (): void => {
        finish(failure("Delegation disposed; the host session may still be running."), "wait disposed");
      };
      pending.add(cancel);
      unsubscribeCompletion = pi.events.on(ASYNC_COMPLETE, (payload) => {
        const event = record(payload);
        if (!event || (event["sessionId"] !== sessionId && (sessionFile === undefined || event["sessionId"] !== sessionFile))) return;
        const id = event["runId"] ?? event["id"];
        if (typeof id !== "string") return;
        if (runId === id) complete(event);
        // Subscribe before spawn: a fast job can finish before the RPC reply.
        else if (runId === undefined && event["agent"] === agent) early.set(id, event);
      });
      unsubscribeReply = pi.events.on(`${RPC_REPLY}${requestId}`, (payload) => {
        const reply = record(payload);
        if (reply?.["version"] !== 1 || reply["requestId"] !== requestId) return;
        unsubscribeReply();
        const data = record(reply["data"]);
        if (reply["success"] !== true || data?.["isError"] === true) {
          const error = record(reply["error"]);
          const message = error?.["message"] ?? data?.["text"];
          finish(failure(`Subagent spawn failed: ${typeof message === "string" ? message : "invalid RPC reply"}`), "failed");
          return;
        }
        const details = record(data?.["details"]);
        const id = details?.["asyncId"];
        if (typeof id !== "string" || id === "") {
          finish(failure("Subagent spawn did not return details.asyncId."), "failed");
          return;
        }
        runId = id;
        const completed = early.get(id);
        early.clear();
        if (completed) complete(completed);
      });
      try {
        pi.events.emit(RPC_REQUEST, {
          version: 1,
          requestId,
          method: "spawn",
          params: { agent, task, cwd, context: "fresh", async: true },
        });
      } catch (error) {
        finish(failure(`Subagent spawn failed: ${error instanceof Error ? error.message : String(error)}`), "failed");
      }
    });
  }

  return { dispatch, dispose };
}
