/**
 * Pure filesystem logic for the Autostudio autonomous-manager loop.
 *
 * Everything here operates on the `.autostudio/` workspace directory and is
 * intentionally free of Pi APIs so it can be unit-tested in isolation.
 * The state files are the manager's source of truth across loop iterations:
 *
 *   .autostudio/
 *     MISSION.md    long-lived goal + completion criteria
 *     ROADMAP.md    Completed / In Progress / Next / Later task lists
 *     STATE.md      short machine-updated status snapshot
 *     DECISIONS.md  append-only decision log
 *     FAILURES.md   append-only failure log (used for retry strategy)
 *     STOP          presence of this file requests a graceful stop
 *     log.md        append-only per-task history
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AUTOSTUDIO_DIR = ".autostudio";

export const ROADMAP_SECTIONS = ["Completed", "In Progress", "Next", "Later", "Blocked"] as const;
export type RoadmapSection = (typeof ROADMAP_SECTIONS)[number];

export interface ProjectState {
  mission: string;
  roadmap: string;
  state: string;
  decisions: string;
  failures: string;
  stopRequested: boolean;
}

export function autostudioDir(cwd: string): string {
  return join(cwd, AUTOSTUDIO_DIR);
}

export function isInitialized(cwd: string): boolean {
  return existsSync(join(autostudioDir(cwd), "MISSION.md"));
}

export function isStopRequested(cwd: string): boolean {
  return existsSync(join(autostudioDir(cwd), "STOP"));
}

export function requestStop(cwd: string): void {
  mkdirSync(autostudioDir(cwd), { recursive: true });
  writeFileSync(join(autostudioDir(cwd), "STOP"), "stop requested\n", "utf8");
}

export function clearStop(cwd: string): void {
  const stopFile = join(autostudioDir(cwd), "STOP");
  if (existsSync(stopFile)) unlinkSync(stopFile);
}

function readIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function missionTemplate(goal: string): string {
  return `# Mission\n\n${goal.trim()}\n\n## Priorities\n\n1. Real user/project value first\n2. Keep the workspace in a working state\n3. Minimal complexity\n4. Verifiable results\n\n## Completion criteria\n\n- [ ] Goal achieved and verified\n`;
}

function roadmapTemplate(): string {
  return `# Roadmap\n\n## Completed\n\n(none yet)\n\n## In Progress\n\n(none)\n\n## Next\n\n(none — the manager will plan the first tasks)\n\n## Later\n\n(none)\n\n## Blocked\n\n(none — human-only blockers wait here, never auto-dispatched)\n`;
}

function stateTemplate(): string {
  return `# State\n\n- **Current milestone**: not started\n- **Tests**: unknown\n- **Known problems**: none recorded\n- **Last successful task**: none\n- **Last update**: not yet\n`;
}

function decisionsTemplate(): string {
  return `# Decisions\n\nAppend-only log. Newest entries go at the bottom.\n`;
}

function failuresTemplate(): string {
  return `# Failures\n\nAppend-only log. Record what failed, why, and what strategy to try next.\n`;
}

export function initWorkspace(cwd: string, goal: string): void {
  const dir = autostudioDir(cwd);
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {
    "MISSION.md": missionTemplate(goal),
    "ROADMAP.md": roadmapTemplate(),
    "STATE.md": stateTemplate(),
    "DECISIONS.md": decisionsTemplate(),
    "FAILURES.md": failuresTemplate(),
    "log.md": "# Autostudio log\n",
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    if (!existsSync(path)) writeFileSync(path, content, "utf8");
  }
  clearStop(cwd);
}

export function readProjectState(cwd: string): ProjectState {
  const dir = autostudioDir(cwd);
  return {
    mission: readIfExists(join(dir, "MISSION.md")),
    roadmap: readIfExists(join(dir, "ROADMAP.md")),
    state: readIfExists(join(dir, "STATE.md")),
    decisions: readIfExists(join(dir, "DECISIONS.md")),
    failures: readIfExists(join(dir, "FAILURES.md")),
    stopRequested: isStopRequested(cwd),
  };
}

export function appendToFile(cwd: string, name: string, entry: string): void {
  mkdirSync(autostudioDir(cwd), { recursive: true });
  const path = join(autostudioDir(cwd), name);
  const current = readIfExists(path);
  const separator = current.endsWith("\n") || current === "" ? "" : "\n";
  writeFileSync(path, `${current}${separator}${entry.trim()}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Roadmap parsing / mutation
// ---------------------------------------------------------------------------

function sectionRange(lines: string[], section: RoadmapSection): { start: number; end: number } | undefined {
  const header = `## ${section}`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** All unchecked `- [ ] ...` task lines inside a section, in order. */
