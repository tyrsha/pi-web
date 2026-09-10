// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionActivity, SessionInfo, SessionStatus } from "../api";
import { markCachedNewSessionInfo } from "../cachedNewSessions";
import { activeSubagentCounts, SessionList } from "./SessionList";

function session(id: string, parent?: SessionInfo): SessionInfo {
  return { id, name: id, cwd: "/repo", path: `/repo/${id}.jsonl`, messageCount: 1, firstMessage: id, created: "now", modified: "now", persisted: true,
    ...(parent === undefined ? {} : { parentSessionPath: parent.path }) };
}
function status(id: string, extra: Partial<SessionStatus> = {}): SessionStatus {
  return { sessionId: id, isStreaming: false, isBashRunning: false, isCompacting: false, pendingMessageCount: 0, queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, ...extra };
}
function activity(id: string, extra: Partial<SessionActivity> = {}): SessionActivity {
  return { sessionId: id, phase: "active", label: "Working", at: "now", ...extra };
}
async function settled(list: SessionList) {
  await list.updateComplete;
  await list.updateComplete;
}
function parentRow(list: SessionList): HTMLElement {
  const row = list.renderRoot.querySelector<HTMLElement>('.action-row[title="/repo/parent.jsonl"]');
  if (row === null) throw new Error("Missing parent row");
  return row;
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("active subagent counts", () => {
  const parent = session("parent");
  const child = session("child", parent);
  const grandchild = session("grandchild", child);
  const unrelated = session("unrelated");
  const tree = [parent, child, grandchild, unrelated];

  it.each([
    { isStreaming: true }, { isBashRunning: true }, { isCompacting: true }, { pendingMessageCount: 1 },
  ])("propagates descendant runtime work to every ancestor: %j", (work) => {
    const counts = activeSubagentCounts(tree, { grandchild: status("grandchild", work), unrelated: status("unrelated", { isStreaming: true }) });
    expect([...counts]).toEqual([["parent", 1], ["child", 1], ["grandchild", 0], ["unrelated", 0]]);
  });

  it("counts multiple working descendants but not the parent's own work", () => {
    const counts = activeSubagentCounts(tree, { parent: status("parent", { isStreaming: true }), child: status("child", { isStreaming: true }) }, { grandchild: activity("grandchild") });
    expect(counts.get("parent")).toBe(2);
    expect(counts.get("child")).toBe(1);
  });

  it("ignores startup, idle, error, and stale archived/cached work", () => {
    const archived = { ...session("archived", parent), archived: true };
    const cached = markCachedNewSessionInfo(session("cached", parent));
    expect(activeSubagentCounts([...tree, archived, cached], {}, {
      child: activity("child", { startup: true }), grandchild: activity("grandchild", { phase: "error" }),
      archived: activity("archived"), cached: activity("cached"),
    }, { archived: true, cached: true }).get("parent")).toBe(0);
    expect(activeSubagentCounts(tree, {}, { child: activity("child", { phase: "idle" }) }).get("parent")).toBe(0);
    expect(activeSubagentCounts(tree, {}, {}, { child: true }).get("parent")).toBe(1);
  });

  it("normalizes links, crosses archived ancestors, and tolerates cycles without counting self", () => {
    const archivedChild = { ...child, archived: true };
    const normalizedGrandchild = { ...grandchild, parentSessionPath: `${child.path}/` };
    expect(activeSubagentCounts([parent, archivedChild, normalizedGrandchild], {}, { grandchild: activity("grandchild") }).get("parent")).toBe(1);
    expect(activeSubagentCounts([{ ...parent, parentSessionPath: child.path }, child], {}, { parent: activity("parent") })).toEqual(new Map([["parent", 0], ["child", 1]]));
  });

  it("clears the aggregate when a child stops, is detached, or disappears", () => {
    expect(activeSubagentCounts(tree, {}, { child: activity("child") }).get("parent")).toBe(1);
    expect(activeSubagentCounts(tree, { child: status("child") }).get("parent")).toBe(0);
    expect(activeSubagentCounts([parent, session("child")], {}, { child: activity("child") }).get("parent")).toBe(0);
    expect(activeSubagentCounts([parent], {}, { child: activity("child") }).get("parent")).toBe(0);
  });
});

describe("parent work indicator", () => {
  it("stays visible for hidden workers and clears only after the last worker stops", async () => {
    const parent = session("parent");
    const child = session("child", parent);
    const second = session("second", parent);
    const list = new SessionList();
    list.sessions = [parent, child, second];
    list.statuses = { parent: status("parent") };
    list.activities = { child: activity("child"), second: activity("second") };
    document.body.append(list);
    await settled(list);
    expect(parentRow(list).querySelector('.activity-indicator[aria-label="2 subagents active"]')).not.toBeNull();

    parentRow(list).querySelector<HTMLButtonElement>(".action-menu-toggle")?.click();
    await settled(list);
    const reload = Array.from(parentRow(list).querySelectorAll("button")).find((el) => el.textContent.trim() === "Reload from disk");
    expect(reload?.disabled).toBe(false);
    parentRow(list).querySelector<HTMLButtonElement>(".subagent-visibility-toggle")?.click();
    await settled(list);
    expect(list.renderRoot.querySelectorAll(".action-row")).toHaveLength(1);
    expect(parentRow(list).querySelector('.activity-indicator[aria-label="2 subagents active"]')).not.toBeNull();
    expect(list.statuses["parent"]?.isStreaming).toBe(false);

    list.activities = { second: activity("second") };
    await settled(list);
    expect(parentRow(list).querySelector('.activity-indicator[aria-label="1 subagent active"]')).not.toBeNull();
    list.activities = {};
    await settled(list);
    expect(parentRow(list).querySelector(".activity-indicator")).toBeNull();
  });

  it("preserves the parent's own activity and unread flag without triggering session actions", async () => {
    const parent = session("parent");
    const child = session("child", parent);
    const list = new SessionList();
    list.sessions = [parent, child];
    list.statuses = { parent: status("parent", { isStreaming: true }) };
    list.activities = { child: activity("child") };
    list.sending = { parent: true };
    list.unreadSessionIds = new Set([parent.id]);
    list.onSelect = vi.fn();
    list.onArchive = vi.fn();
    document.body.append(list);
    await settled(list);
    expect(parentRow(list).querySelector(".activity-indicator.sending")).not.toBeNull();
    expect(parentRow(list).querySelector(".unread-ring")?.getAttribute("aria-label")).toBe("Unread session activity · Sending message · 1 subagent active");
    list.activities = {};
    list.sending = {};
    await settled(list);
    expect(parentRow(list).querySelector(".activity-indicator.session")).not.toBeNull();
    expect(parentRow(list).querySelector(".unread-ring")?.getAttribute("aria-label")).toBe("Unread session activity · Session active");
    expect(list.onSelect).not.toHaveBeenCalled();
    expect(list.onArchive).not.toHaveBeenCalled();
  });
});
