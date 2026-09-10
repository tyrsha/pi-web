import type { SessionInfo } from "./api";
import { normalizeSessionPath } from "./sessionPaths";

/** IDs are scoped to a workspace as well as the machine's browser preference. */
export function subagentParentKey(session: Pick<SessionInfo, "cwd" | "id">): string {
  return JSON.stringify([normalizeSessionPath(session.cwd), session.id]);
}

function storageKey(machineId: string): string {
  return `pi-web:hidden-subagent-parents:${encodeURIComponent(machineId)}`;
}

export function readHiddenSubagentParents(machineId: string): ReadonlySet<string> {
  try {
    if (typeof localStorage === "undefined") return new Set();
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(machineId)) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []);
  } catch {
    // Browser preferences are optional (disabled storage or an older bad value).
    return new Set();
  }
}

export function writeHiddenSubagentParents(machineId: string, keys: ReadonlySet<string>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(storageKey(machineId), JSON.stringify([...keys]));
  } catch {
    // Keep disclosure usable in memory even when browser storage is unavailable.
  }
}
