import { describe, expect, it, vi } from "vitest";
import { createSessionHost, workerSessionPath } from "./autostudioSessions.js";

describe("Pi Web tracked worker sessions", () => {
  it("creates, names and prompts a tracked child in one parent-scoped request", async () => {
    const request = vi.fn((): Promise<unknown> => Promise.resolve({ sessionId: "child/one", parentSessionId: "parent/one", cwd: "/work/한 글" }));
    const host = createSessionHost(request, "/work/한 글", "parent/one", { provider: "p", id: "luna" });
    const result = await host.start({ cwd: "/work/한 글", name: "Autostudio worker", prompt: "Verify task" });
    expect(request.mock.calls).toEqual([
      ["POST", "/sessions/parent%2Fone/subsessions", { cwd: "/work/한 글", name: "Autostudio worker", prompt: "Verify task", model: "p/luna" }],
    ]);
    expect(result.id).toBe("child/one");
    const url = new URL(result.url, "https://example.test/nested/pi/");
    expect(url.pathname).toBe("/nested/pi/");
    expect(url.searchParams.get("session")).toBe("child/one");
    expect(url.searchParams.get("cwd")).toBe("/work/한 글");
  });

  it("leaves model inheritance to the daemon when no override was requested", async () => {
    const request = vi.fn((): Promise<unknown> => Promise.resolve({ sessionId: "child", parentSessionId: "parent", cwd: "/work" }));
    await createSessionHost(request, "/work", "parent").start({ cwd: "/work", name: "worker", prompt: "task" });
    expect(request.mock.calls).toEqual([["POST", "/sessions/parent/subsessions", { cwd: "/work", name: "worker", prompt: "task" }]]);
  });

  it("rejects a workspace mismatch before creating anything", async () => {
    const request = vi.fn();
    await expect(createSessionHost(request, "/a", "parent").start({ cwd: "/b", name: "worker", prompt: "task" })).rejects.toThrow("workspace");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: "child", parentSessionId: "other", cwd: "/work" },
    { sessionId: "child", parentSessionId: "parent", cwd: "/other" },
    { id: "independent", cwd: "/work" },
  ])("rejects unlinked or mismatched responses", async (response) => {
    const request = vi.fn(() => Promise.resolve(response));
    await expect(createSessionHost(request, "/work", "parent").start({ cwd: "/work", name: "worker", prompt: "task" })).rejects.toThrow("tracked worker");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never falls back to independent creation if the daemon lacks the child endpoint", async () => {
    const request = vi.fn((): Promise<unknown> => Promise.reject(new Error("404: route not found")));
    await expect(createSessionHost(request, "/work", "parent").start({ cwd: "/work", name: "worker", prompt: "task" })).rejects.toThrow("404");
    expect(request.mock.calls).toEqual([["POST", "/sessions/parent/subsessions", { cwd: "/work", name: "worker", prompt: "task" }]]);
  });

  it.each(["isStreaming", "isCompacting", "isBashRunning", "pendingMessageCount"])("keeps %s work running without reading partial output", async (field) => {
    const request = vi.fn(() => Promise.resolve({ [field]: field === "pendingMessageCount" ? 1 : true }));
    expect(await createSessionHost(request, "/work", "parent").status("id")).toEqual({ state: "running" });
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
    expect(await createSessionHost(request, "/work", "parent").status("id")).toEqual({ state, ...(output === undefined ? {} : { output }) });
  });

  it("does not hide failed session creation", async () => {
    const request = vi.fn((): Promise<unknown> => Promise.reject(new Error("daemon unavailable")));
    await expect(createSessionHost(request, "/work", "parent").start({ cwd: "/work", name: "worker", prompt: "task" })).rejects.toThrow("daemon unavailable");
  });

  it("does not use leading-root links", () => {
    expect(workerSessionPath("x&y", "/work")).toBe("?session=x%26y&cwd=%2Fwork&view=chat");
  });
});
