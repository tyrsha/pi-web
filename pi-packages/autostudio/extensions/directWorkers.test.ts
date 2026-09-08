import { afterEach, describe, expect, it, vi } from "vitest";
import installDirectWorkers from "./directWorkers.js";
import { createDirectWorkerProvider, DIRECT_WORKER_PROVIDER } from "./autostudioDirectWorkers.js";

interface Registry {
  getExternalJobProvider(name: string): unknown;
  registerExternalJobProvider(provider: unknown): () => void;
}
function isRegistry(value: unknown): value is Registry {
  return value !== null && typeof value === "object" && "getExternalJobProvider" in value
    && typeof value.getExternalJobProvider === "function" && "registerExternalJobProvider" in value
    && typeof value.registerExternalJobProvider === "function";
}
const specifier = "pi-subagents/external-job-provider";
const registry: unknown = await import(specifier);
if (!isRegistry(registry)) throw new Error("Missing public provider registry");
const api = registry;
const previous = api.getExternalJobProvider(DIRECT_WORKER_PROVIDER);
afterEach(() => {
  vi.unstubAllEnvs();
  if (previous !== undefined) api.registerExternalJobProvider(previous);
  else api.registerExternalJobProvider(createDirectWorkerProvider(() => Promise.reject(new Error("Unused test transport"))))();
});

describe("ordinary subagent provider installation", () => {
  it("makes the provider available before any /autostudio invocation and survives repeated session loads", async () => {
    vi.stubEnv("PI_WEB_SESSIOND_SOCKET", "/unused-test.sock");
    await installDirectWorkers();
    expect(api.getExternalJobProvider(DIRECT_WORKER_PROVIDER)).toMatchObject({ name: DIRECT_WORKER_PROVIDER });
    await installDirectWorkers();
    expect(api.getExternalJobProvider(DIRECT_WORKER_PROVIDER)).toMatchObject({ name: DIRECT_WORKER_PROVIDER });
  });

  it("does not install a subprocess fallback outside Pi Web", async () => {
    vi.stubEnv("PI_WEB_SESSIOND_SOCKET", undefined);
    await installDirectWorkers();
    expect(api.getExternalJobProvider(DIRECT_WORKER_PROVIDER)).toBe(previous);
  });
});
