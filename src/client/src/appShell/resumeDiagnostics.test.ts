import { describe, expect, it, vi } from "vitest";
import { ResumeDiagnostics } from "./resumeDiagnostics";

describe("ResumeDiagnostics", () => {
  it("emits only enabled, content-free lifecycle breadcrumbs with monotonic sequence numbers", () => {
    const send = vi.fn();
    let now = 100;
    const diagnostics = new ResumeDiagnostics({
      send,
      pageId: () => "pwa-page_123",
      now: () => now,
      isVisible: () => true,
      isOnline: () => false,
    });

    diagnostics.record("refresh.start");
    expect(send).not.toHaveBeenCalled();

    diagnostics.setEnabled(true);
    now = 175;
    diagnostics.record("refresh.start");
    now = 220;
    diagnostics.record("session.complete");

    expect(send).toHaveBeenNthCalledWith(1, JSON.stringify({
      pageId: "pwa-page_123", sequence: 1, event: "refresh.start", visible: true, online: false, elapsedMs: 75,
    }));
    expect(send).toHaveBeenNthCalledWith(2, JSON.stringify({
      pageId: "pwa-page_123", sequence: 2, event: "session.complete", visible: true, online: false, elapsedMs: 120,
    }));
  });
});