export function tasksInSection(roadmap: string, section: RoadmapSection): string[] {
  const lines = roadmap.split("\n");
  const range = sectionRange(lines, section);
  if (!range) return [];
  const tasks: string[] = [];
  for (let i = range.start + 1; i < range.end; i++) {
    const match = /^\s*-\s*\[\s\]\s+(.+)$/.exec(lines[i] ?? "");
    const title = match?.[1];
    if (title !== undefined && title !== "") tasks.push(title.trim());
  }
  return tasks;
}

/**
 * Highest-value next task: first unchecked item in Next, otherwise first
 * unchecked item in Later (caller should promote it). In Progress items are
 * owned by a running worker and `## Blocked` items wait for a human — both
 * are never picked.
 */
export function nextTaskFromRoadmap(roadmap: string): { task: string; from: "Next" | "Later" } | undefined {
  const next = tasksInSection(roadmap, "Next");
  if (next[0] !== undefined) return { task: next[0], from: "Next" };
  const later = tasksInSection(roadmap, "Later");
  if (later[0] !== undefined) return { task: later[0], from: "Later" };
  return undefined;
}

/** True once at least one task was ever completed (a `- [x]` marker exists). */
export function roadmapHasHistory(roadmap: string): boolean {
  return /^\s*-\s*\[x\]\s+.+$/m.test(roadmap);
}

/** True when no unchecked task remains in Next / Later / In Progress.
 * `## Blocked` is intentionally ignored: blocked items wait for a human and
 * never make the roadmap "not clear" on their own. */
export function roadmapIsClear(roadmap: string): boolean {
  return (
    tasksInSection(roadmap, "Next").length === 0 &&
    tasksInSection(roadmap, "Later").length === 0 &&
    tasksInSection(roadmap, "In Progress").length === 0
  );
}

/**
 * Mark the exact unchecked task line as done and move it under
 * `## Completed` with an optional note. Returns the updated roadmap text.
 */
export function completeTaskInRoadmap(roadmap: string, task: string, note?: string): string {
  const lines = roadmap.split("\n");
  const escaped = task.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^(\\s*-\\s*)\\[\\s\\]\\s+${escaped}\\s*$`);
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) return roadmap;
  lines.splice(index, 1);
  const completed = sectionRange(lines, "Completed");
  const entry = `- [x] ${task}${note !== undefined ? ` — ${note}` : ""}`;
  if (!completed) {
    lines.push("", "## Completed", "", entry);
    return lines.join("\n");
  }
  const insertAt = completed.end;
  const before: string = lines[insertAt - 1] ?? "";
  const padding = before.trim() === "" ? [] : [""];
  const followsHeader = /^##\s/.test(lines[insertAt] ?? "");
  lines.splice(insertAt, 0, ...padding, entry, ...(followsHeader ? [""] : []));
  return lines.join("\n");
}

/** Placeholder-only lines (e.g. `(none)`) removed when a section gains its first bullet. */
function isPlaceholderLine(line: string): boolean {
  return /^\s*\(none[\s\S]*\)\s*$/.test(line);
}

/** Append an unchecked task bullet under the given section (no duplicates). */
export function addTaskToRoadmap(roadmap: string, section: RoadmapSection, task: string, options?: { force?: boolean }): string {
  if (options?.force !== true && roadmapContainsTask(roadmap, task)) return roadmap;
  const lines = roadmap.split("\n");
  const range = sectionRange(lines, section);
  const entry = `- [ ] ${task}`;
  if (!range) {
    lines.push("", `## ${section}`, "", entry);
    return lines.join("\n");
  }
  // Drop stale `(none)` placeholders so the first real bullet reads cleanly.
  for (let i = range.end - 1; i > range.start; i--) {
    if (isPlaceholderLine(lines[i] ?? "")) lines.splice(i, 1);
  }
  const refreshed = sectionRange(lines, section) ?? range;
  const lastLine: string = lines[refreshed.end - 1] ?? "";
  const padding = lastLine.trim() === "" ? [] : [""];
  lines.splice(refreshed.end, 0, ...padding, entry);
  return lines.join("\n");
}

