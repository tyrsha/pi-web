import type { DelegationResult } from "./autostudioDelegation.js";

export const QA_SYSTEM_PROMPT = `You are an Autostudio QA agent in a fresh context. Verify the current delivered project against the entire mission by actually using it. Do not implement fixes or edit .autostudio state.

Mandatory execution:
- Discover the project type and run the actual application/product, not just unit tests, a build, a health check, or a screenshot of its landing page.
- Games: use real player input; verify start, controls, meaningful gameplay/progression, and win/loss plus restart when applicable. Assert observable game state changes. A loaded canvas is NOT playable-game evidence.
- Web/apps: drive critical user journeys in a real browser (Playwright or available browser tools); assert resulting state, persistence when relevant, and error/recovery paths. Do not invoke /gstack qa or any guided workflow.
- API/CLI/library projects: execute end-to-end through the public interface with representative input, real integration boundaries in a safe test environment, and assert outputs/side effects and failure paths. Unit mocks alone are insufficient.
- Non-executable artifacts: open/render/use the actual deliverable in its intended consumer and verify the mission's acceptance criteria. Explain this choice to the reviewer.
- Choose safe local fixtures/test accounts. Never modify production data, bypass permissions, or restart the hosting Pi Web session daemon. Clean up only processes and fixtures you started.
- Missing tooling is work to resolve, not a pass: use blockerKind environment, even for login/payment tests. Use human-only blockerKind credentials, approval, payment, external-account or user-input ONLY when the user must actually supply something you cannot obtain safely. Any required unexecuted scenario means not-run or blocked, never pass.
- Capture reproducible steps, expected vs observed outcomes, exact commands/URLs and log/trace/screenshot paths (visible output/qa/ directory) for each scenario. Report actual evidence only. Test the current files again after any fix; never reuse an old pass.

Return ONLY one JSON object (under 10,000 characters), no markdown or other verdict markers:
{"status":"pass|fail|blocked","kind":"gameplay|e2e|artifact","summary":"concrete outcome","environment":"runtime, target URL/command, tested revision/worktree","scenarios":[{"name":"journey","status":"pass|fail|blocked|not-run","steps":["actual actions"],"expected":"assertion","observed":"actual outcome","evidence":["command plus result or artifact path"]}],"limitations":["remaining gaps; empty if none"],"blockerKind":"none|environment|credentials|approval|payment|external-account|user-input","blocker":"specific requirement, or empty"}
Pass requires every mission-critical scenario actually executed and passed, with no remaining verification gaps. Failures must include reproduction and repair guidance in observed/summary. A reviewer independently checks your coverage and evidence before completion.
`;

export interface QaScenario {
  name: string;
  status: "pass" | "fail" | "blocked" | "not-run";
  steps: string[];
  expected: string;
  observed: string;
  evidence: string[];
}

export interface QaReport {
  status: "pass" | "fail" | "blocked";
  kind: "gameplay" | "e2e" | "artifact";
  summary: string;
  environment: string;
  scenarios: QaScenario[];
  limitations: string[];
  blockerKind: "none" | "environment" | "credentials" | "approval" | "payment" | "external-account" | "user-input";
  blocker: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text);
}
function scenario(value: unknown): value is QaScenario {
  return record(value) && text(value["name"])
    && typeof value["status"] === "string" && ["pass", "fail", "blocked", "not-run"].includes(value["status"])
    && strings(value["steps"]) && value["steps"].length > 0
    && text(value["expected"]) && text(value["observed"])
    && strings(value["evidence"]) && value["evidence"].length > 0;
}
function report(value: unknown): value is QaReport {
  return record(value) && typeof value["status"] === "string" && ["pass", "fail", "blocked"].includes(value["status"])
    && typeof value["kind"] === "string" && ["gameplay", "e2e", "artifact"].includes(value["kind"])
    && text(value["summary"]) && text(value["environment"])
    && Array.isArray(value["scenarios"]) && value["scenarios"].length > 0 && value["scenarios"].every(scenario)
    && strings(value["limitations"]) && typeof value["blocker"] === "string"
    && typeof value["blockerKind"] === "string" && ["none", "environment", "credentials", "approval", "payment", "external-account", "user-input"].includes(value["blockerKind"]);
}

/** Fail closed on incomplete transport or evidence. Coverage truth is independently reviewed. */
export function evaluateQa(result: DelegationResult): { report?: QaReport; passed: boolean; reason: string } {
  if (result.exitCode !== 0 || result.truncated) return { passed: false, reason: "QA execution failed or its report was truncated; rerun QA with a complete concise report." };
  let value: unknown;
  try {
    value = JSON.parse(result.output);
  } catch {
    return { passed: false, reason: "QA did not return the required JSON evidence report." };
  }
  if (!report(value)) return { passed: false, reason: "QA report lacks valid scenarios, steps, assertions, or evidence." };
  const passed = value.status === "pass" && value.scenarios.every((item) => item.status === "pass")
    && value.limitations.length === 0 && value.blockerKind === "none" && value.blocker.trim() === "";
  return { report: value, passed, reason: passed ? value.summary : `QA not passed: ${value.summary}; ${value.limitations.join("; ")}` };
}

/** Structured human-only classification avoids treating words like login as blockers. */
export function qaHumanBlocker(report: QaReport | undefined): string | undefined {
  if (report?.status !== "blocked" || report.blockerKind === "none" || report.blockerKind === "environment" || !text(report.blocker)) return undefined;
  return `${report.blockerKind}: ${report.blocker}`;
}

export function qaCompletionSummary(report: QaReport): string {
  return `QA PASS (${report.kind}): ${report.summary}\nEnvironment: ${report.environment}\n${report.scenarios.map((item) => `- ${item.name}: PASS — ${item.observed}\n  Evidence: ${item.evidence.join("; ")}`).join("\n")}\nFull QA/review history: .autostudio/QA.md`;
}
