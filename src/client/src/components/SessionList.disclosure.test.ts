// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../api";
import { SessionList } from "./SessionList";

function session(id: string, parent?: SessionInfo, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { id, name: id, cwd: "/repo", path: `/repo/sessions/${id}.jsonl`, created: "now", modified: "now", messageCount: 1, firstMessage: id, persisted: true,
    ...(parent === undefined ? {} : { parentSessionPath: parent.path }), ...extra };
}

async function renderList(sessions: SessionInfo[], machineId = "local"): Promise<SessionList> {
  const list = new SessionList();
  list.sessions = sessions;
  list.machineId = machineId;
  document.body.append(list);
  await settled(list);
  return list;
}

async function settled(list: SessionList) {
  await list.updateComplete;
  await list.updateComplete;
}

function names(list: SessionList): string[] {
  return Array.from(list.renderRoot.querySelectorAll(".action-row .action-name"), (el) => el.textContent.trim().replace(/^↳/u, ""));
}

function row(list: SessionList, item: SessionInfo): HTMLElement {
  const found = Array.from(list.renderRoot.querySelectorAll<HTMLElement>(".action-row")).find((el) => el.title === item.path);
  if (found === undefined) throw new Error(`Missing row ${item.id}`);
  return found;
}

function button(list: SessionList, label: string): HTMLButtonElement {
  const found = Array.from(list.renderRoot.querySelectorAll("button")).find((el) => el.textContent.trim() === label);
  if (found === undefined) throw new Error(`Missing button ${label}`);
  return found;
}

async function openMenu(list: SessionList, item: SessionInfo) {
  row(list, item).querySelector<HTMLButtonElement>(".action-menu-toggle")?.click();
  await settled(list);
}

async function toggleSubagents(list: SessionList, item: SessionInfo) {
  await openMenu(list, item);
  const toggle = list.renderRoot.querySelector<HTMLButtonElement>(".subagent-visibility-toggle");
  if (toggle === null) throw new Error(`Missing subagent toggle for ${item.id}`);
  toggle.click();
  await settled(list);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  localStorage.clear();
});

