import { request as httpRequest } from "node:http";

export type DaemonRequest = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** Transport only. Session creation, execution, persistence and streaming stay daemon-owned. */
export function daemonRequest(socketPath: string): DaemonRequest {
  return (method, path, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({
      socketPath, method, path,
      headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const result: unknown = JSON.parse(text);
          if ((response.statusCode ?? 500) >= 400) throw new Error(`Pi Web ${method} ${path}: ${text.slice(0, 1000)}`);
          resolve(result);
        } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid Pi Web response");
  return value;
}

/** Query-relative browser reference preserves the deployed application prefix. */
export function workerSessionPath(id: string, cwd: string): string {
  return `?${new URLSearchParams({ session: id, cwd, view: "chat" }).toString()}`;
}

function assistantText(message: Record<string, unknown>): string {
  if (typeof message["content"] === "string") return message["content"];
  if (!Array.isArray(message["content"])) return "";
  return message["content"].flatMap((part: unknown) => {
    const item = record(part);
    return item["type"] === "text" && typeof item["text"] === "string" ? [item["text"]] : [];
  }).join("\n");
}

export function createSessionHost(request: DaemonRequest, cwd: string, model?: { provider: string; id: string }) {
  const base = (id: string) => `/sessions/${encodeURIComponent(id)}`;
  const query = new URLSearchParams({ cwd }).toString();
  return {
    async start(input: { prompt: string; cwd: string; name: string }): Promise<{ id: string; url: string }> {
      if (input.cwd !== cwd) throw new Error("Worker workspace differs from the manager session");
      const created = record(await request("POST", "/sessions", { cwd }));
      const id = created["id"];
      if (typeof id !== "string" || id === "") throw new Error("Pi Web did not return a worker session id");
      // Name before prompting so automatic title generation cannot hide the role.
      await request("POST", `${base(id)}/commands/run`, { cwd, text: `/name ${input.name.replace(/[\r\n]/g, " ")}` });
      if (model !== undefined) await request("POST", `${base(id)}/model`, { cwd, provider: model.provider, modelId: model.id });
      await request("POST", `${base(id)}/prompt`, { cwd, text: input.prompt });
      return { id, url: workerSessionPath(id, cwd) };
    },
    async status(id: string): Promise<{ state: "running" | "completed" | "failed" | "stopped"; output?: string }> {
      const status = record(await request("GET", `${base(id)}/status?${query}`));
      if (status["isStreaming"] === true || status["isCompacting"] === true || status["isBashRunning"] === true || Number(status["pendingMessageCount"] ?? 0) > 0) return { state: "running" };
      const page = record(await request("GET", `${base(id)}/messages?${query}&limit=100`));
      if (!Array.isArray(page["messages"])) throw new Error("Pi Web returned invalid worker messages");
      const messages = page["messages"].map(record);
      const last = messages.reverse().find((message) => message["role"] === "assistant");
      // An accepted prompt is not completion. Wait for an actual terminal assistant result.
      if (last === undefined || last["stopReason"] === "toolUse") return { state: "running" };
      const output = assistantText(last);
      if (last["stopReason"] === "error") return { state: "failed", output: typeof last["errorMessage"] === "string" ? last["errorMessage"] : output };
      if (last["stopReason"] === "aborted") return { state: "stopped", output };
      if (last["stopReason"] !== "stop") return { state: "failed", output: `Worker ended without a final answer (${String(last["stopReason"])}). ${output}` };
      return { state: "completed", output };
    },
  };
}
