import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import autostudio from "./autostudio.js";
import { DEFAULT_CONFIG, type ModelTarget } from "./autostudioConfig.js";
import { createDelegation } from "./autostudioDelegation.js";
import { evaluateQa, type QaReport } from "./autostudioQa.js";
import { initWorkspace, isInitialized, readProjectState, requestStop, writeRoadmap } from "./autostudioState.js";

vi.mock("./autostudioDelegation.js", () => ({ createDelegation: vi.fn() }));
vi.mock("./autostudioSessions.js", () => ({ createSessionHost: vi.fn(), daemonRequest: vi.fn() }));
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((dir) => { rmSync(dir, { recursive: true, force: true }); }); vi.unstubAllEnvs(); vi.clearAllMocks(); });

function harness() {
  const cwd = mkdtempSync(join(tmpdir(), "autostudio-chat-"));
  dirs.push(cwd);
  const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  const setModel = vi.fn<ExtensionAPI["setModel"]>().mockResolvedValue(true);
  const setThinkingLevel = vi.fn<ExtensionAPI["setThinkingLevel"]>();
  autostudio({ registerCommand, sendMessage, setModel, setThinkingLevel, on: vi.fn(), events: { on: vi.fn(), emit: vi.fn() } });
  const handler = registerCommand.mock.calls[0]?.[1].handler;
  if (!handler) throw new Error("Missing command registration");
  const notify = vi.fn();
  // Narrow command harness: only fields consumed by the extension are supplied.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const ctx = { cwd, isProjectTrusted: () => true, modelRegistry: { find: (provider: string, id: string) => ({ provider, id, reasoning: true }) }, ui: { notify }, sessionManager: { getSessionId: () => "parent-session", getBranch: () => [{ type: "message", message: { role: "user", content: "Keep the existing Aria queue fed; upload to Immich." } }] } } as unknown as ExtensionCommandContext;
  return { cwd, handler, ctx, sendMessage, notify, setModel, setThinkingLevel };
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
    expect(dispatch).toHaveBeenCalledWith("worker", expect.stringContaining(`Project workspace: ${h.cwd}`), expect.objectContaining({ model: "openai-codex/gpt-5.6-sol", thinkingLevel: "medium" }));
    expect(dispatch).toHaveBeenCalledWith("worker", expect.stringContaining("existing Aria queue"), expect.any(Object));
    expect(h.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "gpt-6-astra" }));
    expect(h.setThinkingLevel).toHaveBeenCalledWith("medium");
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

function qaReport(overrides: Partial<QaReport> = {}): QaReport {
  return {
    status: "pass", kind: "gameplay", summary: "Playable round and restart verified",
    environment: "local browser at http://localhost:4000, current worktree",
    scenarios: [{ name: "Play round and restart", status: "pass", steps: ["Start, move, finish round, restart"], expected: "Score changes and restart resets the round", observed: "Score 1, round ended, restart resets score to 0", evidence: ["output/qa/playwright-trace.zip", "Playwright gameplay spec: 1 passed"] }],
    limitations: [], blockerKind: "none", blocker: "", ...overrides,
  };
}
const result = (output: string, exitCode = 0, truncated = false) => ({ output, exitCode, truncated });

function loopHarness(outputs: ReturnType<typeof result>[], completed = false) {
  const h = harness();
  initWorkspace(h.cwd, "Build a playable game");
  writeRoadmap(h.cwd, `# Roadmap\n## Completed\n${completed ? "- [x] Implement game" : ""}\n## Next\n${completed ? "" : "- [ ] Implement game"}\n## Later\n## In Progress\n## Blocked\n`);
  vi.stubEnv("PI_WEB_SESSIOND_SOCKET", "/test/sessiond.sock");
  const dispatch = vi.fn<(role: string, task: string, target?: ModelTarget) => Promise<ReturnType<typeof result>>>((role) => {
    const next = outputs.shift();
    if (!next) throw new Error("Unexpected dispatch: " + role);
    return Promise.resolve(next);
  });
  const dispose = vi.fn();
  vi.mocked(createDelegation).mockResolvedValue({ dispatch, dispose });
  return { ...h, dispatch, dispose, run: (max = 10) => h.handler(`start "Build a playable game" --max ${String(max)}`, h.ctx) };
}