/**
 * Move a human-blocked task out of the pickable queue into `## Blocked`
 * (which `nextTaskFromRoadmap` never picks) and record it as done with a
 * `blocked:` note so it is never redispatched for a full worker run.
 */
export function blockTaskInRoadmap(roadmap: string, task: string, label: string): string {
  const done = completeTaskInRoadmap(roadmap, task, `blocked: ${label}`);
  // Force: the Completed `— blocked:` note and this `(blocked:)` copy share a
  // failureKey by design (see roadmapContainsTask), so a normal add would
  // dedup-drop the Blocked entry.
  return addTaskToRoadmap(done, "Blocked", `${task} (blocked: ${label})`, { force: true });
}

/** True when a task with the same normalized key already exists anywhere.
 *
 * NOTE: `failureKey` normalization is load-bearing here — a Completed entry
 * like `"fix login \u2014 blocked: X"` and its Later/Blocked copy
 * `"fix login (blocked: X)"` collapse to the same key on purpose so blocked
 * retries dedup. Keep the punctuation in `blockTaskInRoadmap` in sync.
 */
export function roadmapContainsTask(roadmap: string, task: string): boolean {
  const wanted = failureKey(task);
  if (wanted === "") return false;
  const bullets = roadmap.match(/^\s*-\s*\[[ x]\]\s+(.+)$/gm) ?? [];
  return bullets.some((bullet) => {
    const title = /^\s*-\s*\[[ x]\]\s+(.+)$/.exec(bullet)?.[1] ?? "";
    return failureKey(title) === wanted;
  });
}

export function writeRoadmap(cwd: string, roadmap: string): void {
  mkdirSync(autostudioDir(cwd), { recursive: true });
  writeFileSync(join(autostudioDir(cwd), "ROADMAP.md"), roadmap.endsWith("\n") ? roadmap : `${roadmap}\n`, "utf8");
}

/** Replace one `- **Field**: value` line in STATE.md, or append it. */
export function updateStateField(state: string, field: string, value: string): string {
  const lines = state.split("\n");
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^(\\s*-\\s*\\*\\*${escapedField}\\*\\*\\s*:).*`);
  const index = lines.findIndex((line) => pattern.test(line));
  const replacement = `- **${field}**: ${value}`;
  if (index === -1) {
    lines.push(replacement);
    return lines.join("\n");
  }
  lines[index] = replacement;
  return lines.join("\n");
}

/** Append-only decision record (spec: DECISIONS.md is maintained by the loop). */
export function formatDecisionEntry(text: string): string {
  return `\n### Decision\n\n${text.trim()}\n`;
}

/**
 * Manager role selection by task nature (spec: the manager picks the role
 * that fits the task). Research-flavored tasks go to a researcher that
 * returns evidence without implementing; everything else goes to a worker.
 */
export type DispatchableRole = "worker" | "researcher";

export function selectRoleForTask(task: string): DispatchableRole {
  if (/research|survey|investigat|compar|evaluat|recon|options|literature/i.test(task)) return "researcher";
  return "worker";
}

