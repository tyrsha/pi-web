// @vitest-environment happy-dom

import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../api";
import type { PluginSettings, ProjectListActionContext } from "../plugins/types";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { machineStatusSnapshot } from "../machineStatus.testSupport";
import { ProjectList } from "./ProjectList";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.useRealTimers();
});

describe("project-list action-menu extensions", () => {
  it("keeps the host row intact and adds extension actions inside its menu", async () => {
    const select = vi.fn();
    const settings: PluginSettings = { read: () => Promise.resolve(undefined), write: () => Promise.resolve() };
    let actionContext: ProjectListActionContext | undefined;
    const list = new ProjectList();
    list.projects = [project("project-a")];
    list.machine = { id: "remote-a", name: "Remote A", kind: "remote" };
    list.settings = settings;
    list.onSelect = select;
    list.extension = {
      id: "organizer",
      renderActions: (context) => {
        actionContext = context;
        return html`<button>Organize</button>`;
      },
    };
    document.body.append(list);
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".action-row")).not.toBeNull();
    expect(list.shadowRoot?.querySelector(".action-menu-panel")).toBeNull();
    list.shadowRoot?.querySelector<HTMLButtonElement>(".action-menu-toggle")?.click();
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".action-main")).not.toBeNull();
    expect(list.shadowRoot?.querySelector(".action-menu-panel")?.textContent).toContain("Organize");
    expect(actionContext).toMatchObject({ machine: { id: "remote-a" }, projects: [project("project-a")], settings, project: project("project-a") });
    void actionContext?.selectProject(project("project-a"));
    expect(select).toHaveBeenCalledWith(project("project-a"));

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".action-menu-panel")).toBeNull();
  });

  it("only exposes draggable handles and keeps body clicks for selection and collapsing", async () => {
    const list = new ProjectList();
    const select = vi.fn();
    list.projects = [project("game")];
    list.onSelect = select;
    list.extension = {
      id: "organizer", group: () => "Game",
      onMoveProject: () => undefined, onMoveGroup: () => undefined,
    };
    document.body.append(list);
    await list.updateComplete;
    const row = list.shadowRoot?.querySelector<HTMLElement>(".action-row");
    const heading = list.shadowRoot?.querySelector<HTMLButtonElement>(".project-group > .section-toggle");
    if (!row || !heading) throw new Error("Expected project and group");
    expect([...(list.shadowRoot?.querySelectorAll<HTMLElement>("*") ?? [])].filter((element) => element.draggable))
      .toEqual([dragHandle(heading), dragHandle(row)]);

    const setData = vi.fn();
    for (const target of [row, row.querySelector(".workspace-primary-label"), row.querySelector(".action-menu-toggle"), heading, heading.querySelector(".section-name")]) {
      if (target === null) throw new Error("Expected non-handle drag target");
      const start = new Event("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(start, "dataTransfer", { value: { setData } });
      target.dispatchEvent(start);
      expect(start.defaultPrevented).toBe(true);
    }
    expect(setData).not.toHaveBeenCalled();
    dragHandle(row).click();
    dragHandle(heading).click();
    await list.updateComplete;
    expect(select).not.toHaveBeenCalled();
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    row.querySelector<HTMLElement>(".workspace-primary-label")?.click();
    expect(select).toHaveBeenCalledWith(project("game"));
    heading.click();
    await list.updateComplete;
    expect(heading.getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["touch", "pen"])("only starts %s long-press drags from project and group handles", async (pointerType) => {
    vi.useFakeTimers();
    const list = new ProjectList();
    list.projects = [project("game")];
    list.extension = {
      id: "organizer", group: () => "Game",
      onMoveProject: () => undefined, onMoveGroup: () => undefined,
    };
    document.body.append(list);
    await list.updateComplete;
    const owners = list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row, .project-group > .section-toggle");
    if (owners === undefined) throw new Error("Expected drag owners");
    for (const owner of owners) {
      const down = () => new PointerEvent("pointerdown", { bubbles: true, pointerType, pointerId: 7 });
      owner.dispatchEvent(down());
      vi.advanceTimersByTime(300);
      expect(Reflect.get(list, "pointerDrag")).toBeUndefined();
      dragHandle(owner).dispatchEvent(down());
      vi.advanceTimersByTime(300);
      expect(Reflect.get(list, "pointerDrag")).toMatchObject({ active: true });
      owner.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 7 }));
      expect(Reflect.get(list, "pointerDrag")).toBeUndefined();
    }
  });

  it("does not render handles when the extension does not support moving", async () => {
    const list = new ProjectList();
    list.projects = [project("game")];
    list.extension = { id: "organizer", group: () => "Game" };
    document.body.append(list);
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".drag-handle")).toBeNull();
    expect([...(list.shadowRoot?.querySelectorAll<HTMLElement>("*") ?? [])].filter((element) => element.draggable)).toHaveLength(0);
  });

  it("delegates drag-and-drop to the extension for group drops", async () => {
    const moves: unknown[] = [];
    const list = new ProjectList();
    list.projects = [project("ungrouped"), project("game")];
    list.extension = {
      id: "organizer",
      group: (context) => context.project.name === "game" ? "Game" : undefined,
      onMoveProject: (context) => { moves.push(context); },
    };
    document.body.append(list);
    await list.updateComplete;

    const dragStart = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: { setData: vi.fn(), effectAllowed: "" } });
    list.shadowRoot?.querySelector<HTMLElement>(".action-row[title=\"/repo/ungrouped\"] .drag-handle")?.dispatchEvent(dragStart);
    list.shadowRoot?.querySelector<HTMLElement>(".project-group")?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));

    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ project: project("ungrouped"), target: { type: "group", group: "Game" } });
  });

  it("delegates project reordering with the visible drop position", async () => {
    const moves: unknown[] = [];
    const list = new ProjectList();
    list.projects = [project("project-a"), project("project-b")];
    list.extension = { id: "organizer", onMoveProject: (context) => { moves.push(context); } };
    document.body.append(list);
    await list.updateComplete;

    const rows = [...(list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row") ?? [])];
    const sourceRow = rows[0];
    const targetRow = rows[1];
    if (sourceRow === undefined || targetRow === undefined) throw new Error("Expected two project rows");
    const dataTransfer = { setData: vi.fn(), getData: () => "project-a", effectAllowed: "", dropEffect: "" };
    const dragStart = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    dragHandle(sourceRow).dispatchEvent(dragStart);
    const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(dragOver, { dataTransfer: { value: dataTransfer }, clientY: { value: -1 } });
    targetRow.dispatchEvent(dragOver);
    targetRow.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));

    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ project: project("project-a"), target: { type: "project", project: project("project-b"), position: "before" } });
  });

  it("commits the visible drop position when the drop lands past the shifted rows", async () => {
    const moves: unknown[] = [];
    const list = new ProjectList();
    list.projects = [project("project-a"), project("project-b")];
    list.extension = { id: "organizer", onMoveProject: (context) => { moves.push(context); } };
    document.body.append(list);
    await list.updateComplete;

    const rows = [...(list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row") ?? [])];
    const sourceRow = rows[0];
    const targetRow = rows[1];
    if (sourceRow === undefined || targetRow === undefined) throw new Error("Expected two project rows");
    const dataTransfer = { setData: vi.fn(), getData: () => "project-a", effectAllowed: "", dropEffect: "" };
    const dragStart = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    dragHandle(sourceRow).dispatchEvent(dragStart);
    const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(dragOver, { dataTransfer: { value: dataTransfer }, clientY: { value: -1 } });
    targetRow.dispatchEvent(dragOver);
    await list.updateComplete;
    // The placeholder shifts rows down, so a real release lands on the list
    // background instead of the row. The visible indicator must still win.
    list.shadowRoot?.querySelector<HTMLElement>(".list-body")?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));

    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ project: project("project-a"), target: { type: "project", project: project("project-b"), position: "before" } });
  });

  it("keeps the row indicator when background dragover lands in the placeholder gap", async () => {
    const list = new ProjectList();
    list.projects = [project("game-a"), project("game-b"), project("game-c")];
    list.extension = {
      id: "organizer",
      group: () => "Game",
      onMoveProject: () => undefined,
    };
    document.body.append(list);
    await list.updateComplete;

    const rows = () => [...(list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row:not(.project-drop-placeholder)") ?? [])];
    const rowFor = (name: string): HTMLElement => {
      const row = rows().find((candidate) => candidate.getAttribute("data-project-id") === name);
      if (row === undefined) throw new Error(`Expected a row for ${name}`);
      return row;
    };
    const dataTransfer = { setData: vi.fn(), getData: () => "game-c", effectAllowed: "", dropEffect: "" };
    const dragStart = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    dragHandle(rowFor("game-c")).dispatchEvent(dragStart);
    const dragOverTop = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(dragOverTop, { dataTransfer: { value: dataTransfer }, clientY: { value: -1 } });
    rowFor("game-a").dispatchEvent(dragOverTop);
    await list.updateComplete;
    expect(Reflect.get(list, "dropIndicator")).toMatchObject({ kind: "project", projectId: "game-a", position: "before" });

    // The placeholder shifts rows down, so the held cursor now reports over the
    // list background. That artifact must not clobber the visible indicator.
    const backgroundOver = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(backgroundOver, { dataTransfer: { value: dataTransfer }, clientX: { value: 0 }, clientY: { value: 0 } });
    list.shadowRoot?.querySelector<HTMLElement>(".project-group")?.dispatchEvent(backgroundOver);
    expect(Reflect.get(list, "dropIndicator")).toMatchObject({ kind: "project", projectId: "game-a", position: "before" });

    // Genuine hovers elsewhere still update the indicator.
    const dragOverMiddle = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(dragOverMiddle, { dataTransfer: { value: dataTransfer }, clientY: { value: 0 } });
    rowFor("game-b").dispatchEvent(dragOverMiddle);
    expect(Reflect.get(list, "dropIndicator")).toMatchObject({ kind: "project", projectId: "game-b", position: "after" });
  });

  it("keeps the row indicator on same-section background hover and switches across groups", async () => {
    const list = new ProjectList();
    list.projects = [project("game-a"), project("game-b"), project("game-c"), project("work-d")];
    list.extension = {
      id: "organizer",
      group: (context) => context.project.name.startsWith("game") ? "Game" : "Work",
      onMoveProject: () => undefined,
    };
    document.body.append(list);
    await list.updateComplete;

    const rect = (top: number, bottom: number) => ({
      top, bottom, left: 0, right: 300, height: bottom - top, width: 300, x: 0, y: top,
      toJSON: () => undefined,
    });
    const stubRect = (element: Element | null | undefined, top: number, bottom: number): void => {
      if (element === null || element === undefined) throw new Error("Expected an element to stub");
      Object.defineProperty(element, "getBoundingClientRect", { value: () => rect(top, bottom), configurable: true });
    };
    const rowFor = (name: string): HTMLElement => {
      const row = [...(list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row:not(.project-drop-placeholder)") ?? [])]
        .find((candidate) => candidate.getAttribute("data-project-id") === name);
      if (row === undefined) throw new Error(`Expected a row for ${name}`);
      return row;
    };
    stubRect(rowFor("game-a"), 8, 48);
    stubRect(rowFor("game-b"), 50, 90);
    stubRect(rowFor("game-c"), 92, 132);
    stubRect(rowFor("work-d"), 200, 240);
    const sectionFor = (group: string): HTMLElement => {
      const section = [...(list.shadowRoot?.querySelectorAll<HTMLElement>(".project-group") ?? [])]
        .find((candidate) => candidate.getAttribute("data-project-group") === group);
      if (section === undefined) throw new Error(`Expected a section for ${group}`);
      return section;
    };
    stubRect(sectionFor("Game"), 0, 140);
    stubRect(sectionFor("Work"), 180, 250);

    const dataTransfer = { setData: vi.fn(), getData: () => "game-c", effectAllowed: "", dropEffect: "" };
    const dragStart = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    dragHandle(rowFor("game-c")).dispatchEvent(dragStart);
    const dragOverTop = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(dragOverTop, { dataTransfer: { value: dataTransfer }, clientX: { value: 150 }, clientY: { value: 10 } });
    rowFor("game-a").dispatchEvent(dragOverTop);
    await list.updateComplete;
    expect(Reflect.get(list, "dropIndicator")).toMatchObject({ kind: "project", projectId: "game-a", position: "before" });
    const placeholder = list.shadowRoot?.querySelector<HTMLElement>(".project-drop-placeholder");
    stubRect(placeholder, 0, 8);

    // Margin gap inside the same section: layout-shift fallout, keep the rows.
    const gapOver = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(gapOver, { dataTransfer: { value: dataTransfer }, clientX: { value: 150 }, clientY: { value: 49 } });
    sectionFor("Game").dispatchEvent(gapOver);
    expect(Reflect.get(list, "dropIndicator")).toMatchObject({ kind: "project", projectId: "game-a", position: "before" });

    // Another group's background is a genuine cross-group intent.
    const otherGroupOver = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(otherGroupOver, { dataTransfer: { value: dataTransfer }, clientX: { value: 150 }, clientY: { value: 190 } });
    sectionFor("Work").dispatchEvent(otherGroupOver);
    expect(Reflect.get(list, "dropIndicator")).toMatchObject({ kind: "project-group", group: "Work" });
  });

  it("leaves mouse pointerdown alone so the native dragstart can fire", async () => {
    const moves: unknown[] = [];
    const list = new ProjectList();
    list.projects = [project("project-a"), project("project-b")];
    list.extension = { id: "organizer", onMoveProject: (context) => { moves.push(context); } };
    document.body.append(list);
    await list.updateComplete;

    const rows = [...(list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row") ?? [])];
    const sourceRow = rows[0];
    const targetRow = rows[1];
    if (sourceRow === undefined || targetRow === undefined) throw new Error("Expected two project rows");
    const pointerDown = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperties(pointerDown, { pointerType: { value: "mouse" }, pointerId: { value: 1 }, clientX: { value: 10 }, clientY: { value: 10 } });
    dragHandle(sourceRow).dispatchEvent(pointerDown);
    expect(Reflect.get(list, "pointerDrag")).toBeUndefined();

    const dataTransfer = { setData: vi.fn(), getData: () => "project-a", effectAllowed: "", dropEffect: "" };
    const dragStart = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    dragHandle(sourceRow).dispatchEvent(dragStart);
    // Browsers cancel the pointer stream when native dragging takes over.
    dragHandle(sourceRow).dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1, pointerType: "mouse" }));
    targetRow.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(moves).toHaveLength(1);

    // A second drop without an intervening dragend must still work.
    const dragStart2 = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStart2, "dataTransfer", { value: dataTransfer });
    dragHandle(targetRow).dispatchEvent(dragStart2);
    sourceRow.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(moves).toHaveLength(2);
  });

  it("starts the long-press fallback for touch pointerdown", async () => {
    const list = new ProjectList();
    list.projects = [project("project-a"), project("project-b")];
    list.extension = { id: "organizer", onMoveProject: () => undefined };
    document.body.append(list);
    await list.updateComplete;

    const sourceRow = list.shadowRoot?.querySelector<HTMLElement>(".action-row");
    if (sourceRow === undefined || sourceRow === null) throw new Error("Expected a project row");
    const pointerDown = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperties(pointerDown, { pointerType: { value: "touch" }, pointerId: { value: 7 }, clientX: { value: 10 }, clientY: { value: 10 } });
    dragHandle(sourceRow).dispatchEvent(pointerDown);
    expect(Reflect.get(list, "pointerDrag")).not.toBeUndefined();

    const pointerCancel = new Event("pointercancel", { bubbles: true, cancelable: true });
    Object.defineProperties(pointerCancel, { pointerId: { value: 7 } });
    sourceRow.dispatchEvent(pointerCancel);
    expect(Reflect.get(list, "pointerDrag")).toBeUndefined();
  });

  it("shows a project-sized placeholder at the native drag position and does not select after drag", async () => {
    const select = vi.fn();
    const list = new ProjectList();
    list.projects = [project("project-a"), project("project-b")];
    list.onSelect = select;
    list.extension = { id: "organizer", onMoveProject: () => undefined };
    document.body.append(list);
    await list.updateComplete;

    const rows = [...(list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row") ?? [])];
    const sourceRow = rows[0];
    const targetRow = rows[1];
    if (sourceRow === undefined || targetRow === undefined) throw new Error("Expected two project rows");
    expect(sourceRow.draggable).toBe(false);
    expect(dragHandle(sourceRow).draggable).toBe(true);
    const dataTransfer = { setData: vi.fn(), getData: () => "project-a", effectAllowed: "", dropEffect: "" };
    const dragStart = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    dragHandle(sourceRow).dispatchEvent(dragStart);
    const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(dragOver, { dataTransfer: { value: dataTransfer }, clientY: { value: 0 } });
    targetRow.dispatchEvent(dragOver);
    await list.updateComplete;

    const placeholder = list.shadowRoot?.querySelector<HTMLElement>(".project-drop-placeholder");
    expect(placeholder).not.toBeNull();
    expect(placeholder?.querySelector(".action-main")).not.toBeNull();

    sourceRow.dispatchEvent(new Event("dragend", { bubbles: true }));
    sourceRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(select).not.toHaveBeenCalled();
  });

  it("delegates group reordering and shows its drop placeholder", async () => {
    const moves: unknown[] = [];
    const list = new ProjectList();
    list.projects = [project("game"), project("infra")];
    list.extension = {
      id: "organizer",
      group: (context) => context.project.name === "game" ? "Game" : "Infra",
      onMoveGroup: (context) => { moves.push(context); },
    };
    document.body.append(list);
    await list.updateComplete;

    const headings = [...(list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".project-group > .section-toggle") ?? [])];
    const sourceHeading = headings[0];
    const targetHeading = headings[1];
    if (sourceHeading === undefined || targetHeading === undefined) throw new Error("Expected two group headings");
    expect(sourceHeading.draggable).toBe(false);
    expect(dragHandle(sourceHeading).draggable).toBe(true);
    const dataTransfer = { setData: vi.fn(), getData: () => "Game", effectAllowed: "", dropEffect: "" };
    const dragStart = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    dragHandle(sourceHeading).dispatchEvent(dragStart);
    dragHandle(sourceHeading).dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1, pointerType: "mouse" }));
    const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(dragOver, { dataTransfer: { value: dataTransfer }, clientY: { value: -1 } });
    targetHeading.dispatchEvent(dragOver);
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".project-drop-placeholder")).not.toBeNull();
    const targetGroup = targetHeading.parentElement;
    if (targetGroup === null) throw new Error("Expected target group");
    targetGroup.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ group: "Game", targetGroup: "Infra", position: "before" });
  });

  it("renders grouped projects with collapsible group headings while keeping host rows", async () => {
    const list = new ProjectList();
    list.projects = [project("game-a"), project("game-b"), project("infra")];
    list.selected = project("game-a");
    list.extension = {
      id: "organizer",
      group: (context) => context.project.name.startsWith("game") ? "Game" : undefined,
    };
    document.body.append(list);
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".project-group .section-toggle")?.textContent).toContain("Game");
    expect(list.shadowRoot?.querySelectorAll(".project-group .action-row")).toHaveLength(2);
    expect(list.shadowRoot?.querySelectorAll(".list-body > .action-row")).toHaveLength(1);

    list.shadowRoot?.querySelector<HTMLButtonElement>(".project-group .section-toggle")?.click();
    await list.updateComplete;
    expect(list.shadowRoot?.querySelectorAll(".project-group .action-row")).toHaveLength(0);
    expect(list.shadowRoot?.querySelector(".project-group .section-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(list.shadowRoot?.querySelector(".project-group .section-selected")?.textContent).toContain("game-a");
  });
});

