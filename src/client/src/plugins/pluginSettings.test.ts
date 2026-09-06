import { describe, expect, it, vi } from "vitest";
import type { PiWebConfigResponse, PiWebConfigValues } from "../api";
import { createPluginSettings, type PluginSettingsConfigApi } from "./pluginSettings";
import type { PluginMachine } from "./types";

const machine: PluginMachine = { id: "remote-a", name: "Remote A", kind: "remote" };

describe("createPluginSettings", () => {
  it("reads and writes only one plugin namespace on the supplied machine", async () => {
    const current: PiWebConfigValues = {
      host: "127.0.0.1",
      plugins: {
        organizer: { enabled: true, settings: { previous: true } },
        other: { enabled: false, settings: { untouched: true } },
      },
    };
    const readConfig = vi.fn(() => Promise.resolve(response(current)));
    const saveConfig = vi.fn(() => Promise.resolve(response(current)));
    const api: PluginSettingsConfigApi = { config: readConfig, saveConfig };
    const settings = createPluginSettings("organizer", api);

    await expect(settings.read(machine)).resolves.toEqual({ previous: true });
    await settings.write(machine, { projects: { "/repo/example": { pinned: true } } });

    expect(readConfig).toHaveBeenCalledWith("remote-a");
    expect(saveConfig).toHaveBeenCalledWith({
      host: "127.0.0.1",
      plugins: {
        organizer: { enabled: true, settings: { projects: { "/repo/example": { pinned: true } } } },
        other: { enabled: false, settings: { untouched: true } },
      },
    }, "remote-a");
  });
});

function response(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false },
  };
}
