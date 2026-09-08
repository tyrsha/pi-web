// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { toSafeMarkdownHtml } from "./markdown";

afterEach(() => { document.head.querySelectorAll("base").forEach((el) => { el.remove(); }); document.body.replaceChildren(); vi.unstubAllEnvs(); });

function links(text: string): HTMLAnchorElement[] {
  document.body.innerHTML = toSafeMarkdownHtml(text);
  return [...document.body.querySelectorAll("a")];
}

describe("chat worker session links", () => {
  it("renders a clickable application-relative link under a nested deployment", () => {
    vi.stubEnv("BASE_URL", "/nested/pi/");
    const base = document.createElement("base");
    base.href = "https://example.test/nested/pi/";
    document.head.append(base);
    const [link] = links("[Open session](<?session=child%26id&cwd=%2Fwork%2Fspace+name&view=chat>)");
    expect(link?.getAttribute("href")).toBe("https://example.test/nested/pi/?session=child%26id&cwd=%2Fwork%2Fspace+name&view=chat");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noopener");
  });

  it("does not allow arbitrary query links, scripts, or session query image sources", () => {
    const [query, script] = links("[query](?redirect=evil) [script](javascript:alert%281%29) ![image](?session=x&cwd=y&view=chat)");
    expect(query?.hasAttribute("href")).toBe(false);
    expect(script?.hasAttribute("href")).toBe(false);
    expect(document.body.querySelector("img")?.hasAttribute("src")).toBe(false);
  });

  it("does not reuse a cached session URL from another application prefix", () => {
    const markdown = "[worker](?session=x&cwd=y&view=chat)";
    vi.stubEnv("BASE_URL", "/first/");
    expect(links(markdown)[0]?.href).toContain("/first/?session=x");
    vi.stubEnv("BASE_URL", "/second/");
    expect(links(markdown)[0]?.href).toContain("/second/?session=x");
  });
});
