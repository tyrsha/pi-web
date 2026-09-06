import type { HtmlTemplateTag, PiWebPlugin, ProjectListActionContext, ProjectListContext, ProjectListGroupMoveContext, ProjectListMoveContext } from "@jmfederico/pi-web/plugin-api";
import { emptyProjectOrganizerData, moveProjectMetadata, parseProjectOrganizerData, reorderGroupNames, updateProjectGroupOrder, updateProjectMetadata, type ProjectOrganizerData, type ProjectOrganizerEntry } from "./organizerLogic.js";

interface MachineState {
  data: ProjectOrganizerData;
  loading: boolean;
  loadPromise?: Promise<void>;
  saveQueue: Promise<void>;
  revision: number;
}

const machineStates = new Map<string, MachineState>();

function stateFor(context: ProjectListContext): MachineState {
  const key = context.machine.id;
  const existing = machineStates.get(key);
  if (existing !== undefined) return existing;
  const state: MachineState = { data: emptyProjectOrganizerData(), loading: true, saveQueue: Promise.resolve(), revision: 0 };
  const loadedRevision = state.revision;
  state.loadPromise = context.settings.read(context.machine)
    .then((settings) => {
      // A drag may have mutated state while settings were loading; never
      // clobber newer in-memory order with the stale snapshot.
      if (state.revision === loadedRevision) state.data = parseProjectOrganizerData(settings);
      state.loading = false;
      context.requestRender();
    })
    .catch((error: unknown) => {
      state.loading = false;
      console.warn(`Project Organizer could not load settings for ${context.machine.id}`, error);
      context.requestRender();
    });
  machineStates.set(key, state);
  return state;
}

function update(context: ProjectListActionContext, patch: ProjectOrganizerEntry): void {
  const state = stateFor(context);
  state.data = updateProjectMetadata(state.data, context.project.path, patch);
  state.revision += 1;
  const snapshot = state.data;
  context.requestRender();
  state.saveQueue = state.saveQueue
    .catch(() => undefined)
    .then(() => context.settings.write(context.machine, toSettings(snapshot)))
    .catch((error: unknown) => {
      console.warn(`Project Organizer could not save settings for ${context.machine.id}`, error);
    });
}

function markRecent(context: ProjectListActionContext): void {
  update(context, { lastOpenedAt: Date.now() });
}

function projectOrder(context: ProjectListActionContext): number | undefined {
  return stateFor(context).data.projects[context.project.path]?.order;
}

function groupOrder(group: string, context: ProjectListContext): number | undefined {
  return stateFor(context).data.groupOrder[group];
}

function moveGroup(context: ProjectListGroupMoveContext): void {
  const state = stateFor(context);
  const groups = [...new Set(context.projects.map((project) => state.data.projects[project.path]?.group).filter((group): group is string => group !== undefined && group !== ""))]
    .sort((left, right) => (state.data.groupOrder[left] ?? Number.MAX_SAFE_INTEGER) - (state.data.groupOrder[right] ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right));
  const reorderedGroups = reorderGroupNames(groups, context.group, context.targetGroup, context.position);
  if (reorderedGroups.join("\u0000") === groups.join("\u0000")) return;
  state.data = updateProjectGroupOrder(state.data, reorderedGroups);
  state.revision += 1;
  context.requestRender();
  state.saveQueue = state.saveQueue
    .catch(() => undefined)
    .then(() => context.settings.write(context.machine, toSettings(state.data)))
    .catch((error: unknown) => {
      console.warn(`Project Organizer could not save group order for ${context.machine.id}`, error);
    });
}

function moveProject(context: ProjectListMoveContext): void {
  const state = stateFor(context);
  const next = moveProjectMetadata(state.data, context.projects, context.project, context.target);
  state.data = next;
  state.revision += 1;
  context.requestRender();
  state.saveQueue = state.saveQueue
    .catch(() => undefined)
    .then(() => context.settings.write(context.machine, toSettings(next)))
    .catch((error: unknown) => {
      console.warn(`Project Organizer could not save settings for ${context.machine.id}`, error);
    });
}

function renderActions(html: HtmlTemplateTag, context: ProjectListActionContext) {
  const state = stateFor(context);
  const group = state.data.projects[context.project.path]?.group;
  return html`
    <button title="Set project group" @click=${() => {
      const value = prompt(`Group for ${context.project.name}`, group ?? "");
      if (value !== null) update(context, value.trim() === "" ? { group: "" } : { group: value.trim() });
    }}>${group === undefined ? "Set group" : `Group: ${group}`}</button>
    ${state.loading ? html`<small>Loading organizer settings…</small>` : null}
  `;
}

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Project Organizer",
  activate: ({ html }) => ({
    contributions: {
      projectList: {
        id: "projects.organizer",
        order: 100,
        onSelect: markRecent,
        group: (context) => stateFor(context).data.projects[context.project.path]?.group,
        sort: projectOrder,
        groupOrder,
        onMoveProject: moveProject,
        onMoveGroup: moveGroup,
        renderActions: (context) => renderActions(html, context),
      },
    },
  }),
};

export default plugin;

function toSettings(value: ProjectOrganizerData): Record<string, unknown> {
  return {
    groupOrder: { ...value.groupOrder },
    projects: Object.fromEntries(Object.entries(value.projects).map(([path, entry]) => [path, {
      ...(entry.group === undefined ? {} : { group: entry.group }),
      ...(entry.lastOpenedAt === undefined ? {} : { lastOpenedAt: entry.lastOpenedAt }),
      ...(entry.order === undefined ? {} : { order: entry.order }),
    }])),
  };
}
