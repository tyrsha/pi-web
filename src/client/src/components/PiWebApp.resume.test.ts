import { afterEach, describe, expect, it, vi } from "vitest";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp browser resume", () => {
  it("does not write the document viewport while an installed PWA is resuming", () => {
    const app = createApp();
    const appShell: unknown = Reflect.get(app, "appShell");
    if (!hasViewportRepair(appShell)) throw new Error("PiWebApp shell was unavailable");
    const repairViewport = vi.spyOn(appShell, "repairViewportPosition");
    if (!Reflect.set(app, "schedulePiWebStatusRefresh", () => undefined)) throw new Error("Could not stub PI WEB status refresh");
    if (!Reflect.set(app, "retryPendingRemoteRouteRestoreSoon", () => undefined)) throw new Error("Could not stub route retry");
    const signal: unknown = Reflect.get(app, "handleBrowserResumeSignal");
    if (!isResumeSignal(signal)) throw new Error("Browser resume signal handler was unavailable");

    signal.call(app, "visibility");

    expect(repairViewport).not.toHaveBeenCalled();
  });
});

function createApp(): PiWebApp {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebApp();
}

type ResumeSignal = (trigger: "focus" | "online" | "visibility") => void;

function isResumeSignal(value: unknown): value is ResumeSignal {
  return typeof value === "function";
}

function hasViewportRepair(value: unknown): value is { repairViewportPosition(): void } {
  return typeof value === "object" && value !== null && "repairViewportPosition" in value && typeof value.repairViewportPosition === "function";
}