describe("project status indicator", () => {
  it("shows an unread dot only on projects the snapshot reports as unread", async () => {
    const list = await mountProjectList(
      [project("project-a"), project("project-b")],
      machineStatusSnapshot({ projects: { "project-b": { "core:unread": true } } }),
    );

    expect(unreadDot(rowFor(list, "project-a"))).toBeNull();
    const dot = unreadDot(rowFor(list, "project-b"));
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("title")).toBe("Unread sessions in this project");
  });

  it("clears the dot once a newer snapshot reports nothing unread", async () => {
    const list = await mountProjectList([project("project-a")], machineStatusSnapshot({ projects: { "project-a": { "core:unread": true } } }));
    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).not.toBeNull();

    list.statusSnapshot = machineStatusSnapshot({ revision: 2 });
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("wraps the work dot in an unread ring when the project is busy and unread", async () => {
    const list = await mountProjectList(
      [project("project-a")],
      machineStatusSnapshot({ projects: { "project-a": { "core:working": true, "core:unread": true } } }),
    );

    const row = rowFor(list, "project-a");
    const ring = row.querySelector(".unread-ring");
    expect(ring?.querySelector(".activity-indicator.session")).not.toBeNull();
    expect(ring?.getAttribute("title")).toBe("Unread sessions in this project · Project active");
    expect(row.querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("lights a project whose workspaces have never been opened, for work and for unread", async () => {
    // The row reads the server-attributed snapshot, so it no longer depends on
    // the browser having loaded that project's workspaces.
    const list = await mountProjectList(
      [project("unvisited-work"), project("unvisited-unread")],
      machineStatusSnapshot({
        projects: { "unvisited-work": { "core:working": true }, "unvisited-unread": { "core:unread": true } },
      }),
    );

    expect(rowFor(list, "unvisited-work").querySelector(".activity-indicator.session")).not.toBeNull();
    expect(unreadDot(rowFor(list, "unvisited-unread"))).not.toBeNull();
  });

  it("shows no indicator when the machine publishes no snapshot", async () => {
    const list = await mountProjectList([project("project-a")], undefined);

    expect(rowFor(list, "project-a").querySelector(".activity-indicator")).toBeNull();
  });

  it("still lights a row from a flag id this build does not know", async () => {
    const list = await mountProjectList([project("project-a")], machineStatusSnapshot({ projects: { "project-a": { "core:future": true } } }));

    expect(rowFor(list, "project-a").querySelector(".activity-indicator.session")).not.toBeNull();
  });
});

async function mountProjectList(projects: Project[], statusSnapshot: MachineStatusSnapshot | undefined): Promise<ProjectList> {
  const list = new ProjectList();
  list.projects = projects;
  list.statusSnapshot = statusSnapshot;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function rowFor(list: ProjectList, projectName: string): Element {
  const rows = [...(list.shadowRoot?.querySelectorAll(".action-row") ?? [])];
  const row = rows.find((candidate) => candidate.textContent.includes(projectName));
  if (row === undefined) throw new Error(`Expected a project row for ${projectName}`);
  return row;
}

function unreadDot(row: Element): Element | null {
  return row.querySelector(".activity-indicator.unread");
}

function dragHandle(owner: Element): HTMLElement {
  const handle = owner.querySelector<HTMLElement>(".drag-handle");
  if (handle === null) throw new Error("Expected a drag handle");
  return handle;
}

function project(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2026-06-04T00:00:00.000Z" };
}
