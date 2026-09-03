let currentPageId: string | undefined;

/** One content-free identifier shared by client diagnostics and correlated requests. */
export function clientPageId(): string {
  if (currentPageId !== undefined) return currentPageId;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") currentPageId = crypto.randomUUID().replaceAll("-", "");
  else currentPageId = Math.random().toString(36).slice(2).padEnd(8, "0");
  return currentPageId;
}
