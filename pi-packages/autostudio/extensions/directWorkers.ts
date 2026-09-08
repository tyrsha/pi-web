import { createDirectWorkerProvider } from "./autostudioDirectWorkers.js";
import { daemonRequest } from "./autostudioSessions.js";

interface ProviderApi {
  registerExternalJobProvider(provider: ReturnType<typeof createDirectWorkerProvider>): () => void;
}

function isProviderApi(value: unknown): value is ProviderApi {
  return value !== null && typeof value === "object" && "registerExternalJobProvider" in value
    && typeof value.registerExternalJobProvider === "function";
}

/** Install independently of /autostudio: ordinary subagent calls need it too. */
export default async function () {
  const socket = process.env["PI_WEB_SESSIOND_SOCKET"];
  if (socket === undefined || socket === "") return; // Configured external-job agents fail closed outside Pi Web.
  const specifier = "pi-subagents/external-job-provider";
  const api: unknown = await import(specifier);
  if (!isProviderApi(api)) throw new Error("pi-subagents provider API is unavailable");
  // This provider belongs to the process, not the registering session. It has
  // no session closures or owned resources; a session shutdown must not remove
  // it while another manager still needs it. Reload replaces it idempotently.
  api.registerExternalJobProvider(createDirectWorkerProvider(daemonRequest(socket)));
}