/**
 * Honest-pending detection: the worker truthfully reports the outcome is not
 * ready yet (still running/queued, results pending). Such reports must defer
 * the task — never complete it (spec: no unverified completion claims) and
 * never count it as a failure (the worker did nothing wrong).
 */
export function reportsIncomplete(output: string): boolean {
  return /still (pending|running|queued|in progress)|not yet (done|complete|finished|ready)|has ?not (yet )?(reached|finished|completed)|waiting for .{0,80}? to (finish|complete|be done)/i.test(output);
}

/**
 * Count file bullets under the worker report's `## Files Changed` section.
 * Used to route big changes through the reviewer (spec: big changes get
 * reviewed). Returns 0 when the section is absent.
 */
export function countFilesChanged(output: string): number {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => /^\s*##\s+Files Changed\s*$/.test(line));
  if (start === -1) return 0;
  let count = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*##\s+\S/.test(line)) break;
    if (/^\s*-\s+\S/.test(line)) count += 1;
  }
  return count;
}

export function writeMission(cwd: string, goal: string): void {
  mkdirSync(autostudioDir(cwd), { recursive: true });
  writeFileSync(join(autostudioDir(cwd), "MISSION.md"), missionTemplate(goal), "utf8");
}

export function writeState(cwd: string, state: string): void {
  mkdirSync(autostudioDir(cwd), { recursive: true });
  writeFileSync(join(autostudioDir(cwd), "STATE.md"), state.endsWith("\n") ? state : `${state}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Failure tracking (same task + same failure must force a strategy change)
// ---------------------------------------------------------------------------

/** Normalized key so "Fix login bug!!" and "fix login bug" count together. */
export function failureKey(task: string): string {
  return task.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function countFailures(failuresLog: string, task: string): number {
  const key = failureKey(task);
  if (!key) return 0;
  const pattern = new RegExp(`^###\\s+FAIL\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "gm");
  return failuresLog.match(pattern)?.length ?? 0;
}

export function formatFailureEntry(task: string, reason: string, nextStrategy: string): string {
  return `\n### FAIL ${failureKey(task)}\n\n- Task: ${task}\n- Reason: ${reason}\n- Next strategy: ${nextStrategy}\n`;
}

// ---------------------------------------------------------------------------
// Heuristics: blockers, failures, review triggers
// ---------------------------------------------------------------------------

const HUMAN_BLOCKER_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /api\s?key|secret|token|password|credential/i, label: "credentials/API key required" },
  { pattern: /payment|billing|credit\s?card|subscribe|subscription|paid\s+plan/i, label: "payment/subscription required" },
  { pattern: /sign\s?up|sign\s?in|log\s?in|2fa|otp|mfa|captcha/i, label: "external account/login required" },
  { pattern: /production\s+deploy|deploy\s+approval|approve.+production/i, label: "production deploy approval required" },
  { pattern: /delete.+production|drop\s+database|rm\s+-rf\s+\/|format\s+disk|irreversible/i, label: "irreversible/destructive action approval required" },
  { pattern: /license\s+approval|legal|court|compliance\s+approval/i, label: "legal/license decision required" },
];

/**
 * Detect a genuine human-only blocker in worker output. Design decisions,
 * naming, library choice, test/build failures, and incomplete research are
 * deliberately NOT blockers — the manager must pick a reversible default.
 */
const BLOCKER_LANGUAGE =
  /block(ed|er|ing)|cannot proceed|need(s|ed)? (you|human|approval)|waiting (for|on) (you|human)|required from you|requires? yours?|need(s|ed)? (an?\s+)?(api\s?key|secret|token|password|credential|payment)/i;

