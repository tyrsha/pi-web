import { describe, expect, it, vi } from "vitest";
import { ResumeDiagnostics } from "./resumeDiagnostics";

describe("ResumeDiagnostics", () => {
  it("batches only enabled, content-free lifecycle breadcrumbs with monotonic sequence numbers", () => {
    vi.useFakeTimers();
    try {
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
      vi.advanceTimersByTime(100);

      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith(JSON.stringify({ events: [
        { pageId: "pwa-page_123", sequence: 1, event: "refresh.start", visible: true, online: false, elapsedMs: 75 },
        { pageId: "pwa-page_123", sequence: 2, event: "session.complete", visible: true, online: false, elapsedMs: 120 },
      ] }));
    } finally {
      vi.useRealTimers();
    }
  });
});
