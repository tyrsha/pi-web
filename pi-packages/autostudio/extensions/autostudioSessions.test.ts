import { describe, expect, it, vi } from "vitest";
import { createSessionHost, workerSessionPath } from "./autostudioSessions.js";

describe("Pi Web worker sessions", () => {
  it("creates, names and prompts a real session in the manager workspace", async () => {
    const request = vi.fn((_method: string, path: string): Promise<unknown> => Promise.resolve(path === "/sessions" ? { id: "child/one" } : { accepted: true }));
    const host = createSessionHost(request, "/work/한 글", { provider: "p", id: "m" });
    const result = await host.start({ cwd: "/work/한 글", name: "Autostudio worker", prompt: "Verify task" });
    expect(request.mock.calls).toEqual([
      ["POST", "/sessions", { cwd: "/work/한 글" }],
      ["POST", "/sessions/child%2Fone/commands/run", { cwd: "/work/한 글", text: "/name Autostudio worker" }],
      ["POST", "/sessions/child%2Fone/model", { cwd: "/work/한 글", provider: "p", modelId: "m" }],
      ["POST", "/sessions/child%2Fone/prompt", { cwd: "/work/한 글", text: "Verify task" }],
    ]);
    expect(result.id).toBe("child/one");
    const url = new URL(result.url, "https://example.test/nested/pi/");
    expect(url.pathname).toBe("/nested/pi/");
    expect(url.searchParams.get("session")).toBe("child/one");
    expect(url.searchParams.get("cwd")).toBe("/work/한 글");
  });

  it("rejects a workspace mismatch before creating anything", async () => {
    const request = vi.fn();
    await expect(createSessionHost(request, "/a").start({ cwd: "/b", name: "worker", prompt: "task" })).rejects.toThrow("workspace");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["isStreaming", "isCompacting", "isBashRunning", "pendingMessageCount"])("keeps %s work running without reading partial output", async (field) => {
    const request = vi.fn(() => Promise.resolve({ [field]: field === "pendingMessageCount" ? 1 : true }));
    expect(await createSessionHost(request, "/work").status("id")).toEqual({ state: "running" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    [[], "running", undefined],
    [[{ role: "assistant", stopReason: "toolUse", content: [] }], "running", undefined],
    [[{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "verified" }] }], "completed", "verified"],
    [[{ role: "assistant", stopReason: "error", errorMessage: "provider failed" }], "failed", "provider failed"],
    [[{ role: "assistant", stopReason: "aborted", content: [] }], "stopped", ""],
  ])("maps terminal messages without treating submission as success", async (messages, state, output) => {
    const request = vi.fn((_method: string, path: string) => Promise.resolve(path.includes("/status?") ? {} : { messages }));
    expect(await createSessionHost(request, "/work").status("id")).toEqual({ state, ...(output === undefined ? {} : { output }) });
  });

  it("does not hide failed session creation", async () => {
    const request = vi.fn((): Promise<unknown> => Promise.reject(new Error("daemon unavailable")));
    await expect(createSessionHost(request, "/work").start({ cwd: "/work", name: "worker", prompt: "task" })).rejects.toThrow("daemon unavailable");
  });

  it("does not use leading-root links", () => {
    expect(workerSessionPath("x&y", "/work")).toBe("?session=x%26y&cwd=%2Fwork&view=chat");
  });
});
