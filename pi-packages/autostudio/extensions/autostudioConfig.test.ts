import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModelRouting, DEFAULT_CONFIG, parseAutostudioConfig, readAutostudioConfig } from "./autostudioConfig.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Autostudio model configuration", () => {
  it("defaults to Astra Medium, alternating Sol/Terra and Astra High on failure", () => {
    const config = parseAutostudioConfig({});
    const route = createModelRouting(config);
    expect(route("planner")).toEqual(DEFAULT_CONFIG.manager);
    expect(route("worker")).toEqual(DEFAULT_CONFIG.workers[0]);
    expect(route("reviewer")).toEqual(DEFAULT_CONFIG.manager);
    expect(route("researcher")).toEqual(DEFAULT_CONFIG.workers[1]);
    expect(route("worker", true)).toEqual(DEFAULT_CONFIG.escalation);
    expect(route("qa")).toEqual(DEFAULT_CONFIG.workers[0]);
    expect(route("planner", true)).toEqual(DEFAULT_CONFIG.escalation);
    expect(createModelRouting(config)("worker")).toEqual(DEFAULT_CONFIG.workers[0]);
  });

  it("replaces configured roles and preserves omitted defaults without shared mutable arrays", () => {
    const custom = { model: "other/provider/model", thinkingLevel: "low" };
    const config = parseAutostudioConfig({ workers: [custom], escalation: custom });
    expect(config.manager).toEqual(DEFAULT_CONFIG.manager);
    expect(createModelRouting(config)("worker")).toEqual(custom);
    expect(createModelRouting(config)("worker", true)).toEqual(custom);
    config.manager.model = "changed";
    expect(parseAutostudioConfig({}).manager).toEqual(DEFAULT_CONFIG.manager);
  });

  it.each([null, [], { worker: {} }, { workers: [] }, { workers: null }, { manager: null }, { workers: new Array(17).fill(DEFAULT_CONFIG.manager) }, { escalation: { model: "astra", thinkingLevel: "high" } }, { manager: { model: "p/astra", thinkingLevel: "ultra" } }, { manager: { model: "p/astra", thinkingLevel: "medium", unknown: true } }])("rejects invalid configuration: %j", (value) => {
    expect(() => parseAutostudioConfig(value)).toThrow();
  });

  it("loads fresh project config each run and fails visibly on malformed/untrusted files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "autostudio-config-"));
    dirs.push(cwd);
    expect(readAutostudioConfig(cwd, true)).toEqual(DEFAULT_CONFIG);
    mkdirSync(join(cwd, ".pi-web"));
    const path = join(cwd, ".pi-web/autostudio.json");
    writeFileSync(path, JSON.stringify({ workers: [{ model: "p/custom", thinkingLevel: "off" }] }));
    expect(readAutostudioConfig(cwd, true).workers[0]?.model).toBe("p/custom");
    expect(() => readAutostudioConfig(cwd, false)).toThrow("Trust this project");
    writeFileSync(path, "{");
    expect(() => readAutostudioConfig(cwd, true)).toThrow("Invalid " + path);
  });
});