describe("Autostudio failure escalation", () => {
  it.each([result("TASK-FAILED tests failed"), result("provider failed", 1), result("report cut off", 0, true)])("retries failed work with Astra High and failure context: %j", async (failure) => {
    const h = loopHarness([failure, result("Implemented"), result("REVIEW: PASS")]);
    await h.run(2);
    expect(h.dispatch.mock.calls.map((call) => call[2])).toEqual([DEFAULT_CONFIG.workers[0], DEFAULT_CONFIG.escalation, DEFAULT_CONFIG.escalation]);
    expect(h.dispatch.mock.calls[1]?.[1]).toContain("DO NOT repeat the previous approach");
    expect(readFileSync(join(h.cwd, ".autostudio/log.md"), "utf8")).toContain("failure escalation");
  });

  it("retains failure escalation when resuming the manager", async () => {
    const h = loopHarness([result("TASK-FAILED tests failed"), result("Implemented"), result("REVIEW: PASS")]);
    await h.run(1);
    await h.run(1);
    expect(h.dispatch.mock.calls[1]?.[2]).toEqual(DEFAULT_CONFIG.escalation);
  });

  it("escalates review-rejected work, not unrelated new work", async () => {
    const h = loopHarness([result("unverified"), result("REVIEW: FAIL missing test"), result("Implemented"), result("REVIEW: PASS")]);
    await h.run(2);
    expect(h.dispatch.mock.calls[2]?.[2]).toEqual(DEFAULT_CONFIG.escalation);
  });

  it("does not escalate truthful pending reports or human-only blockers", async () => {
    const pending = loopHarness([result("still pending"), result("Implemented")]);
    await pending.run(2);
    expect(pending.dispatch.mock.calls.map((call) => call[2])).toEqual(DEFAULT_CONFIG.workers);
    const blocked = loopHarness([result("TASK-FAILED credentials required from you")]);
    await blocked.run();
    expect(blocked.dispatch).toHaveBeenCalledOnce();
  });

  it("never starts a replacement writer after a stopped or timed-out waiter", async () => {
    const h = loopHarness([]);
    h.dispatch.mockImplementation(() => Promise.resolve({ ...result("child may be running", 1), stopped: true }));
    await h.run();
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).toContain("(stop)");
  });

  it("retries an ad-hoc task at most once with Astra High", async () => {
    const h = loopHarness([result("TASK-FAILED first failure"), result("TASK-FAILED second failure")]);
    await h.handler('task "Implement game"', h.ctx);
    expect(h.dispatch.mock.calls.map((call) => call[2])).toEqual([DEFAULT_CONFIG.workers[0], DEFAULT_CONFIG.escalation]);
    expect(h.sendMessage.mock.calls.at(-1)?.[0].details).toEqual({ level: "warning" });
  });

  it("uses project overrides for actual manager selection and both worker attempts", async () => {
    const h = loopHarness([result("TASK-FAILED first failure"), result("Verified")]);
    const config = {
      manager: { model: "p/manager", thinkingLevel: "low" },
      workers: [{ model: "p/worker", thinkingLevel: "off" }],
      escalation: { model: "p/retry", thinkingLevel: "high" },
    };
    mkdirSync(join(h.cwd, ".pi-web"));
    writeFileSync(join(h.cwd, ".pi-web/autostudio.json"), JSON.stringify(config));
    await h.handler('task "Implement game"', h.ctx);
    expect(h.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "p", id: "manager" }));
    expect(h.setThinkingLevel).toHaveBeenCalledWith("low");
    expect(h.dispatch.mock.calls.map((call) => call[2])).toEqual([config.workers[0], config.escalation]);
  });

  it.each(["unknown", "unsupported", "credentials"])("fails before dispatch when a model is %s", async (problem) => {
    const h = harness();
    vi.stubEnv("PI_WEB_SESSIOND_SOCKET", "/test/sessiond.sock");
    if (problem === "unknown") vi.spyOn(h.ctx.modelRegistry, "find").mockReturnValue(undefined);
    if (problem === "unsupported") {
      const original = h.ctx.modelRegistry.find.bind(h.ctx.modelRegistry);
      vi.spyOn(h.ctx.modelRegistry, "find").mockImplementation((provider, id) => {
        const model = original(provider, id);
        return model === undefined ? undefined : { ...model, reasoning: false };
      });
    }
    if (problem === "credentials") h.setModel.mockResolvedValue(false);
    await expect(h.handler('task "Verify task"', h.ctx)).rejects.toThrow(/Autostudio/);
    expect(createDelegation).not.toHaveBeenCalled();
    expect(h.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("shows configuration without changing the manager or starting children", async () => {
    const h = harness();
    await h.handler("config", h.ctx);
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).toContain("gpt-6-astra");
    expect(h.setModel).not.toHaveBeenCalled();
    expect(createDelegation).not.toHaveBeenCalled();
  });
});