describe("SessionList subagent disclosure", () => {
  it("hides and restores an entire branch from its parent's right-hand menu without selecting or archiving", async () => {
    const parent = session("parent");
    const child = session("child", parent);
    const grandchild = session("grandchild", child);
    const other = session("other");
    const list = await renderList([parent, child, grandchild, other]);
    list.onSelect = vi.fn();
    list.onArchive = vi.fn();
    list.onArchiveWithDescendants = vi.fn();
    list.selected = grandchild;
    await settled(list);

    await openMenu(list, parent);
    const hide = button(list, "Hide subagents (2)");
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    hide.click();
    await settled(list);

    expect(names(list)).toEqual(["parent", "other"]);
    expect(row(list, parent).querySelector(".hidden-subagents")?.textContent).toBe("2 hidden");
    expect(list.shadowRoot?.activeElement).toBe(row(list, parent).querySelector(".action-menu-toggle"));
    expect(list.selected).toBe(grandchild);
    expect(list.sessions).toEqual([parent, child, grandchild, other]);
    expect(list.onSelect).not.toHaveBeenCalled();
    expect(list.onArchive).not.toHaveBeenCalled();
    expect(list.onArchiveWithDescendants).not.toHaveBeenCalled();

    await openMenu(list, parent);
    const show = button(list, "Show subagents (2)");
    expect(show.getAttribute("aria-expanded")).toBe("false");
    show.click();
    await settled(list);
    expect(names(list)).toEqual(["parent", "child", "grandchild", "other"]);
    expect(row(list, grandchild).classList.contains("selected")).toBe(true);
  });

  it("keeps newly arriving workers hidden and preserves unread counts", async () => {
    const parent = session("parent");
    const child = session("child", parent);
    const list = await renderList([parent, child]);
    await toggleSubagents(list, parent);
    const newcomer = session("new", parent);
    list.sessions = [{ ...parent }, { ...child, messageCount: 10 }, newcomer];
    list.unreadSessionIds = new Set([child.id, newcomer.id]);
    await settled(list);
    expect(names(list)).toEqual(["parent"]);
    expect(row(list, parent).querySelector(".hidden-subagents")?.textContent).toBe("2 hidden");
    expect(list.renderRoot.querySelector(".section-unread-count")?.textContent).toBe("2 unread");
  });

  it("persists across recreation, with separate machine and workspace preferences", async () => {
    const parent = session("parent");
    const child = session("child", parent);
    const list = await renderList([parent, child]);
    await toggleSubagents(list, parent);
    list.remove();
    const restored = await renderList([parent, child]);
    expect(names(restored)).toEqual(["parent"]);
    restored.machineId = "remote";
    await settled(restored);
    expect(names(restored)).toEqual(["parent", "child"]);
    restored.machineId = "local";
    await settled(restored);
    expect(names(restored)).toEqual(["parent"]);
    const elsewhere = session("parent", undefined, { cwd: "/elsewhere", path: "/elsewhere/parent.jsonl" });
    restored.sessions = [elsewhere, session("child", elsewhere, { cwd: "/elsewhere", path: "/elsewhere/child.jsonl" })];
    await settled(restored);
    expect(names(restored)).toEqual(["parent", "child"]);
  });

  it("retains a nested parent's preference when its ancestor is shown again", async () => {
    const parent = session("parent");
    const child = session("child", parent);
    const grandchild = session("grandchild", child);
    const list = await renderList([parent, child, grandchild]);
    await toggleSubagents(list, child);
    await toggleSubagents(list, parent);
    await toggleSubagents(list, parent);
    expect(names(list)).toEqual(["parent", "child"]);
    await toggleSubagents(list, child);
    expect(names(list)).toEqual(["parent", "child", "grandchild"]);
  });

  it("does not leak hidden archived children into the Archived section", async () => {
    const parent = session("parent");
    const child = session("child", parent, { archived: true });
    const other = session("archived-other", undefined, { archived: true });
    const list = await renderList([parent, child, other]);
    button(list, "▸ Archived").click();
    await settled(list);
    expect(names(list)).toContain("child");
    await toggleSubagents(list, parent);
    expect(names(list)).toEqual(["parent", "archived-other"]);
    await toggleSubagents(list, parent);
    expect(names(list)).toEqual(["parent", "child", "archived-other"]);
  });

  it("allows archived parents with live descendants to hide their branch", async () => {
    const parent = session("parent", undefined, { archived: true });
    const child = session("child", parent);
    const list = await renderList([parent, child]);
    await toggleSubagents(list, parent);
    expect(names(list)).toEqual(["parent"]);
    await toggleSubagents(list, parent);
    expect(names(list)).toEqual(["parent", "child"]);
  });

  it("removes hidden rows from bulk selection and Select visible", async () => {
    const parent = session("parent");
    const child = session("child", parent);
    const other = session("other");
    const list = await renderList([parent, child, other]);
    list.onArchiveMany = vi.fn();
    list.renderRoot.querySelector<HTMLButtonElement>('[aria-label="Select current sessions"]')?.click();
    await settled(list);
    button(list, "Select visible").click();
    await settled(list);
    await toggleSubagents(list, parent);
    expect(button(list, "Clear selected (2)")).toBeDefined();
    button(list, "Archive").click();
    expect(list.onArchiveMany).toHaveBeenCalledWith([parent, other]);
    await settled(list);
    button(list, "Select visible").click();
    await settled(list);
    expect(list.renderRoot.querySelectorAll(".session-checkbox:checked")).toHaveLength(2);
  });

  it("does not offer the action for leaf rows or hide unrelated orphans", async () => {
    const parent = session("parent");
    const child = session("child", parent);
    const orphan = session("orphan", session("missing"));
    const list = await renderList([parent, child, orphan]);
    await openMenu(list, orphan);
    expect(list.renderRoot.querySelector(".subagent-visibility-toggle")).toBeNull();
    await toggleSubagents(list, parent);
    expect(names(list)).toEqual(["parent", "orphan"]);
  });

  it("stays usable when storage is unavailable", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("Storage disabled"); },
      setItem: () => { throw new Error("Storage disabled"); },
    });
    const parent = session("parent");
    const list = await renderList([parent, session("child", parent)]);
    await toggleSubagents(list, parent);
    expect(names(list)).toEqual(["parent"]);
    await toggleSubagents(list, parent);
    expect(names(list)).toEqual(["parent", "child"]);
  });

  it("ignores malformed stored preferences", async () => {
    localStorage.setItem("pi-web:hidden-subagent-parents:local", "not-json");
    const parent = session("parent");
    const list = await renderList([parent, session("child", parent)]);
    expect(names(list)).toEqual(["parent", "child"]);
  });
});
