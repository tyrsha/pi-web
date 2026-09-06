import { describe, expect, it } from "vitest";
import type {
  HtmlTemplateTag,
  PluginMachine,
  PluginSettings,
  Project,
  ProjectListActionContext,
  ProjectListContext,
} from "@jmfederico/pi-web/plugin-api";
import plugin from "./pi-web-plugin.js";

const unusedHtml: HtmlTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]): never => {
  void strings;
  void values;
  throw new Error("renderActions are not used in this test");
};

function project(name: string): Project {
  return { id: name, name, path: `/repo/${name}`, createdAt: "2026-01-01T00:00:00.000Z" };
}

describe("project organizer settings race", () => {
  it("keeps a drag that lands while settings are still loading", async () => {
    let resolveRead: ((value: Record<string, unknown> | undefined) => void) | undefined;
    const settings: PluginSettings = {
      read: () => new Promise<Record<string, unknown> | undefined>((resolve) => {
        resolveRead = resolve;
      }),
      write: () => Promise.resolve(),
    };
    const machine: PluginMachine = { id: "race-machine", name: "Race", kind: "local" };
    const projects = [project("alpha"), project("beta"), project("gamma")];
    const base: ProjectListContext = {
      machine,
      settings,
      projects,
      selectProject: () => undefined,
      requestCloseProject: () => undefined,
      requestRender: () => undefined,
    };
    const contribution = plugin.activate({
      apiVersion: 2,
      pluginId: "test-organizer",
      runtimePluginId: "test-organizer",
      html: unusedHtml,
      svg: unusedHtml,
    }).contributions.projectList;
    if (contribution === undefined) throw new Error("Expected a projectList contribution");

    const beta = projects.find((candidate) => candidate.name === "beta");
    const gamma = projects.find((candidate) => candidate.name === "gamma");
    if (beta === undefined || gamma === undefined) throw new Error("Expected beta and gamma projects");
    void contribution.onMoveProject?.({ ...base, project: gamma, target: { type: "project", project: beta, position: "before" } });

    // The stale settings snapshot resolves after the drag; it must not wipe it.
    resolveRead?.({});
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    const orderOf = (name: string): number | undefined => {
      const target = projects.find((candidate) => candidate.name === name);
      if (target === undefined) throw new Error(`Expected project ${name}`);
      const context: ProjectListActionContext = { ...base, project: target };
      return contribution.sort?.(context);
    };
    const gammaOrder = orderOf("gamma");
    const betaOrder = orderOf("beta");
    expect(gammaOrder).not.toBeUndefined();
    expect(betaOrder).not.toBeUndefined();
    if (gammaOrder === undefined || betaOrder === undefined) throw new Error("Expected persisted orders");
    expect(gammaOrder).toBeLessThan(betaOrder);
  });
});