describe("mandatory Autostudio acceptance QA", () => {
  it.each(["Implemented and unit tests passed", "Implemented\nGOAL-COMPLETE"])("requires actual QA and final review regardless of worker marker: %s", async (worker) => {
    const h = loopHarness([result(worker), result(JSON.stringify(qaReport())), result("REVIEW: PASS evidence independently verified")]);
    await h.run();
    expect(h.dispatch.mock.calls.map(([role]) => role)).toEqual(["worker", "qa", "reviewer"]);
    expect(h.dispatch.mock.calls[1]?.[1]).toContain("Run final acceptance QA");
    expect(h.dispatch.mock.calls[2]?.[1]).toContain("player-input gameplay");
    expect(readProjectState(h.cwd).state).toContain("goal complete — QA verified");
    expect(readFileSync(join(h.cwd, ".autostudio/QA.md"), "utf8")).toContain("Final review");
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).toContain("output/qa/playwright-trace.zip");
    expect(h.dispose).toHaveBeenCalledOnce();
    const roles = vi.mocked(createDelegation).mock.calls.at(-1)?.[3];
    expect(roles?.["qa"]).toContain("A loaded canvas is NOT playable-game evidence");
    expect(roles?.["qa"]).toContain("public interface");
  });

  it("reruns QA on a resumed clear roadmap rather than trusting old completion history", async () => {
    const h = loopHarness([result(JSON.stringify(qaReport({ kind: "e2e" }))), result("REVIEW: PASS")], true);
    await h.run();
    expect(h.dispatch.mock.calls.map(([role]) => role)).toEqual(["qa", "reviewer"]);
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).toContain("QA PASS (e2e)");
  });

  it("repairs QA failures then reruns fresh QA before completion", async () => {
    const bad = qaReport({ status: "fail", summary: "Restart leaves the game frozen" });
    const h = loopHarness([
      result("Implemented"), result(JSON.stringify(bad)), result("Restart repaired and checked"),
      result("REVIEW: PASS repair verified"), result(JSON.stringify(qaReport())), result("REVIEW: PASS final mission verified"),
    ]);
    await h.run();
    expect(h.dispatch.mock.calls.map(([role]) => role)).toEqual(["worker", "qa", "worker", "reviewer", "qa", "reviewer"]);
    expect(h.dispatch.mock.calls[2]?.[1]).toContain("Restart leaves the game frozen");
    expect(readProjectState(h.cwd).failures).toContain("QA not passed");
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).toContain("Goal complete");
  });

  it.each([result("REVIEW: FAIL missing game-end coverage"), result("REVIEW: PASS", 1), result("REVIEW: PASS", 0, true)])("queues repair when final review rejects or execution is incomplete: %j", async (review) => {
    const h = loopHarness([result(JSON.stringify(qaReport())), review], true);
    await h.run(1);
    expect(readProjectState(h.cwd).roadmap).toContain("- [ ] Resolve final QA findings");
    expect(readProjectState(h.cwd).state).not.toContain("goal complete");
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).toContain("Mission not complete");
  });

  it.each([result("GOAL-COMPLETE", 1), result("TASK-FAILED cannot run\nGOAL-COMPLETE"), result("still pending\nGOAL-COMPLETE")])("never lets a goal marker bypass worker failure/pending checks: %j", async (worker) => {
    const h = loopHarness([worker]);
    await h.run(1);
    expect(h.dispatch.mock.calls.map(([role]) => role)).toEqual(["worker"]);
    expect(readProjectState(h.cwd).roadmap).toContain("- [ ] Implement game");
  });

  it("does not report completion when the task budget leaves final QA unexecuted", async () => {
    const h = loopHarness([result("Implemented")]);
    await h.run(1);
    expect(h.dispatch.mock.calls.map(([role]) => role)).toEqual(["worker"]);
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).toContain("final QA remaining");
    expect(readProjectState(h.cwd).state).not.toContain("goal complete");
  });

  it("parks human-only QA blockers and does not certify blocked roadmaps on resume", async () => {
    const h = loopHarness([result(JSON.stringify(qaReport({ status: "blocked", blockerKind: "credentials", blocker: "credentials required from you" })))], true);
    await h.run();
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).toContain("Final QA blocked");
    expect(readProjectState(h.cwd).roadmap).toContain("(blocked: credentials: credentials required from you)");
    await h.run();
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).toContain("Human-blocked tasks remain");
  });

  it.each(["Playwright not installed", "Playwright not installed for login E2E", "payment test browser missing", "token fixture tool unavailable"])("treats local tooling as repairable rather than human-only: %s", async (blocker) => {
    const h = loopHarness([result(JSON.stringify(qaReport({ status: "blocked", blockerKind: "environment", blocker })))], true);
    await h.run(1);
    expect(readProjectState(h.cwd).roadmap).toContain("- [ ] Resolve final QA findings");
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).toContain("(budget)");
  });

  it("invalidates previous QA success when fresh QA fails on resume", async () => {
    const h = loopHarness([result(JSON.stringify(qaReport())), result("REVIEW: PASS"), result(JSON.stringify(qaReport({ status: "fail" })))], true);
    await h.run();
    expect(readProjectState(h.cwd).state).toContain("final review passed");
    await h.run(1);
    expect(readProjectState(h.cwd).state).toContain("QA/review rejected — not verified");
    expect(readProjectState(h.cwd).state).not.toContain("final review passed");
    await h.handler("status", h.ctx);
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).not.toContain("final review passed");
  });

  it.each(["qa", "reviewer"])("honors STOP after %s without certifying completion", async (stopRole) => {
    const h = loopHarness([], true);
    h.dispatch.mockImplementation((role) => {
      if (role === stopRole) requestStop(h.cwd);
      return Promise.resolve(result(role === "qa" ? JSON.stringify(qaReport()) : "REVIEW: PASS"));
    });
    await h.run();
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).toContain("(stop)");
    expect(readProjectState(h.cwd).state).not.toContain("goal complete");
    expect(h.dispatch).toHaveBeenCalledTimes(stopRole === "qa" ? 1 : 2);
  });

  it("withholds completion if new work arrives during final review", async () => {
    const h = loopHarness([], true);
    h.dispatch.mockImplementation((role) => {
      if (role === "reviewer") writeRoadmap(h.cwd, "## Completed\n- [x] Implement game\n## Next\n- [ ] Repair new defect\n");
      return Promise.resolve(result(role === "qa" ? JSON.stringify(qaReport()) : "REVIEW: PASS"));
    });
    await h.run(1);
    expect(h.sendMessage.mock.calls.at(-1)?.[0].content).toContain("Mission not complete");
  });
});

