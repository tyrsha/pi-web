import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import autostudio from "./autostudio.js";
import { createDelegation } from "./autostudioDelegation.js";
import { isInitialized } from "./autostudioState.js";

vi.mock("./autostudioDelegation.js", () => ({ createDelegation: vi.fn() }));
vi.mock("./autostudioSessions.js", () => ({ createSessionHost: vi.fn(), daemonRequest: vi.fn() }));
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((dir) => { rmSync(dir, { recursive: true, force: true }); }); vi.unstubAllEnvs(); vi.clearAllMocks(); });

function harness() {
  const cwd = mkdtempSync(join(tmpdir(), "autostudio-chat-"));
  dirs.push(cwd);
  const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  autostudio({ registerCommand, sendMessage, on: vi.fn(), events: { on: vi.fn(), emit: vi.fn() } });
  const handler = registerCommand.mock.calls[0]?.[1].handler;
  if (!handler) throw new Error("Missing command registration");
  const notify = vi.fn();
  // Narrow command harness: only fields consumed by the extension are supplied.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const ctx = { cwd, ui: { notify }, sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "Keep the existing Aria queue fed; upload to Immich." } }] } } as unknown as ExtensionCommandContext;
  return { cwd, handler, ctx, sendMessage, notify };
}

describe("Autostudio chat command", () => {
  it("sends durable visible custom messages, not tray notifications", async () => {
    const h = harness();
    await h.handler("status", h.ctx);
    expect(h.sendMessage.mock.calls[0]?.[0].customType).toBe("autostudio-progress");
    expect(h.sendMessage.mock.calls[0]?.[0].display).toBe(true);
    expect(h.sendMessage.mock.calls[0]?.[0].content).toContain("not initialized");
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("uses session cwd and original decisions for real worker delegation", async () => {
    const h = harness();
    vi.stubEnv("PI_WEB_SESSIOND_SOCKET", "/test/sessiond.sock");
    const dispatch = vi.fn(() => Promise.resolve({ exitCode: 0, output: "Verified task", truncated: false }));
    const dispose = vi.fn();
    vi.mocked(createDelegation).mockResolvedValue({ dispatch, dispose });
    await h.handler('task "Verify queue status"', h.ctx);
    expect(isInitialized(h.cwd)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith("worker", expect.stringContaining(`Project workspace: ${h.cwd}`));
    expect(dispatch).toHaveBeenCalledWith("worker", expect.stringContaining("existing Aria queue"));
    expect(dispose).toHaveBeenCalledOnce();
    expect(h.sendMessage.mock.calls.at(-1)?.[0].display).toBe(true);
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).toContain("single task finished");
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("releases delegation resources when execution fails instead of reporting success", async () => {
    const h = harness();
    vi.stubEnv("PI_WEB_SESSIOND_SOCKET", "/test/sessiond.sock");
    const dispose = vi.fn();
    vi.mocked(createDelegation).mockResolvedValue({ dispatch: vi.fn(() => Promise.reject(new Error("worker unavailable"))), dispose });
    await expect(h.handler('task "Verify queue status"', h.ctx)).rejects.toThrow("worker unavailable");
    expect(dispose).toHaveBeenCalledOnce();
    expect(h.sendMessage.mock.calls.some(([message]) => typeof message.content === "string" && message.content.includes("finished"))).toBe(false);
  });
});
