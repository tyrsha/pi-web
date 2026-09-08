import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createDirectWorkerProvider, DIRECT_WORKER_PROVIDER } from "./autostudioDirectWorkers.js";
import type { DaemonRequest } from "./autostudioSessions.js";

const cwd = "/workspace";
const parent = { id: "parent", path: "/sessions/parent.jsonl", cwd };
const input = { prompt: "Verify only this slice", cwd, agent: "worker", sessionId: parent.path, options: {} };

function fixture() {
  const request = vi.fn<DaemonRequest>((method, path) => {
    if (method === "GET" && path === "/sessions?cwd=%2Fworkspace") return Promise.resolve([parent]);
    if (method === "POST" && path === "/sessions/parent/subsessions") return Promise.resolve({ sessionId: "child", parentSessionId: parent.id, cwd });
    if (path.startsWith("/sessions/child/status?")) return Promise.resolve({ isStreaming: false });
    if (path.startsWith("/sessions/child/messages?")) return Promise.resolve({ messages: [{ role: "assistant", stopReason: "stop", content: " VERIFIED " }] });
    throw new Error(`Unexpected daemon call ${method} ${path}`);
  });
  return { request, provider: createDirectWorkerProvider(request) };
}

describe("direct subagent workers", () => {
  it.each([parent.id, parent.path])("resolves originating identity %s without redirecting to another parent", async (sessionId) => {
    const { request, provider } = fixture();
    const child = await provider.start({ ...input, sessionId });
    expect(request).toHaveBeenLastCalledWith("POST", "/sessions/parent/subsessions", {
      cwd, prompt: input.prompt, name: "Autostudio worker",
    });
    expect(child).toEqual({ providerJobId: JSON.stringify(["child", cwd]), state: "running",
      handleUrl: "?session=child&cwd=%2Fworkspace&view=chat", conversationUrl: "?session=child&cwd=%2Fworkspace&view=chat" });
  });

  it("supports the configured reviewer and an explicit provider model", async () => {
    const { request, provider } = fixture();
    await provider.start({ ...input, agent: "autostudio-reviewer", options: { model: "openai-codex/gpt-5.6-luna" } });
    expect(request).toHaveBeenLastCalledWith("POST", "/sessions/parent/subsessions", {
      cwd, prompt: input.prompt, name: "Autostudio reviewer", model: "openai-codex/gpt-5.6-luna",
    });
  });

  it("reattaches using a persisted handle after provider replacement", async () => {
    const { request, provider } = fixture();
    const child = await provider.start(input);
    const replacement = createDirectWorkerProvider(request);
    await expect(replacement.reattach(child.providerJobId)).resolves.toEqual({ providerJobId: child.providerJobId, state: "completed" });
    await expect(replacement.result(child.providerJobId)).resolves.toEqual({ providerJobId: child.providerJobId, state: "completed", output: "VERIFIED" });
    expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
  });

  it("retains running status and failures rather than manufacturing completion", async () => {
    const { request, provider } = fixture();
    const child = await provider.start(input);
    request.mockResolvedValueOnce({ isStreaming: true });
    await expect(provider.status(child.providerJobId)).resolves.toMatchObject({ state: "running" });
    request.mockResolvedValueOnce({ isStreaming: false }).mockResolvedValueOnce({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "Quota exhausted" }] });
    await expect(provider.result(child.providerJobId)).resolves.toMatchObject({ state: "failed", output: "Quota exhausted" });
  });

  it.each([
    { sessionId: "" }, { sessionId: "different-parent" }, { cwd: "/different" },
    { cwd: "relative" }, { cwd: `/${"x".repeat(250)}` },
    { options: { model: "unqualified-model" } }, { options: { ignoredSetting: true } },
  ])("fails closed before creating a worker for invalid identity/options %j", async (override) => {
    const { request, provider } = fixture();
    await expect(provider.start({ ...input, ...override })).rejects.toThrow();
    expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(0);
  });

  it("does not fall back to the old independent-session endpoint", async () => {
    const { request, provider } = fixture();
    request.mockResolvedValueOnce([parent]).mockRejectedValueOnce(new Error("404: endpoint unavailable"));
    await expect(provider.start(input)).rejects.toThrow("404");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.some(([, path]) => path === "/sessions")).toBe(false);
  });

  it("rejects invalid saved handles without contacting the daemon", async () => {
    const { request, provider } = fixture();
    await expect(provider.result('["child","relative"]')).rejects.toThrow("Invalid tracked worker handle");
    expect(request).not.toHaveBeenCalled();
  });

  it("ships all public Autostudio roles through the same external-job provider", () => {
    for (const role of ["worker", "reviewer", "researcher"]) {
      const file = readFileSync(new URL(`../agents/${role}.md`, import.meta.url), "utf8");
      expect(file).toContain(`runner: { type: external-job, provider: ${DIRECT_WORKER_PROVIDER} }`);
      expect(file).toContain("defaultContext: fresh");
    }
    expect(readFileSync(new URL("../package.json", import.meta.url), "utf8")).toContain('"./extensions/directWorkers.ts"');
  });
});
