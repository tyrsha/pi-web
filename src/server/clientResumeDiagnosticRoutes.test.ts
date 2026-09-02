import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { parseClientResumeDiagnostic, parseClientResumeDiagnostics, registerClientResumeDiagnosticRoutes } from "./clientResumeDiagnosticRoutes.js";

const diagnostic = {
  pageId: "pwa-page_123",
  sequence: 3,
  event: "session.complete",
  visible: true,
  online: true,
  elapsedMs: 415,
};

describe("parseClientResumeDiagnostic", () => {
  it("accepts content-free lifecycle breadcrumbs, individually or in a bounded batch", () => {
    expect(parseClientResumeDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(parseClientResumeDiagnostics({ events: [diagnostic, { ...diagnostic, sequence: 4, event: "refresh.complete" }] }))
      .toEqual([diagnostic, { ...diagnostic, sequence: 4, event: "refresh.complete" }]);
  });

  it.each([
    [{ ...diagnostic, event: "message content must not be accepted" }],
    [{ ...diagnostic, pageId: "has space" }],
    [{ ...diagnostic, sequence: 0 }],
    [{ ...diagnostic, elapsedMs: -1 }],
    [{ ...diagnostic, visible: "yes" }],
  ])("rejects invalid diagnostic fields", (value) => {
    expect(parseClientResumeDiagnostic(value)).toBeUndefined();
  });
});

describe("client resume diagnostic route", () => {
  it("records valid breadcrumbs and rejects malformed payloads", async () => {
    const app = Fastify({ logger: false });
    registerClientResumeDiagnosticRoutes(app);

    const accepted = await app.inject({ method: "POST", url: "/api/client-diagnostics/resume", payload: { events: [diagnostic] } });
    const rejected = await app.inject({ method: "POST", url: "/api/client-diagnostics/resume", payload: { ...diagnostic, event: "unknown" } });

    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ accepted: true });
    expect(rejected.statusCode).toBe(400);
    await app.close();
  });
});