export function detectHumanBlocker(output: string): string | undefined {
  // High-precision credential/payment signals are scanned across the full
  // output so an early request is not missed when logs follow (F-07), but
  // only when blocker-adjacent language appears somewhere too.
  for (const { pattern, label } of HUMAN_BLOCKER_PATTERNS.slice(0, 2)) {
    if (pattern.test(output) && BLOCKER_LANGUAGE.test(output)) return label;
  }
  // Low-precision patterns (login, deploy, legal, ...) only count on a line
  // that itself carries blocker-adjacent language, so mere mentions such as
  // "login-profile PATH tests" in a success report are never blockers.
  for (const line of output.split("\n")) {
    if (!BLOCKER_LANGUAGE.test(line)) continue;
    for (const { pattern, label } of HUMAN_BLOCKER_PATTERNS.slice(2)) {
      if (pattern.test(line)) return label;
    }
  }
  return undefined;
}

export const AUTOSTUDIO_SUBCOMMANDS = ["start", "task", "status", "stop", "help"] as const;

export function isSubcommand(token: string): boolean {
  return AUTOSTUDIO_SUBCOMMANDS.some((sub) => sub === token);
}

/** Remove `--max N` flags and one layer of surrounding quotes. */
export function extractGoal(args: string): string {
  return args.replace(/--max[= ]\d+/g, "").trim().replace(/^["']|["']$/g, "").trim();
}

/**
 * DWIM guard: an unknown first token that looks like a goal (multi-word, or
 * a long single token) starts the loop; a short single token is probably a
 * typo'd subcommand and gets the usage text instead.
 */
export function looksLikeGoal(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (/\s/.test(trimmed)) return true;
  return Array.from(trimmed).length >= 10;
}

/** Explicit goal-complete marker the manager prompt instructs workers to emit. */
export function reportsGoalComplete(output: string): boolean {
  return /^\s*GOAL-COMPLETE\s*$/m.test(output);
}

export function looksLikeFailure(exitCode: number, output: string): boolean {
  if (exitCode !== 0) return true;
  // Explicit worker verdicts only (F-03/F-06): bare ERROR:/FATAL: lines are
  // often pasted tool output for failures the worker already fixed, so they
  // are a review signal (see needsReview), never a failure verdict. Scan the
  // full output so an early TASK-FAILED is not missed when logs follow.
  if (/^\s*TASK-FAILED/m.test(output)) return true;
  return /task (could not|failed|couldn't) be completed/i.test(output);
}

const LOW_CONFIDENCE = /not sure|uncertain|low confidence|unverified|TODO|FIXME|best effort|partially (done|complete)/i;

/** Big-change threshold: this many touched files (or more) routes to review. */
export const BIG_CHANGE_FILE_COUNT = 5;

/**
 * Decide whether a fresh-context reviewer should verify this result before
 * the roadmap is updated. Cheap successful tasks skip review; risky ones don't.
 */
export function needsReview(task: string, output: string, consecutiveFailures: number): boolean {
  if (consecutiveFailures > 0) return true;
  if (LOW_CONFIDENCE.test(output)) return true;
  if (/^\s*(ERROR:|FATAL:)/m.test(output)) return true;
  if (countFilesChanged(output) >= BIG_CHANGE_FILE_COUNT) return true;
  if (/\[review\]|\breview\b/i.test(task)) return true;
  if (/schema|migration|auth|security|payment|deploy/i.test(task)) return true;
  return false;
}

export const PLANNER_TASK_LIMIT = 7;

/** Extract `- [ ]` task titles from planner output, capped at `limit`. */
export function parsePlannerTasks(output: string, limit: number = PLANNER_TASK_LIMIT): string[] {
  const titles: string[] = [];
  for (const line of output.split("\n")) {
    if (!/^\s*-\s*\[\s\]\s+.+/.test(line)) continue;
    const title = line.replace(/^\s*-\s*\[\s\]\s+/, "").trim();
    if (title) titles.push(title);
    if (titles.length >= limit) break;
  }
  return titles;
}

/** Reviewer verdict: PASS only on an explicit pass marker. */
export function reviewPassed(output: string): boolean {
  if (/^\s*REVIEW:\s*FAIL/m.test(output)) return false;
  return /^\s*REVIEW:\s*PASS/m.test(output);
}
