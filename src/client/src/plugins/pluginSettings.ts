import { configApi } from "../api";
import type { PluginSettings } from "./types";

export interface PluginSettingsConfigApi {
  config(machineId: string): ReturnType<typeof configApi.config>;
  saveConfig: typeof configApi.saveConfig;
}

/**
 * Creates a plugin-scoped settings adapter without exposing the host's raw
 * config API. The adapter always re-reads before writing so it preserves the
 * plugin enablement state and unrelated global configuration.
 */
export function createPluginSettings(pluginId: string, api: PluginSettingsConfigApi = configApi): PluginSettings {
  return {
    read: async (machine) => (await api.config(machine.id)).config.plugins?.[pluginId]?.settings,
    write: async (machine, settings) => {
      const current = (await api.config(machine.id)).config;
      const currentPlugin = current.plugins?.[pluginId] ?? {};
      await api.saveConfig({
        ...current,
        plugins: { ...current.plugins, [pluginId]: { ...currentPlugin, settings } },
      }, machine.id);
    },
  };
}

