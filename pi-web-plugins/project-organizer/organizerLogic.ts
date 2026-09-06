import type { Project } from "@jmfederico/pi-web/plugin-api";

export type ProjectOrganizerMoveTarget =
  | { type: "project"; project: Project; position: "before" | "after" }
  | { type: "group"; group: string };

export interface ProjectOrganizerEntry {
  group?: string;
  lastOpenedAt?: number;
  order?: number;
}

export interface ProjectOrganizerData {
  projects: Record<string, ProjectOrganizerEntry>;
  groupOrder: Record<string, number>;
}

export interface ProjectOrganizerSections {
  ungrouped: Project[];
  groups: ReadonlyMap<string, Project[]>;
}

export const emptyProjectOrganizerData = (): ProjectOrganizerData => ({ projects: {}, groupOrder: {} });

export function parseProjectOrganizerData(value: unknown): ProjectOrganizerData {
  if (!isRecord(value) || !isRecord(value["projects"])) return emptyProjectOrganizerData();
  const projects: Record<string, ProjectOrganizerEntry> = {};
  for (const [path, entry] of Object.entries(value["projects"])) {
    if (!isRecord(entry)) continue;
    const group = typeof entry["group"] === "string" && entry["group"].trim() !== "" ? entry["group"].trim() : undefined;
    const lastOpenedAt = typeof entry["lastOpenedAt"] === "number" && Number.isFinite(entry["lastOpenedAt"]) ? entry["lastOpenedAt"] : undefined;
    const order = typeof entry["order"] === "number" && Number.isFinite(entry["order"]) ? entry["order"] : undefined;
    const parsed: ProjectOrganizerEntry = {
      ...(group === undefined ? {} : { group }),
      ...(lastOpenedAt === undefined ? {} : { lastOpenedAt }),
      ...(order === undefined ? {} : { order }),
    };
    if (Object.keys(parsed).length > 0) projects[path] = parsed;
  }
  const groupOrder: Record<string, number> = {};
  if (isRecord(value["groupOrder"])) {
    for (const [group, order] of Object.entries(value["groupOrder"])) {
      if (typeof order === "number" && Number.isFinite(order)) groupOrder[group] = order;
    }
  }
  return { projects, groupOrder };
}

export function organizeProjects(projects: readonly Project[], metadata: ProjectOrganizerData, query: string): ProjectOrganizerSections {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matching = projects.filter((project) => normalizedQuery === "" || project.name.toLocaleLowerCase().includes(normalizedQuery) || project.path.toLocaleLowerCase().includes(normalizedQuery));
  const groups = new Map<string, Project[]>();
  const ungrouped: Project[] = [];
  for (const project of matching) {
    const group = metadata.projects[project.path]?.group;
    if (group === undefined) ungrouped.push(project);
    else groups.set(group, [...(groups.get(group) ?? []), project]);
  }
  for (const groupProjects of groups.values()) groupProjects.sort((left, right) => projectOrder(metadata, left) - projectOrder(metadata, right) || byName(left, right));
  return { ungrouped: ungrouped.sort((left, right) => projectOrder(metadata, left) - projectOrder(metadata, right) || byName(left, right)), groups: new Map([...groups].sort(([left], [right]) => (metadata.groupOrder[left] ?? Number.MAX_SAFE_INTEGER) - (metadata.groupOrder[right] ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right))) };
}

export function updateProjectGroupOrder(data: ProjectOrganizerData, groups: readonly string[]): ProjectOrganizerData {
  return { ...data, groupOrder: Object.fromEntries(groups.map((group, index) => [group, index])) };
}

export function moveProjectMetadata(data: ProjectOrganizerData, projects: readonly Project[], project: Project, target: ProjectOrganizerMoveTarget): ProjectOrganizerData {
  const draggedPath = project.path;
  const sourceGroup = projectGroup(data, project);
  const targetGroup = target.type === "group" ? target.group : projectGroup(data, target.project);
  const relevantGroups = new Set([sourceGroup, targetGroup]);
  let next = data;
  let draggedOrder = projectOrder(data, project);

  for (const group of relevantGroups) {
    const orderedProjects = projects
      .filter((candidate) => candidate.path !== draggedPath && projectGroup(data, candidate) === group)
      .sort((left, right) => projectOrder(data, left) - projectOrder(data, right) || projects.indexOf(left) - projects.indexOf(right));
    if (targetGroup === group && target.type === "project") {
      const targetIndex = orderedProjects.findIndex((candidate) => candidate.path === target.project.path);
      orderedProjects.splice(Math.max(0, targetIndex + (target.position === "after" ? 1 : 0)), 0, project);
    } else if (targetGroup === group && target.type === "group") {
      orderedProjects.push(project);
    }
    for (const [index, candidate] of orderedProjects.entries()) {
      if (candidate.path === draggedPath) draggedOrder = index;
      next = updateProjectMetadata(next, candidate.path, { order: index });
    }
  }

  return updateProjectMetadata(next, draggedPath, {
    ...(targetGroup === undefined ? { group: "" } : { group: targetGroup }),
    order: draggedOrder,
  });
}

export function reorderGroupNames(groups: readonly string[], source: string, target: string, position: "before" | "after"): string[] {
  const sourceIndex = groups.indexOf(source);
  const targetIndex = groups.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return [...groups];
  const next = [...groups];
  next.splice(sourceIndex, 1);
  const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  next.splice(adjustedTargetIndex + (position === "after" ? 1 : 0), 0, source);
  return next;
}

export function updateProjectMetadata(data: ProjectOrganizerData, path: string, patch: ProjectOrganizerEntry): ProjectOrganizerData {
  const previous = data.projects[path] ?? {};
  const next = { ...previous, ...patch };
  if (next.group === undefined || next.group.trim() === "") delete next.group;
  if (next.lastOpenedAt === undefined || !Number.isFinite(next.lastOpenedAt)) delete next.lastOpenedAt;
  if (next.order === undefined || !Number.isFinite(next.order)) delete next.order;
  const projects = Object.keys(next).length === 0
    ? Object.fromEntries(Object.entries(data.projects).filter(([existingPath]) => existingPath !== path))
    : { ...data.projects, [path]: next };
  return { ...data, projects };
}

function projectGroup(data: ProjectOrganizerData, project: Project): string | undefined {
  const group = data.projects[project.path]?.group;
  return group === undefined || group === "" ? undefined : group;
}

function projectOrder(data: ProjectOrganizerData, project: Project): number {
  return data.projects[project.path]?.order ?? Number.MAX_SAFE_INTEGER;
}

function byName(left: Project, right: Project): number {
  return left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