describe("QA evidence validation", () => {
  it.each(["gameplay", "e2e", "artifact"] as const)("accepts complete %s evidence", (kind) => {
    expect(evaluateQa(result(JSON.stringify(qaReport({ kind })))).passed).toBe(true);
  });

  it.each([
    result("QA: PASS"), result("{}"), result(""), result(JSON.stringify(qaReport()), 1), result(JSON.stringify(qaReport()), 0, true),
    result(JSON.stringify(qaReport({ scenarios: [] }))),
    result(JSON.stringify(qaReport({ limitations: ["Gameplay not exercised"] }))),
    result(JSON.stringify(qaReport({ blocker: "Need credentials" }))),
    ...[{ kind: ["gameplay"] }, { status: ["pass"] }, { blockerKind: ["none"] }].map((fields) => result(JSON.stringify({ ...qaReport(), ...fields }))),
    result(JSON.stringify({ ...qaReport(), scenarios: [{ ...qaReport().scenarios[0], status: ["pass"] }] })),
    result(JSON.stringify(qaReport({ blockerKind: "environment" }))),
    ...["not-run", "fail", "blocked"].map((status) => result(JSON.stringify({ ...qaReport(), scenarios: [{ ...qaReport().scenarios[0], status }] }))),
    result(JSON.stringify({ ...qaReport(), scenarios: [{ ...qaReport().scenarios[0], evidence: [] }] })),
    result(JSON.stringify({ ...qaReport(), scenarios: [{ ...qaReport().scenarios[0], steps: [] }] })),
  ])("rejects missing, contradictory or unexecuted QA evidence: %j", (input) => {
    expect(evaluateQa(input).passed).toBe(false);
  });
});
