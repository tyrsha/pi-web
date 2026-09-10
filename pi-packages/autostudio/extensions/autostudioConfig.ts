import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;
export interface ModelTarget {
  model: string;
  thinkingLevel: ThinkingLevel;
}
export interface AutostudioConfig {
  manager: ModelTarget;
  workers: ModelTarget[];
  escalation: ModelTarget;
}

export const DEFAULT_CONFIG: AutostudioConfig = {
  manager: { model: "openai-codex/gpt-6-astra", thinkingLevel: "medium" },
  workers: [
    { model: "openai-codex/gpt-5.6-sol", thinkingLevel: "medium" },
    { model: "openai-codex/gpt-5.6-terra", thinkingLevel: "medium" },
  ],
  escalation: { model: "openai-codex/gpt-6-astra", thinkingLevel: "high" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function target(value: unknown, label: string): ModelTarget {
  const input = record(value, label);
  if (Object.keys(input).some((key) => key !== "model" && key !== "thinkingLevel")) throw new Error(`${label} supports only model and thinkingLevel`);
  const model = input["model"];
  const thinkingLevel = input["thinkingLevel"];
  if (typeof model !== "string" || !/^[^\s/]+\/\S+$/.test(model) || model.endsWith("/")) throw new Error(`${label}.model must be provider/model-id`);
  if (!isThinkingLevel(thinkingLevel)) throw new Error(`${label}.thinkingLevel is invalid`);
  return { model, thinkingLevel };
}

export function parseAutostudioConfig(value: unknown): AutostudioConfig {
  const input = record(value, "Autostudio config");
  if (Object.keys(input).some((key) => !["manager", "workers", "escalation"].includes(key))) throw new Error("Autostudio config supports only manager, workers and escalation");
  const workers = input["workers"] === undefined ? DEFAULT_CONFIG.workers : input["workers"];
  if (!Array.isArray(workers) || workers.length === 0 || workers.length > 16) throw new Error("Autostudio workers must contain 1–16 model targets");
  return {
    manager: target(input["manager"] === undefined ? DEFAULT_CONFIG.manager : input["manager"], "manager"),
    workers: workers.map((worker: unknown, index) => target(worker, `workers[${String(index)}]`)),
    escalation: target(input["escalation"] === undefined ? DEFAULT_CONFIG.escalation : input["escalation"], "escalation"),
  };
}

/** This package owns its config separately from PI WEB core configuration. */
export function readAutostudioConfig(cwd: string, trusted: boolean): AutostudioConfig {
  const path = join(cwd, ".pi-web", "autostudio.json");
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return parseAutostudioConfig({});
    throw error;
  }
  if (!trusted) throw new Error(`Trust this project before loading ${path}`);
  try { return parseAutostudioConfig(JSON.parse(text)); }
  catch (error) { throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

export function resolveTarget(ctx: Pick<ExtensionContext, "modelRegistry">, target: ModelTarget) {
  const separator = target.model.indexOf("/");
  const model = ctx.modelRegistry.find(target.model.slice(0, separator), target.model.slice(separator + 1));
  if (model === undefined) throw new Error(`Autostudio model unavailable: ${target.model}. Configure .pi-web/autostudio.json.`);
  if (!getSupportedThinkingLevels(model).includes(target.thinkingLevel)) throw new Error(`Autostudio thinking level ${target.thinkingLevel} is unsupported by ${target.model}`);
  return model;
}

export async function selectManager(pi: Pick<ExtensionAPI, "setModel" | "setThinkingLevel">, ctx: Pick<ExtensionContext, "modelRegistry">, config: AutostudioConfig): Promise<void> {
  // Fail before changing the manager or starting a worker if any model is unknown.
  for (const target of [config.manager, ...config.workers, config.escalation]) resolveTarget(ctx, target);
  if (!await pi.setModel(resolveTarget(ctx, config.manager))) throw new Error(`Autostudio manager has no credentials: ${config.manager.model}`);
  pi.setThinkingLevel(config.manager.thinkingLevel);
}

/** Planner/reviewer decisions use the manager tier; executors rotate sequentially. */
export function createModelRouting(config: AutostudioConfig) {
  let nextWorker = 0;
  return (role: string, escalated = false): ModelTarget => {
    if (escalated) return config.escalation;
    if (role === "planner" || role === "reviewer") return config.manager;
    const worker = config.workers[nextWorker++ % config.workers.length];
    if (worker === undefined) throw new Error("Autostudio requires at least one worker model");
    return worker;
  };
}
