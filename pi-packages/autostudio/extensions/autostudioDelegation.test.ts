import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDelegation, type DelegationHost } from "./autostudioDelegation.js";

const RUNTIME_AGENT_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";
interface RuntimeAgentRegistrationRequest {
  version: 1;
  name: string;
  definition: { systemPrompt: string; runner: { type: "external-job"; provider: string } };
  result?: { ok: true; registration: { dispose(): void } } | { ok: false; error: Error };
}

interface ExternalJobHandle {
  providerJobId: string;
  state: string;
  handleUrl?: string;
  output?: string;
}
interface ExternalJobProvider {
  name: string;
  start(input: { prompt: string; promptDigest: string; cwd: string; runId: string; stepIndex: number; agent: string; options: Record<string, unknown>; sessionId?: string }): Promise<ExternalJobHandle>;
  status(id: string): Promise<ExternalJobHandle>;
  reattach(id: string): Promise<ExternalJobHandle>;
  result(id: string): Promise<ExternalJobHandle>;
}
interface ProviderInspection {
  getExternalJobProvider: (name: string) => ExternalJobProvider | undefined;
  listExternalJobProviders: () => readonly ExternalJobProvider[];
  validateExternalJobResult: (name: string, value: unknown) => ExternalJobHandle;
}
function assertProviderInspection(value: unknown): asserts value is ProviderInspection {
  if (value === null || typeof value !== "object"
    || !("getExternalJobProvider" in value) || typeof value.getExternalJobProvider !== "function"
    || !("listExternalJobProviders" in value) || typeof value.listExternalJobProviders !== "function"
    || !("validateExternalJobResult" in value) || typeof value.validateExternalJobResult !== "function") {
    throw new Error("Missing public external-job provider inspection API");
  }
}
// Exercise the installed registry and validators without importing their TS graph.
const providerSpecifier = "pi-subagents/external-job-provider";
const providerModule: unknown = await import(providerSpecifier);
assertProviderInspection(providerModule);
const { getExternalJobProvider, listExternalJobProviders, validateExternalJobResult } = providerModule;

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

interface SpawnRequest {
  version: 1;
  requestId: string;
  method: string;
  params: { agent: string; task: string; cwd: string; context: string; async: boolean };
}

function assertRegistration(value: unknown): asserts value is RuntimeAgentRegistrationRequest {
  if (value === null || typeof value !== "object" || !("version" in value) || value.version !== 1
    || !("name" in value) || typeof value.name !== "string" || !("definition" in value)) {
    throw new Error("Invalid registration request");
  }
}

function assertSpawn(value: unknown): asserts value is SpawnRequest {
  if (value === null || typeof value !== "object" || !("version" in value) || value.version !== 1
    || !("requestId" in value) || typeof value.requestId !== "string" || !("method" in value) || value.method !== "spawn"
    || !("params" in value) || value.params === null || typeof value.params !== "object" || !("agent" in value.params)) {
    throw new Error("Invalid spawn request");
  }
}

