import { describe, expect, it } from "vitest";
import type { Project } from "@jmfederico/pi-web/plugin-api";
import { moveProjectMetadata, organizeProjects, parseProjectOrganizerData, reorderGroupNames, updateProjectGroupOrder, updateProjectMetadata } from "./organizerLogic.js";

const projects = [project("alpha"), project("beta"), project("gamma")];

describe("project organizer sections", () => {
  it("groups projects and respects persisted group and project order", () => {
    const metadata = parseProjectOrganizerData({
      groupOrder: { SaaS: 1, Game: 0 },
      projects: {
        "/repo/alpha": { group: "Game", order: 1 },
        "/repo/beta": { group: "Game", order: 0 },
        "/repo/gamma": { group: "SaaS", order: 0 },
      },
    });

    const sections = organizeProjects(projects, metadata, "");

    expect([...sections.groups].map(([group, entries]) => [group, entries.map((entry) => entry.name)])).toEqual([
      ["Game", ["beta", "alpha"]],
      ["SaaS", ["gamma"]],
    ]);
    expect(sections.ungrouped).toEqual([]);
  });

  it("keeps metadata sparse when a project no longer has organizer state", () => {
    const initial = { projects: {}, groupOrder: {} };
    const grouped = updateProjectMetadata(initial, "/repo/alpha", { group: "Game" });
    expect(grouped).toEqual({ projects: { "/repo/alpha": { group: "Game" } }, groupOrder: {} });

    const reordered = updateProjectMetadata(grouped, "/repo/alpha", { order: 3 });
    expect(reordered).toEqual({ projects: { "/repo/alpha": { group: "Game", order: 3 } }, groupOrder: {} });
    expect(reorderGroupNames(["Game", "SaaS", "Infra"], "Game", "Infra", "before")).toEqual(["SaaS", "Game", "Infra"]);
    expect(reorderGroupNames(["Game", "SaaS", "Infra"], "Infra", "Game", "after")).toEqual(["Game", "Infra", "SaaS"]);
    expect(updateProjectGroupOrder(reordered, ["Game", "SaaS"])).toEqual({
      projects: { "/repo/alpha": { group: "Game", order: 3 } },
      groupOrder: { Game: 0, SaaS: 1 },
    });
  });

  it("persists project order and group changes after a move", () => {
    const metadata = parseProjectOrganizerData({
      projects: {
        "/repo/alpha": { group: "Game", order: 0 },
        "/repo/beta": { group: "Game", order: 1 },
        "/repo/gamma": { group: "SaaS", order: 0 },
      },
    });

    const gamma = projects.find((project) => project.name === "gamma");
    if (gamma === undefined) throw new Error("Expected gamma project");
    const moved = moveProjectMetadata(metadata, projects, gamma, { type: "group", group: "Game" });

    expect(moved.projects["/repo/gamma"]).toEqual({ group: "Game", order: 2 });
    expect(moved.projects["/repo/alpha"]?.order).toBe(0);
    expect(moved.projects["/repo/beta"]?.order).toBe(1);
  });

  it("drops invalid persisted entries instead of preventing the list from loading", () => {
    expect(parseProjectOrganizerData({ projects: { "/repo/a": { group: "  " }, "/repo/b": { order: Number.POSITIVE_INFINITY } } })).toEqual({ projects: {}, groupOrder: {} });
  });
});

function project(name: string): Project {
  return { id: name, name, path: `/repo/${name}`, createdAt: "2026-01-01T00:00:00.000Z" };
}
