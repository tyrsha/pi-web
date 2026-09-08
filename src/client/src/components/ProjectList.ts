import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Project } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import type { PluginMachine, PluginSettings, ProjectListActionContext, ProjectListContribution, ProjectListContext, ProjectListGroupMoveContext, ProjectListMoveContext } from "../plugins/types";
import { actionMenuPanelStyle } from "./actionMenu";
import { hasStatusUnread, renderActionActivityIndicator, statusActivityKind } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles } from "./shared";

@customElement("project-list")
export class ProjectList extends LitElement implements KeyboardNavigableSection {
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selected?: Project;
  /** Status tree of the machine these projects belong to; absent means no indicators. */
  @property({ attribute: false }) statusSnapshot: MachineStatusSnapshot | undefined;
  @property({ attribute: false }) machine: PluginMachine = { id: "local", name: "local", kind: "local" };
  @property({ attribute: false }) settings: PluginSettings | undefined;
  @property({ attribute: false }) extension: ProjectListContribution | undefined;
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onSelect?: (project: Project) => void;
  @property({ attribute: false }) onClose?: (project: Project) => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onFocusPreviousSection?: () => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @state() private openMenuProjectId: string | undefined;
  @state() private menuStyle = "";
  @state() private collapsedProjectGroups = new Set<string>();
  @state() private dropIndicator: ProjectListDropIndicator | undefined;
  private draggedProjectId: string | undefined;
  private draggedGroup: string | undefined;
  private nativeDragActive = false;
  private pointerDrag: { kind: "project"; projectId: string; pointerId: number; pointerType: string; startX: number; startY: number; timer: number; active: boolean } | { kind: "group"; group: string; pointerId: number; pointerType: string; startX: number; startY: number; timer: number; active: boolean } | undefined;
  private suppressNextClick = false;
  private readonly onDocumentClick = (event: MouseEvent) => {
    if (event.composedPath().includes(this)) return;
    this.openMenuProjectId = undefined;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick, true);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick, true);
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("projects") && this.openMenuProjectId !== undefined && !this.projects.some((project) => project.id === this.openMenuProjectId)) this.openMenuProjectId = undefined;
    if (changed.has("collapsed") && this.collapsed) this.openMenuProjectId = undefined;
  }

  async focusSelectedOrFirst(): Promise<boolean> {
    await this.updateComplete;
    return focusSelectedOrFirstSelectableRow(this.renderRoot, { fallbackSelector: ".section-toggle" });
  }

  override render() {
    return html`
      <section>
        <h2>${this.renderHeading()}</h2>
        ${this.collapsed ? null : html`
          <div
            class="list-body"
            @dragover=${(event: DragEvent) => { this.handleListDragOver(event); }}
            @drop=${(event: DragEvent) => { this.handleListDrop(event); }}
          >
            ${this.renderProjects()}
          </div>
        `}
      </section>
    `;
  }

  private renderProjects() {
    const groups = new Map<string, Project[]>();
    const ungrouped: Project[] = [];
    for (const project of this.projects) {
      const group = this.extension?.group?.(this.projectListActionContext(project));
      if (group === undefined || group.trim() === "") ungrouped.push(project);
      else groups.set(group, [...(groups.get(group) ?? []), project]);
    }
    if (groups.size === 0) return this.sortProjects(ungrouped).map((project) => this.renderProject(project));
    const projectListContext = this.projectListContext();
    return [
      ...[...groups].sort(([left], [right]) => this.groupOrder(left, right, projectListContext)).flatMap(([group, projects]) => [
        this.renderGroupDropIndicator(group, "before"),
        this.renderGroup(group, projects),
        this.renderGroupDropIndicator(group, "after"),
      ]),
      ...this.sortProjects(ungrouped).map((project) => this.renderProject(project)),
    ];
  }

  private renderGroup(group: string, projects: readonly Project[]) {
    const collapsed = this.collapsedProjectGroups.has(group);
    const selectedProject = this.selected !== undefined && projects.some((project) => project.id === this.selected?.id) ? this.selected : undefined;
    const dropTarget = this.dropIndicator?.kind === "project-group" && this.dropIndicator.group === group;
    return html`
      <section
        class=${`project-group ${dropTarget ? "drop-target" : ""}`}
        data-project-group=${group}
        @dragover=${(event: DragEvent) => { this.handleGroupDragOver(event, group); }}
        @drop=${(event: DragEvent) => { this.handleGroupDrop(event, group); }}
      >
        <button
          class="section-toggle"
          aria-expanded=${String(!collapsed)}
          .draggable=${false}
          @dragstart=${(event: DragEvent) => { this.handleGroupDragStart(event, group); }}
          @dragover=${(event: DragEvent) => { this.handleGroupDragOver(event, group); }}
          @drop=${(event: DragEvent) => { this.handleGroupDrop(event, group); }}
          @dragend=${() => { this.handleNativeDragEnd(); }}
          @click=${() => { this.handleProjectGroupClick(group); }}
          @pointerdown=${(event: PointerEvent) => { this.handleGroupPointerDown(event, group); }}
          @pointermove=${(event: PointerEvent) => { this.handlePointerMove(event); }}
          @pointerup=${(event: PointerEvent) => { this.handlePointerUp(event); }}
          @pointercancel=${(event: PointerEvent) => { this.handlePointerCancel(event); }}
        >
          ${this.extension?.onMoveGroup !== undefined ? this.renderDragHandle(`Drag group ${group}`) : null}
          <span class="section-title">
            <span class="section-name">${collapsed ? "▸" : "▾"} ${group}</span>
            ${collapsed && selectedProject !== undefined ? html`<small class="section-selected" title=${selectedProject.path}>${selectedProject.name}</small>` : null}
          </span>
          <small class="section-count">${projects.length}</small>
        </button>
        ${collapsed ? null : this.sortProjects(projects).map((project) => this.renderProject(project))}
      </section>
    `;
  }

  private renderGroupDropIndicator(group: string, position: "before" | "after") {
    return this.dropIndicator?.kind === "group" && this.dropIndicator.group === group && this.dropIndicator.position === position
      ? this.renderDropPlaceholder()
      : null;
  }

  private groupOrder(left: string, right: string, context: ProjectListContext): number {
    const order = this.extension?.groupOrder;
    if (order === undefined) return left.localeCompare(right);
    return (order(left, context) ?? Number.MAX_SAFE_INTEGER) - (order(right, context) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right);
  }

  private sortProjects(projects: readonly Project[]): Project[] {
    const sort = this.extension?.sort;
    if (sort === undefined) return [...projects];
    return [...projects].sort((left, right) => {
      const leftOrder = sort(this.projectListActionContext(left)) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = sort(this.projectListActionContext(right)) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || this.projects.indexOf(left) - this.projects.indexOf(right);
    });
  }

  private renderProject(project: Project) {
    const draggable = this.extension?.onMoveProject !== undefined;
    return html`
      ${this.projectDropIndicator(project, "before")}
      <div
        class=${`action-row ${this.selected?.id === project.id ? "selected" : ""} ${this.draggedProjectId === project.id ? "dragging" : ""}`}
        data-project-id=${project.id}
        tabindex="0"
        title=${project.path}
        .draggable=${false}
        @dragstart=${(event: DragEvent) => { this.handleDragStart(event, project); }}
        @dragover=${(event: DragEvent) => { this.handleProjectDragOver(event, project); }}
        @drop=${(event: DragEvent) => { this.handleProjectDrop(event, project); }}
        @dragend=${() => { this.handleNativeDragEnd(); }}
        @pointerdown=${(event: PointerEvent) => { this.handlePointerDown(event, project); }}
        @pointermove=${(event: PointerEvent) => { this.handlePointerMove(event); }}
        @pointerup=${(event: PointerEvent) => { this.handlePointerUp(event); }}
        @pointercancel=${(event: PointerEvent) => { this.handlePointerCancel(event); }}
        @click=${(event: MouseEvent) => { this.handleProjectClick(event, project); }}
        @keydown=${(event: KeyboardEvent) => { this.handleProjectKeydown(event, project); }}
      >
        <div class=${`action-main ${draggable ? "has-drag-handle" : ""}`}>
          ${draggable ? this.renderDragHandle(`Drag project ${project.name}`) : null}
          <span class="workspace-primary"><span class="workspace-primary-label">${project.name}</span></span><small>${project.path}</small>
          ${this.renderActivity(project)}
        </div>
        <div class="action-menu">
          <button class="action-menu-toggle" title="Project actions" aria-label=${`Actions for ${project.name}`} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(project.id, event.currentTarget); }}>⋯</button>
          ${this.openMenuProjectId === project.id ? html`
            <div class="action-menu-panel" style=${this.menuStyle}>
              ${this.extension?.renderActions?.(this.projectListActionContext(project))}
              <button title="Close project" @click=${() => { this.close(project); }}>Close</button>
            </div>
          ` : null}
        </div>
      </div>
        ${this.projectDropIndicator(project, "after")}
    `;
  }

  private renderDragHandle(label: string) {
    return html`<span
      class="drag-handle"
      role="img"
      aria-label=${label}
      title=${label}
      .draggable=${true}
      @click=${(event: MouseEvent) => { event.stopPropagation(); }}
    >⠿</span>`;
  }

  private isDragHandleEvent(event: Event): boolean {
    return event.target instanceof Element && event.target.closest(".drag-handle") !== null;
  }

  private projectDropIndicator(project: Project, position: "before" | "after") {
    return this.dropIndicator?.kind === "project" && this.dropIndicator.projectId === project.id && this.dropIndicator.position === position
      ? this.renderDropPlaceholder()
      : null;
  }

  private renderDropPlaceholder() {
    return html`
      <div class="action-row project-drop-placeholder" aria-hidden="true">
        <div class="action-main">
          <span class="workspace-primary"><span class="workspace-primary-label">Drop here</span></span>
          <small>Release to move here</small>
        </div>
        <div class="action-menu"><div class="action-menu-toggle"></div></div>
      </div>
    `;
  }

  private handleProjectClick(event: MouseEvent, project: Project): void {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    activateSelectableRow(event, () => { this.select(project); });
  }

  private handlePointerDown(event: PointerEvent, project: Project): void {
    if (this.extension?.onMoveProject === undefined) return;
    // Mouse uses native HTML5 drag-and-drop. Claiming the pointer here (or
    // starting a pending custom drag) suppresses the native dragstart, so
    // only touch/pen go through the long-press fallback.
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    if (!this.isDragHandleEvent(event)) return;
    this.beginPointerDrag(event, { kind: "project", projectId: project.id });
  }

  private handleGroupPointerDown(event: PointerEvent, group: string): void {
    if (this.extension?.onMoveGroup === undefined || !this.isDragHandleEvent(event)) return;
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    this.beginPointerDrag(event, { kind: "group", group });
  }

  private beginPointerDrag(event: PointerEvent, drag: { kind: "project"; projectId: string } | { kind: "group"; group: string }): void {
    this.cancelPointerDrag();
    if ((event.pointerType === "touch" || event.pointerType === "pen") && event.currentTarget instanceof HTMLElement) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is best-effort; the coordinate-based drop still works.
      }
    }
    this.pointerDrag = {
      ...drag,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      timer: window.setTimeout(() => {
        this.activatePointerDrag(event.pointerId);
      }, 250),
    };
  }

  private handlePointerMove(event: PointerEvent): void {
    const drag = this.pointerDrag;
    if (drag === undefined) return;
    if (!drag.active) {
      if (drag.pointerType !== "mouse" || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
      this.activatePointerDrag(event.pointerId);
    }
    if (this.pointerDrag?.active !== true) return;
    event.preventDefault();
    if (drag.kind === "project") {
      const project = this.projects.find((candidate) => candidate.id === drag.projectId);
      if (project !== undefined) this.updateProjectDropIndicatorAtPoint(project, event.clientX, event.clientY);
    } else {
      this.updateGroupDropIndicatorAtPoint(drag.group, event.clientX, event.clientY);
    }
  }

  private handlePointerUp(event: PointerEvent): void {
    const drag = this.pointerDrag;
    if (drag === undefined) return;
    window.clearTimeout(drag.timer);
    this.pointerDrag = undefined;
    if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!drag.active) return;
    event.preventDefault();
    if (this.commitIndicatorDrop()) {
      // The indicator already describes the intended position; nothing more to resolve.
    } else if (drag.kind === "project") {
      const project = this.projects.find((candidate) => candidate.id === drag.projectId);
      if (project !== undefined) this.dropAtPoint(project, event.clientX, event.clientY);
    } else {
      this.dropGroupAtPoint(drag.group, event.clientX, event.clientY);
    }
    this.suppressNextClick = true;
    window.setTimeout(() => { this.suppressNextClick = false; }, 0);
    this.clearDragState();
  }

  private handlePointerCancel(event: PointerEvent): void {
    // Native mouse dragstart also emits pointercancel; only cancel a custom drag.
    if (this.pointerDrag === undefined) return;
    if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    this.cancelPointerDrag();
  }

  private activatePointerDrag(pointerId: number): void {
    const drag = this.pointerDrag;
    if (drag?.pointerId !== pointerId) return;
    if (drag.active) return;
    window.clearTimeout(drag.timer);
    drag.active = true;
    if (drag.kind === "project") this.draggedProjectId = drag.projectId;
    else this.draggedGroup = drag.group;
    this.requestUpdate();
  }

  private cancelPointerDrag(): void {
    this.cancelPendingPointerDrag();
    this.clearDragState();
  }

  private cancelPendingPointerDrag(): void {
    if (this.pointerDrag !== undefined) window.clearTimeout(this.pointerDrag.timer);
    this.pointerDrag = undefined;
  }

  private isInsideDropPlaceholder(clientX: number, clientY: number): boolean {
    const placeholder = this.renderRoot.querySelector<HTMLElement>(".project-drop-placeholder");
    return placeholder !== null && containsPoint(placeholder, clientX, clientY);
  }

  private indicatorProjectGroup(): string | undefined {
    const indicator = this.dropIndicator;
    if (indicator?.kind !== "project") return undefined;
    const rows = [...this.renderRoot.querySelectorAll<HTMLElement>(".action-row:not(.project-drop-placeholder)")];
    const target = rows.find((row) => row.dataset["projectId"] === indicator.projectId);
    return target?.closest(".project-group")?.getAttribute("data-project-group") ?? undefined;
  }

  private isSameGroupAsIndicator(group: string): boolean {
    return this.indicatorProjectGroup() === group;
  }

  private updateProjectDropIndicatorAtPoint(project: Project, clientX: number, clientY: number): void {
    if (this.isInsideDropPlaceholder(clientX, clientY)) return;
    const targetRow = [...this.renderRoot.querySelectorAll<HTMLElement>(".action-row:not(.project-drop-placeholder)")].find((row) => containsPoint(row, clientX, clientY));
    if (targetRow !== undefined) {
      const targetProjectId = targetRow.dataset["projectId"];
      if (targetProjectId === project.id || targetProjectId === undefined) {
        this.setDropIndicator(undefined);
        return;
      }
      const rect = targetRow.getBoundingClientRect();
      this.setDropIndicator({ kind: "project", projectId: targetProjectId, position: clientY < rect.top + rect.height / 2 ? "before" : "after" });
      return;
    }
    const groupElement = [...this.renderRoot.querySelectorAll<HTMLElement>(".project-group")].find((group) => containsPoint(group, clientX, clientY));
    const group = groupElement?.dataset["projectGroup"];
    if (group === undefined) {
      this.setDropIndicator(undefined);
      return;
    }
    // A background hover inside the indicated target's own group section is
    // usually fallout from our placeholder shifting layout under a held
    // cursor, not a move-to-end-of-group intent. Hovers over other groups
    // still switch the indicator so cross-group drops keep working.
    if (this.isSameGroupAsIndicator(group)) return;
    this.setDropIndicator({ kind: "project-group", group });
  }

  private updateGroupDropIndicatorAtPoint(group: string, clientX: number, clientY: number): void {
    const target = this.groupHeadingAtPoint(clientX, clientY);
    const targetGroup = target?.parentElement?.dataset["projectGroup"];
    if (targetGroup === undefined || targetGroup === group || target === undefined) {
      this.setDropIndicator(undefined);
      return;
    }
    const rect = target.getBoundingClientRect();
    this.setDropIndicator({ kind: "group", group: targetGroup, position: clientY < rect.top + rect.height / 2 ? "before" : "after" });
  }

  private groupHeadingFor(groupName: string): HTMLElement | undefined {
    const group = [...this.renderRoot.querySelectorAll<HTMLElement>(".project-group")].find((candidate) => candidate.dataset["projectGroup"] === groupName);
    return group?.querySelector<HTMLElement>(".section-toggle") ?? undefined;
  }

  private groupHeadingAtPoint(clientX: number, clientY: number): HTMLElement | undefined {
    const headings = [...this.renderRoot.querySelectorAll<HTMLElement>(".project-group > .section-toggle")];
    const heading = headings.find((candidate) => containsPoint(candidate, clientX, clientY));
    if (heading !== undefined) return heading;
    const group = [...this.renderRoot.querySelectorAll<HTMLElement>(".project-group")].find((candidate) => containsPoint(candidate, clientX, clientY));
    return group?.querySelector<HTMLElement>(".section-toggle") ?? undefined;
  }

  private setDropIndicator(indicator: ProjectListDropIndicator | undefined): void {
    if (sameDropIndicator(this.dropIndicator, indicator)) return;
    this.dropIndicator = indicator;
    this.requestUpdate();
  }

  private clearDragState(): void {
    this.draggedProjectId = undefined;
    this.draggedGroup = undefined;
    this.setDropIndicator(undefined);
  }

  private dropGroupAtPoint(group: string, clientX: number, clientY: number): void {
    if (this.extension?.onMoveGroup === undefined) return;
    const target = this.groupHeadingAtPoint(clientX, clientY);
    const targetGroup = target?.parentElement?.dataset["projectGroup"];
    if (targetGroup === undefined || targetGroup === group || target === undefined) return;
    const rect = target.getBoundingClientRect();
    const position = clientY < rect.top + rect.height / 2 ? "before" : "after";
    this.moveGroup(group, targetGroup, position);
  }

  private dropAtPoint(project: Project, clientX: number, clientY: number): void {
    const rows = [...this.renderRoot.querySelectorAll<HTMLElement>(".action-row:not(.project-drop-placeholder)")];
    const targetRow = rows.find((row) => containsPoint(row, clientX, clientY));
    if (targetRow !== undefined) {
      const targetProject = this.projects.find((candidate) => candidate.id === targetRow.dataset["projectId"]);
      if (targetProject === undefined || targetProject.id === project.id) return;
      const rect = targetRow.getBoundingClientRect();
      this.moveProject(project, { type: "project", project: targetProject, position: clientY < rect.top + rect.height / 2 ? "before" : "after" });
      return;
    }
    const groupElement = [...this.renderRoot.querySelectorAll<HTMLElement>(".project-group")].find((group) => containsPoint(group, clientX, clientY));
    const group = groupElement?.dataset["projectGroup"];
    if (group !== undefined) this.moveProject(project, { type: "group", group });
  }

  private handleDragStart(event: DragEvent, project: Project): void {
    if (this.extension?.onMoveProject === undefined || !this.isDragHandleEvent(event)) {
      event.preventDefault();
      return;
    }
    this.cancelPendingPointerDrag();
    this.draggedProjectId = project.id;
    this.nativeDragActive = true;
    event.dataTransfer?.setData("text/plain", project.id);
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
  }

  private handleGroupDragStart(event: DragEvent, group: string): void {
    if (this.extension?.onMoveGroup === undefined || !this.isDragHandleEvent(event)) {
      event.preventDefault();
      return;
    }
    this.cancelPendingPointerDrag();
    this.draggedGroup = group;
    this.nativeDragActive = true;
    event.dataTransfer?.setData("text/plain", group);
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
  }

  private handleNativeDragEnd(): void {
    const wasDragging = this.nativeDragActive;
    this.nativeDragActive = false;
    this.clearDragState();
    if (!wasDragging) return;
    this.suppressNextClick = true;
    window.setTimeout(() => { this.suppressNextClick = false; }, 0);
  }

  private handleDragOver(event: DragEvent): void {
    if (this.extension?.onMoveProject === undefined && this.extension?.onMoveGroup === undefined) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
  }

  private handleListDragOver(event: DragEvent): void {
    if (event.target instanceof Element && event.target.closest(".action-row, .section-toggle") !== null) return;
    this.handleDragOver(event);
    if (this.draggedGroup !== undefined && this.extension?.onMoveGroup !== undefined) {
      const heading = [...this.renderRoot.querySelectorAll<HTMLElement>(".project-group > .section-toggle")].find((candidate) => containsPoint(candidate, event.clientX, event.clientY));
      const group = heading?.parentElement?.dataset["projectGroup"];
      if (heading !== undefined && group !== undefined && group !== this.draggedGroup) {
        const rect = heading.getBoundingClientRect();
        this.setDropIndicator({ kind: "group", group, position: event.clientY < rect.top + rect.height / 2 ? "before" : "after" });
      } else {
        this.setDropIndicator(undefined);
      }
      return;
    }
    if (this.draggedProjectId !== undefined && this.extension?.onMoveProject !== undefined) {
      const project = this.projects.find((candidate) => candidate.id === this.draggedProjectId);
      if (project !== undefined) this.updateProjectDropIndicatorAtPoint(project, event.clientX, event.clientY);
    }
  }

  private projectForDropIndicator(): Project | undefined {
    if (this.draggedProjectId === undefined) return undefined;
    return this.projects.find((project) => project.id === this.draggedProjectId);
  }

  private commitIndicatorDrop(): boolean {
    const indicator = this.dropIndicator;
    if (indicator === undefined) return false;
    if (indicator.kind === "project") {
      const dragged = this.projectForDropIndicator();
      const target = this.projects.find((project) => project.id === indicator.projectId);
      if (dragged === undefined || target === undefined || dragged.id === target.id) return false;
      this.moveProject(dragged, { type: "project", project: target, position: indicator.position });
    } else if (indicator.kind === "group") {
      if (this.draggedGroup === undefined || this.draggedGroup === indicator.group || this.extension?.onMoveGroup === undefined) return false;
      this.moveGroup(this.draggedGroup, indicator.group, indicator.position);
    } else {
      const dragged = this.projectForDropIndicator();
      if (dragged === undefined || this.extension?.onMoveProject === undefined) return false;
      this.moveProject(dragged, { type: "group", group: indicator.group });
    }
    this.draggedProjectId = undefined;
    this.draggedGroup = undefined;
    this.setDropIndicator(undefined);
    return true;
  }

  private handleListDrop(event: DragEvent): void {
    if (this.commitIndicatorDrop()) {
      event.preventDefault();
      return;
    }
    if (event.target instanceof Element && event.target.closest(".action-row, .section-toggle") !== null) return;
    if (this.draggedGroup !== undefined) {
      this.setDropIndicator(undefined);
      return;
    }
    const project = this.projects.find((candidate) => candidate.id === this.draggedProjectId);
    if (project === undefined || this.extension?.onMoveProject === undefined) return;
    const groupElement = [...this.renderRoot.querySelectorAll<HTMLElement>(".project-group")].find((candidate) => containsPoint(candidate, event.clientX, event.clientY));
    const group = groupElement?.dataset["projectGroup"];
    if (group === undefined) return;
    event.preventDefault();
    this.moveProject(project, { type: "group", group });
    this.setDropIndicator(undefined);
  }

  private handleProjectDragOver(event: DragEvent, targetProject: Project): void {
    this.handleDragOver(event);
    if (this.draggedGroup !== undefined) return;
    if (event.currentTarget instanceof HTMLElement) event.stopPropagation();
    if (this.extension?.onMoveProject === undefined) return;
    const draggedId = this.draggedProjectId ?? event.dataTransfer?.getData("text/plain");
    if (draggedId === undefined || draggedId === targetProject.id) {
      this.setDropIndicator(undefined);
      return;
    }
    const row = event.currentTarget;
    const rect = row instanceof HTMLElement ? row.getBoundingClientRect() : undefined;
    const position = rect !== undefined && event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    this.setDropIndicator({ kind: "project", projectId: targetProject.id, position });
  }

  private handleGroupDragOver(event: DragEvent, group: string): void {
    const isHeading = event.currentTarget instanceof HTMLElement && event.currentTarget.classList.contains("section-toggle");
    if (isHeading) event.stopPropagation();
    this.handleDragOver(event);
    if (this.draggedGroup !== undefined && this.extension?.onMoveGroup !== undefined) {
      if (group === this.draggedGroup) {
        this.setDropIndicator(undefined);
        return;
      }
      const target = isHeading ? event.currentTarget : this.groupHeadingFor(group);
      const rect = target?.getBoundingClientRect();
      const position = rect !== undefined && event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      this.setDropIndicator({ kind: "group", group, position });
    } else if (this.draggedProjectId !== undefined && this.extension?.onMoveProject !== undefined
      && !(event.target instanceof Element && event.target.closest(".action-row") !== null)) {
      if (this.isInsideDropPlaceholder(event.clientX, event.clientY)) return;
      if (this.isSameGroupAsIndicator(group)) return;
      this.setDropIndicator({ kind: "project-group", group });
    }
  }

  private handleProjectDrop(event: DragEvent, targetProject: Project): void {
    if (this.draggedGroup !== undefined || this.extension?.onMoveProject === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const draggedProject = this.draggedProject(event);
    if (draggedProject === undefined || draggedProject.id === targetProject.id) return;
    const indicator = this.dropIndicator;
    const element = event.currentTarget;
    const midpoint = element instanceof HTMLElement ? element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2 : 0;
    const position = indicator?.kind === "project" && indicator.projectId === targetProject.id
      ? indicator.position
      : event.clientY < midpoint ? "before" : "after";
    this.moveProject(draggedProject, { type: "project", project: targetProject, position });
    this.draggedProjectId = undefined;
    this.setDropIndicator(undefined);
  }

  private handleGroupDrop(event: DragEvent, group: string): void {
    event.stopPropagation();
    if (this.draggedGroup !== undefined && this.extension?.onMoveGroup !== undefined) {
      event.preventDefault();
      const sourceGroup = this.draggedGroup;
      if (sourceGroup === group) return;
      const heading = this.groupHeadingFor(group);
      const rect = heading?.getBoundingClientRect();
      const position = this.dropIndicator?.kind === "group" && this.dropIndicator.group === group
        ? this.dropIndicator.position
        : rect !== undefined && event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      this.moveGroup(sourceGroup, group, position);
      this.draggedGroup = undefined;
      this.setDropIndicator(undefined);
      return;
    }
    if (this.extension?.onMoveProject === undefined) return;
    event.preventDefault();
    if (this.commitIndicatorDrop()) return;
    const draggedProject = this.draggedProject(event);
    if (draggedProject === undefined) return;
    this.moveProject(draggedProject, { type: "group", group });
    this.draggedProjectId = undefined;
    this.setDropIndicator(undefined);
  }

  private draggedProject(event: DragEvent): Project | undefined {
    const id = this.draggedProjectId ?? event.dataTransfer?.getData("text/plain");
    return this.projects.find((project) => project.id === id);
  }

  private moveProject(project: Project, target: ProjectListMoveContext["target"]): void {
    const extension = this.extension;
    if (extension?.onMoveProject === undefined) return;
    void extension.onMoveProject({ ...this.projectListContext(), project, target });
  }

  private moveGroup(group: string, targetGroup: string, position: "before" | "after"): void {
    const extension = this.extension;
    if (extension?.onMoveGroup === undefined) return;
    const context: ProjectListGroupMoveContext = { ...this.projectListContext(), group, targetGroup, position };
    void extension.onMoveGroup(context);
  }

  private handleProjectGroupClick(group: string): void {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    this.toggleProjectGroup(group);
  }

  private toggleProjectGroup(group: string): void {
    const next = new Set(this.collapsedProjectGroups);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    this.collapsedProjectGroups = next;
  }

  private projectListContext(): ProjectListContext {
    return {
      machine: this.machine,
      settings: this.settings ?? unavailableProjectListSettings,
      projects: this.projects,
      ...(this.selected === undefined ? {} : { selectedProject: this.selected }),
      selectProject: (project) => { this.select(project); },
      requestCloseProject: (project) => { this.close(project); },
      requestRender: () => { this.requestUpdate(); },
    };
  }

  private projectListActionContext(project: Project): ProjectListActionContext {
    return { ...this.projectListContext(), project };
  }

  private select(project: Project): void {
    const context = this.projectListActionContext(project);
    if (this.extension?.onSelect !== undefined) void this.extension.onSelect(context);
    if (this.onSelect !== undefined) this.onSelect(project);
  }

  private handleProjectKeydown(event: KeyboardEvent, project: Project): void {
    handleSelectableRowKeyboard(event, {
      activate: () => { this.select(project); },
      previousSection: this.onFocusPreviousSection === undefined ? undefined : () => { void this.onFocusPreviousSection?.(); },
      nextSection: this.onFocusNextSection === undefined ? undefined : () => { void this.onFocusNextSection?.(); },
      cancel: this.onCancelKeyboardNavigation === undefined ? undefined : () => { void this.onCancelKeyboardNavigation?.(); },
    });
  }

  private renderHeading() {
    if (!this.collapsible) return html`<span>Projects</span>`;
    const selectedSummary = this.selected?.name ?? "No project selected";
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`<button class="section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Projects</span>${this.collapsed ? html`<small class="section-selected" title=${selectedTitle}>${selectedSummary}</small>` : null}</span><small class="section-count">${this.projects.length}</small></button>`;
  }

  private renderActivity(project: Project) {
    const flags = this.statusSnapshot?.projects[project.id];
    const kind = statusActivityKind(flags);
    const unreadLabel = hasStatusUnread(flags) ? "Unread sessions in this project" : undefined;
    return renderActionActivityIndicator(kind, kind === "terminal" ? "Project terminal active" : "Project active", unreadLabel);
  }

  private toggleMenu(projectId: string, target: EventTarget | null) {
    if (this.openMenuProjectId === projectId) {
      this.openMenuProjectId = undefined;
      return;
    }
    this.menuStyle = actionMenuPanelStyle(target, { constrainTo: "viewport" });
    this.openMenuProjectId = projectId;
  }

  private close(project: Project) {
    this.openMenuProjectId = undefined;
    if (confirm(`Close ${project.name}?\n\nThis only removes it from PI WEB; it will not change the project folder.`)) this.onClose?.(project);
  }

  static override styles = [listStyles, css`
    section { padding-left: 0; padding-right: 0; }
    section > h2 { margin-left: 0; margin-right: 0; padding-left: 0; padding-right: 0; }
    .project-group { flex: 0 0 auto; padding-top: 0; padding-bottom: 0; gap: 0; }
    .project-group > .section-toggle { margin: 6px 0; }
    .project-group.drop-target > .section-toggle { border-color: var(--pi-accent); background: var(--pi-selection-bg); border-radius: 8px; }
    .list-body > .action-row, .project-group > .action-row, .project-drop-placeholder { margin: 2px 0; }
    .project-drop-placeholder { cursor: default; pointer-events: none; }
    .project-drop-placeholder .action-main, .project-drop-placeholder .action-menu-toggle { border-color: var(--pi-border); background: var(--pi-surface); }
    .project-drop-placeholder .action-main { color: var(--pi-muted); outline: 2px dashed var(--pi-accent); outline-offset: -2px; }
    .drag-handle { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 24px; width: 24px; min-height: 24px; color: var(--pi-muted); font-size: 18px; line-height: 1; cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; }
    .drag-handle:hover { color: var(--pi-text); }
    .drag-handle:active { cursor: grabbing; }
    .action-main.has-drag-handle { padding-left: 32px; }
    .action-main > .drag-handle { position: absolute; left: 0; top: 0; bottom: 0; }
    .project-group > .section-toggle > .section-title { flex: 1 1 auto; }
  `];
}

const unavailableProjectListSettings: PluginSettings = {
  read: () => Promise.resolve(undefined),
  write: () => Promise.reject(new Error("Project-list plugin settings are unavailable")),
};

type ProjectListDropIndicator =
  | { kind: "project"; projectId: string; position: "before" | "after" }
  | { kind: "group"; group: string; position: "before" | "after" }
  | { kind: "project-group"; group: string };

function sameDropIndicator(left: ProjectListDropIndicator | undefined, right: ProjectListDropIndicator | undefined): boolean {
  if (left?.kind !== right?.kind) return left === right;
  if (left === undefined || right === undefined) return true;
  if (left.kind === "project" && right.kind === "project") return left.projectId === right.projectId && left.position === right.position;
  if (left.kind === "group" && right.kind === "group") return left.group === right.group && left.position === right.position;
  if (left.kind === "project-group" && right.kind === "project-group") return left.group === right.group;
  return false;
}

function containsPoint(element: Element, x: number, y: number): boolean {
  const rect = element.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