async function fixture(sessionId = "parent", roles = { worker: "Worker system prompt", reviewer: "Review independently" }) {
  const bus = new EventEmitter();
  const events: ExtensionAPI["events"] = {
    on(event, handler) {
      bus.on(event, handler);
      return () => { bus.off(event, handler); };
    },
    emit(event, payload) { bus.emit(event, payload); },
  };
  // Fake only the documented synchronous owner event; the provider registry
  // below remains the installed dependency's actual public implementation.
  const registrations: RuntimeAgentRegistrationRequest[] = [];
  events.on(RUNTIME_AGENT_REGISTER_EVENT, (payload) => {
    assertRegistration(payload);
    const request = payload;
    registrations.push(request);
    request.result = { ok: true, registration: { dispose: vi.fn() } };
  });
  const requests: SpawnRequest[] = [];
  events.on("subagents:rpc:v1:request", (payload) => {
    assertSpawn(payload);
    requests.push(payload);
  });
  const host = {
    start: vi.fn<DelegationHost["start"]>().mockResolvedValue({ id: `child-${sessionId}`, url: `https://pi.example/app/sessions/child-${sessionId}` }),
    status: vi.fn<DelegationHost["status"]>().mockResolvedValue({ state: "running" }),
  };
  const progress = vi.fn();
  const ctx = { cwd: "/workspace", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/sessions/${sessionId}.jsonl` } };
  const delegation = await createDelegation({ events }, ctx, host, roles, progress);
  disposers.push(() => { delegation.dispose(); });
  function provider(): ExternalJobProvider {
    const runner = registrations[0]?.definition.runner;
    if (runner?.type !== "external-job") throw new Error("Expected external-job registration");
    const result = getExternalJobProvider(runner.provider);
    if (!result) throw new Error("Missing registered provider");
    return result;
  }
  function reply(request: SpawnRequest, id: string, data: unknown = { details: { asyncId: id, runId: id }, text: "Started" }): void {
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data });
  }
  function complete(request: SpawnRequest, id: string, fields: Record<string, unknown> = {}): void {
    events.emit("subagent:async-complete", {
      id, runId: id, sessionId: ctx.sessionManager.getSessionFile(), agent: request.params.agent,
      success: true, state: "complete", exitCode: 0, summary: "short preview",
      results: [{ agent: request.params.agent, success: true, output: "Full verified report", truncated: false }],
      ...fields,
    });
  }
  function request(index = 0): SpawnRequest {
    const found = requests[index];
    if (!found) throw new Error("No spawn request");
    return found;
  }
  function agentName(): string {
    const name = registrations[0]?.name;
    if (name === undefined) throw new Error("Missing agent");
    return name;
  }
  return { delegation, ctx, events, bus, host, progress, registrations, requests, request, provider, reply, complete, agentName };
}

function startInput(f: Awaited<ReturnType<typeof fixture>>) {
  return { prompt: "Composed system prompt and task", promptDigest: "digest", cwd: "/workspace", runId: "run-1", stepIndex: 0, agent: f.agentName(), options: {}, sessionId: f.ctx.sessionManager.getSessionFile() };
}

describe("Autostudio delegation", () => {
  it("registers runtime external-job agents and delegates through async RPC, awaiting the exact completion", async () => {
    const f = await fixture();
    expect(f.registrations.map((registration) => registration.definition.systemPrompt)).toEqual(["Worker system prompt", "Review independently"]);
    const result = f.delegation.dispatch("worker", "Implement and verify");
    expect(f.request()).toMatchObject({ method: "spawn", params: { agent: f.agentName(), task: "Implement and verify", cwd: "/workspace", context: "fresh", async: true } });
    const settled = vi.fn();
    void result.then(settled);
    f.reply(f.request(), "run-1");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(f.host.status).not.toHaveBeenCalled();
    f.complete(f.request(), "run-1");
    await expect(result).resolves.toEqual({ exitCode: 0, output: "Full verified report", truncated: false });
    expect(f.progress).toHaveBeenLastCalledWith("Autostudio: worker completed (exit 0).", "info");
    expect(f.bus.listenerCount("subagent:async-complete")).toBe(0);
    expect(f.bus.listenerCount(`subagents:rpc:v1:reply:${f.request().requestId}`)).toBe(0);
  });

  it("wraps only the injected host and reports the real Markdown session URL", async () => {
    const f = await fixture();
    const provider = f.provider();
    await expect(provider.start(startInput(f))).resolves.toEqual({ providerJobId: "child-parent", state: "running", handleUrl: "https://pi.example/app/sessions/child-parent" });
    expect(f.host.start).toHaveBeenCalledExactlyOnceWith({ prompt: "Composed system prompt and task", cwd: "/workspace", name: "Autostudio worker" });
    expect(f.progress).toHaveBeenCalledExactlyOnceWith("Autostudio: worker started — [Open session](<https://pi.example/app/sessions/child-parent>)", "info");
    for (const state of ["running", "completed", "failed", "stopped"] as const) {
      f.host.status.mockResolvedValue({ state, output: "  report\n" });
      await expect(provider.status("child-parent")).resolves.toEqual({ providerJobId: "child-parent", state });
      await expect(provider.reattach("child-parent")).resolves.toEqual({ providerJobId: "child-parent", state });
      expect(validateExternalJobResult(provider.name, await provider.result("child-parent"))).toEqual({ providerJobId: "child-parent", state, output: "report" });
    }
    f.host.status.mockResolvedValue({ state: "completed", output: "\n" });
    expect(validateExternalJobResult(provider.name, await provider.result("child-parent"))).toEqual({ providerJobId: "child-parent", state: "completed" });
    expect(f.host.start).toHaveBeenCalledTimes(1);
  });

  it("propagates host errors without inventing a handle or retrying start", async () => {
    const f = await fixture();
    f.host.start.mockRejectedValue(new Error("host unavailable"));
    await expect(f.provider().start(startInput(f))).rejects.toThrow("host unavailable");
    expect(f.progress).not.toHaveBeenCalled();
    f.host.status.mockRejectedValue(new Error("session missing"));
    await expect(f.provider().result("missing")).rejects.toThrow("session missing");
    await expect(f.provider().reattach("missing")).rejects.toThrow("session missing");
    expect(f.host.start).toHaveBeenCalledTimes(1);
  });

  it("handles completion before acknowledgement and ignores other runs and sessions", async () => {
    const f = await fixture();
    const first = f.delegation.dispatch("worker", "first");
    const second = f.delegation.dispatch("worker", "second");
    f.complete(f.request(), "run-1", { sessionId: "another-session", summary: "foreign" });
    f.complete(f.request(), "unrelated");
    f.complete(f.request(1), "run-2", { results: [{ success: true, output: "second" }] });
    f.complete(f.request(), "run-1", { results: [{ success: true, output: "first" }] });
    f.reply(f.request(1), "run-2");
    f.reply(f.request(), "run-1");
    await expect(first).resolves.toMatchObject({ output: "first" });
    await expect(second).resolves.toMatchObject({ output: "second" });
    f.complete(f.request(), "run-1");
    expect(f.progress).toHaveBeenCalledTimes(2);
  });

  it.each([
    { state: "failed", success: false, exitCode: 7 },
    { state: "stopped", success: false, exitCode: 1, stopped: true },
    { state: "paused", success: false, exitCode: 0, interrupted: true },
    { state: "failed", success: false, exitCode: 1, timedOut: true },
  ])("does not mistake $state for success", async (terminal) => {
    const f = await fixture();
    const result = f.delegation.dispatch("worker", "task");
    f.reply(f.request(), "run-1");
    f.complete(f.request(), "run-1", { ...terminal, results: [], summary: "termination reason" });
    await expect(result).resolves.toEqual({ exitCode: terminal.exitCode || 1, output: "termination reason", truncated: false });
    expect(f.progress.mock.lastCall?.[0]).toContain(terminal.state === "stopped" ? "stopped" : "failed");
  });

  it("honors child failures and both package and evaluation-window truncation", async () => {
    const f = await fixture();
    for (const [index, output] of ["short", "x".repeat(12_001)].entries()) {
      const result = f.delegation.dispatch("worker", "task");
      f.reply(f.request(index), `run-${String(index)}`);
      f.complete(f.request(index), `run-${String(index)}`, { results: [{ success: false, error: output, truncated: index === 0 }] });
      await expect(result).resolves.toEqual({ exitCode: 1, output, truncated: true });
    }
  });

  it("returns actionable RPC errors and rejects missing async IDs without waiting forever", async () => {
    const f = await fixture();
    const result = f.delegation.dispatch("worker", "task");
    f.events.emit(`subagents:rpc:v1:reply:${f.request().requestId}`, { version: 1, requestId: f.request().requestId, success: false, error: { code: "execution_failed", message: "capacity exhausted" } });
    await expect(result).resolves.toMatchObject({ exitCode: 1, output: "Subagent spawn failed: capacity exhausted" });
    const malformed = f.delegation.dispatch("worker", "task");
    f.reply(f.request(1), "run-2", { details: { runId: "not-an-async-ack" } });
    await expect(malformed).resolves.toMatchObject({ exitCode: 1, output: "Subagent spawn did not return details.asyncId." });
    expect(f.bus.listenerCount("subagent:async-complete")).toBe(0);
  });

  it("isolates sessions and overlapping instances, and rejects cross-session starts", async () => {
    const first = await fixture("first");
    const second = await fixture("second");
    const replacement = await createDelegation({ events: first.events }, first.ctx, first.host, { worker: "Replacement" }, first.progress);
    disposers.push(() => { replacement.dispose(); });
    const firstProvider = first.provider();
    expect(firstProvider.name).not.toBe(second.provider().name);
    expect(new Set(first.registrations.map((registration) => registration.name)).size).toBe(3);
    await expect(firstProvider.start({ ...startInput(first), sessionId: "second" })).rejects.toThrow("different Autostudio session");
    expect(first.host.start).not.toHaveBeenCalled();
    const newest = first.registrations.at(-1)?.definition.runner;
    if (newest?.type !== "external-job") throw new Error("Missing runner");
    first.delegation.dispose();
    expect(getExternalJobProvider(firstProvider.name)).toBeUndefined();
    expect(getExternalJobProvider(newest.provider)).toBeDefined();
    expect(getExternalJobProvider(second.provider().name)).toBeDefined();
    await expect(firstProvider.status("child-first")).rejects.toThrow("disposed");
  });

  it("disposes pending acknowledgements and completions without stopping host sessions", async () => {
    const f = await fixture();
    const beforeReply = f.delegation.dispatch("worker", "first");
    const afterReply = f.delegation.dispatch("reviewer", "second");
    f.reply(f.request(1), "run-2");
    const registrations = f.registrations.map((registration) => {
      if (registration.result?.ok !== true) throw new Error("Registration failed");
      return vi.spyOn(registration.result.registration, "dispose");
    });
    f.delegation.dispose();
    f.delegation.dispose();
    for (const result of [beforeReply, afterReply]) {
      await expect(result).resolves.toMatchObject({ exitCode: 1, output: "Delegation disposed; the host session may still be running." });
    }
    expect(registrations.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(f.bus.eventNames().filter((name) => String(name).startsWith("subagents:rpc:v1:reply:") || name === "subagent:async-complete")).toEqual([]);
    await expect(f.delegation.dispatch("worker", "later")).resolves.toMatchObject({ exitCode: 1 });
    expect(f.requests).toHaveLength(2);
    expect(f.host.status).not.toHaveBeenCalled();
  });

  it("fails setup without an owner and rolls back partial registrations", async () => {
    const before = listExternalJobProviders().map((provider) => provider.name);
    await expect(createDelegation({ events: { on: () => vi.fn(), emit: vi.fn() } }, { cwd: "/workspace", sessionManager: { getSessionId: () => "no-owner", getSessionFile: () => undefined } }, { start: vi.fn(), status: vi.fn() }, { worker: "Prompt" }, vi.fn())).rejects.toThrow("not installed");
    expect(listExternalJobProviders().map((provider) => provider.name)).toEqual(before);
    const f = await fixture();
    const dispose = vi.fn();
    const events: ExtensionAPI["events"] = {
      ...f.events,
      emit(name, payload) {
        if (name !== RUNTIME_AGENT_REGISTER_EVENT) return;
        assertRegistration(payload);
        const request = payload;
        request.result = request.definition.systemPrompt === "bad"
          ? { ok: false, error: new Error("invalid role") }
          : { ok: true, registration: { dispose } };
      },
    };
    const providers = listExternalJobProviders().map((provider) => provider.name);
    await expect(createDelegation({ events }, f.ctx, f.host, { worker: "good", reviewer: "bad" }, f.progress)).rejects.toThrow("invalid role");
    expect(dispose).toHaveBeenCalledOnce();
    expect(listExternalJobProviders().map((provider) => provider.name)).toEqual(providers);
  });

  it("accepts bare session IDs and ignores foreign completion even after acknowledgement", async () => {
    const f = await fixture();
    const result = f.delegation.dispatch("worker", "task");
    const settled = vi.fn();
    void result.then(settled);
    f.reply(f.request(), "run-1");
    f.complete(f.request(), "run-1", { sessionId: "foreign" });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    f.complete(f.request(), "run-1", { sessionId: "parent", truncated: true });
    await expect(result).resolves.toMatchObject({ exitCode: 0, truncated: true });
  });

  it("keeps host handles and cleanup intact when presentation fails", async () => {
    const f = await fixture();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.progress.mockImplementation(() => { throw new Error("UI disconnected"); });
    try {
      await expect(f.provider().start(startInput(f))).resolves.toMatchObject({ providerJobId: "child-parent" });
      const first = f.delegation.dispatch("worker", "first");
      const second = f.delegation.dispatch("reviewer", "second");
      const name = f.provider().name;
      f.delegation.dispose();
      await expect(first).resolves.toMatchObject({ exitCode: 1 });
      await expect(second).resolves.toMatchObject({ exitCode: 1 });
      expect(getExternalJobProvider(name)).toBeUndefined();
      expect(logged).toHaveBeenCalledTimes(3);
    } finally {
      logged.mockRestore();
    }
  });

  it("does not dispatch unknown roles, including inherited object keys", async () => {
    const f = await fixture();
    await expect(f.delegation.dispatch("toString", "task")).resolves.toMatchObject({ exitCode: 1, output: "Unknown Autostudio role: toString" });
    expect(f.requests).toEqual([]);
  });
});
