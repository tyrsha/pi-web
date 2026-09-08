/**
 * Autostudio — autonomous project-manager loop for Pi.
 *
 * The main Pi session is the Manager. This extension owns the loop mechanics:
 * persistent `.autostudio/` state, next-task selection from ROADMAP.md, worker
 * delegation through pi-subagents to daemon-owned Pi Web sessions,
 * result evaluation, optional reviewer pass, and roadmap/state updates.
 *
 * The loop never stops merely because a worker finished. It stops only for:
 *   1. goal complete (roadmap clear + worker confirms, or explicit marker)
 *   2. genuine human-only blocker with no other useful work remaining
 *   3. STOP file (`/autostudio stop`), safety refusal, or max-task budget
 *
 * Test/build/worker failures, ambiguous designs, and incomplete research are
 * NOT stop reasons — the manager records them and retries with a new strategy.
 */

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDelegation } from "./autostudioDelegation.js";
import { createSessionHost, daemonRequest } from "./autostudioSessions.js";
import {
  addTaskToRoadmap,
  appendToFile,
  blockTaskInRoadmap,
  clearStop,
  completeTaskInRoadmap,
  countFailures,
  detectHumanBlocker,
  extractGoal,
  failureKey,
  formatDecisionEntry,
  formatFailureEntry,
  initWorkspace,
  isInitialized,
  isStopRequested,
  isSubcommand,
  looksLikeFailure,
  looksLikeGoal,
  needsReview,
  nextTaskFromRoadmap,
  parsePlannerTasks,
  readProjectState,
  reportsGoalComplete,
  reportsIncomplete,
  requestStop,
  reviewPassed,
  selectRoleForTask,
  roadmapHasHistory,
  roadmapIsClear,
  tasksInSection,
  updateStateField,
  writeMission,
  writeRoadmap,
  writeState,
} from "./autostudioState.js";

const MAX_TASKS_DEFAULT = 30;
const MAX_TASKS_HARD_CAP = 200;
const OUTPUT_EVAL_CHARS = 12_000;
const FAILURE_STRATEGY_LIMIT = 3;

const WORKER_SYSTEM_PROMPT = `You are an Autostudio worker agent. You run in an isolated, fresh context with one task to complete.

Rules:
- Investigate the repository/workspace yourself as needed; do not assume prior context.
- Do the task, verify it (run tests/builds/checks when relevant), and confirm the acceptance criteria.
- If your first approach fails, try at least one different reasonable approach before giving up.
- Do NOT redesign the roadmap, continue to other milestones, or ask the user questions. Pick a reasonable reversible default for small decisions.
- Report formats: start a line with TASK-FAILED and explain if you cannot complete the task. Never write the literal string TASK-FAILED anywhere else (do not quote it, even when discussing a previous attempt) — the manager treats its presence as failure. If the overall project goal from the task context is fully achieved and verified, emit a line containing exactly GOAL-COMPLETE.
- Deliverables must be findable: place final user-facing artifacts (videos, images, documents, binaries) in a visible, non-dot directory such as ./output/ — never hide them inside .autostudio/ (state files only). Always state the exact workspace-relative paths of every deliverable in your report.

End every report with:
## Completed
## Files Changed
## Notes
`;

const REVIEWER_SYSTEM_PROMPT = `You are an Autostudio reviewer agent running in a fresh context. Independently verify the worker's claimed result against the task and acceptance criteria.

- Re-read the changed files, re-run the relevant checks when feasible.
- Do NOT rewrite the implementation yourself; verify and judge.
- Start exactly one line with either "REVIEW: PASS" or "REVIEW: FAIL" followed by concrete reasons and what must change.
`;

const PLANNER_SYSTEM_PROMPT = `You are an Autostudio planner agent running in a fresh context. Propose the next work slice only.

Rules:
- Output ONLY 3-7 lines, each starting with "- [ ] " followed by one small but meaningful milestone slice.
- No headings, no commentary, no report sections, no code changes.
`;

const RESEARCHER_SYSTEM_PROMPT = `You are an Autostudio researcher agent running in a fresh context. Investigate the assigned question (codebase recon, library comparison, root-cause analysis) and return evidence.

- Cite exact file paths, versions, and commands you ran.
- Compare candidates against the stated requirements, not hype.
- End with a ranked recommendation and the single strongest counter-argument.
- Do NOT implement anything. Output research only, ending with ## Recommendation.
`;

const PLANNER_TASK = `Inspect the repository/workspace, MISSION.md, ROADMAP.md and STATE.md in .autostudio/. The roadmap has no actionable tasks. Propose the 3-7 smallest valuable next tasks as a plain list, one per line starting with "- [ ] ". Keep each task a single meaningful milestone slice with implied acceptance criteria. Output ONLY the task list, no commentary.`;

interface WorkerResult {
  exitCode: number;
  output: string;
  truncated: boolean;
}

function evalSlice(result: WorkerResult): string {
  return result.output.slice(-OUTPUT_EVAL_CHARS);
}

function shortSummary(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

interface LoopOptions {
  dispatch: (role: DispatchRole, task: string) => Promise<WorkerResult>;
  maxTasks: number;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
}

interface LoopOutcome {
  tasksCompleted: number;
  tasksFailed: number;
  stoppedFor: "complete" | "blocked" | "stop" | "budget" | "error";
  detail: string;
}

type DispatchRole = "worker" | "reviewer" | "planner" | "researcher";

function describeWorkPlan(cwd: string, mission: string, task: string, from: "Next" | "Later" | "single"): string {
  return `Project workspace: ${cwd}\n\nOverall mission (.autostudio/MISSION.md):\n${mission}\n\nYour task (${from}):\n${task}\n\nAcceptance: the task is done only when its outcome is implemented AND verified (tests/checks/links as appropriate). Report truthfully; never claim success without verification.`;
}

async function runLoop(cwd: string, options: LoopOptions): Promise<LoopOutcome> {
  let completed = 0;
  let failed = 0;
  // Consecutive planner dispatches that yielded zero tasks. The loop retries
  // once with a different angle (spec: incomplete research is not a blocker)
  // and only then treats the stall as needing human planning input.
  let plannerMisses = 0;

  for (let iteration = 1; iteration <= options.maxTasks; iteration++) {
    if (isStopRequested(cwd)) {
      return { tasksCompleted: completed, tasksFailed: failed, stoppedFor: "stop", detail: "STOP file present — loop halted gracefully." };
    }

    const state = readProjectState(cwd);
    const picked = nextTaskFromRoadmap(state.roadmap);

    if (!picked) {
      // A clear roadmap only means "complete" after at least one task was
      // finished. A fresh workspace (placeholders, no history) needs planning.
      if (roadmapIsClear(state.roadmap) && roadmapHasHistory(state.roadmap)) {
        appendToFile(cwd, "log.md", `## Loop checkpoint\n\nRoadmap is clear after ${String(completed)} completed task(s). Goal treated as complete.`);
        writeState(cwd, updateStateField(state.state, "Last update", "goal complete — roadmap clear"));
        return {
          tasksCompleted: completed,
          tasksFailed: failed,
          stoppedFor: "complete",
          detail: `Roadmap is clear. Completed ${String(completed)} task(s), ${String(failed)} failed. Goal complete.`,
        };
      }
      // No actionable tasks: ask a planner worker to propose the next slice.
      // This covers fresh workspaces as well as stuck states (e.g. In
      // Progress leftovers with empty Next/Later).
      const plannerTask = plannerMisses > 0
        ? `${PLANNER_TASK}\n\nContext: a previous planning attempt produced no usable tasks. Take a different angle: smaller slices, or derive tasks from the most recent worker results and known problems instead of the mission statement.`
        : PLANNER_TASK;
      const planResult = await options.dispatch("planner", describeWorkPlan(cwd, state.mission, plannerTask, "single"));
      const planned = parsePlannerTasks(planResult.output);
      if (planned.length === 0) {
        plannerMisses += 1;
        appendToFile(cwd, "log.md", `## Planner miss (${String(plannerMisses)})\n\nPlanner produced no usable tasks; ${plannerMisses >= 2 ? "giving up planning, human input needed." : "retrying once with a different angle."}`);
        if (plannerMisses >= 2) {
          return { tasksCompleted: completed, tasksFailed: failed, stoppedFor: "blocked", detail: "No actionable tasks and two planner attempts produced nothing usable. Human planning input needed." };
        }
        continue;
      }
      plannerMisses = 0;
      let roadmap = state.roadmap;
      for (const title of planned) {
        roadmap = addTaskToRoadmap(roadmap, "Next", title);
      }
      writeRoadmap(cwd, roadmap);
      appendToFile(cwd, "log.md", `## Planner\n\nAdded ${String(planned.length)} task(s) to Next.`);
      options.notify(`Autostudio: planner proposed ${String(planned.length)} task(s) — starting first one.`, "info");
      continue;
    }

    const { task, from } = picked;
    plannerMisses = 0;
    const priorFailures = countFailures(state.failures, task);
    let workerPrompt = describeWorkPlan(cwd, state.mission, task, from);
    if (priorFailures > 0) {
      workerPrompt += `\n\nContext: this task failed ${String(priorFailures)} time(s) before. DO NOT repeat the previous approach. Change strategy (smaller slice, different tool/library, or fix root cause first). Recent failure log:\n${state.failures.slice(-2000)}`;
    }

    // Manager picks the role by task nature (spec): research-flavored tasks
    // go to a researcher that returns evidence without implementing.
    const role = selectRoleForTask(task);
    const result = await options.dispatch(role, workerPrompt);
    const evalText = evalSlice(result);
    const truncatedNote = result.truncated ? " (eval window truncated)" : "";
    appendToFile(cwd, "log.md", `## Task (iteration ${String(iteration)})\n\n- Task: ${task}\n- Exit: ${String(result.exitCode)}\n- Truncated: ${result.truncated ? "yes" : "no"}${truncatedNote}\n- Summary: ${shortSummary(evalText, 500)}`);

    // Human-only blocker? Scan the full output so early requests are not
    // missed when logs follow. Blocked tasks park in `## Blocked` (never
    // auto-dispatched) instead of Later. Only stop if no other useful work exists.
    const blocker = detectHumanBlocker(result.output);
    if (blocker !== undefined) {
      const remaining = tasksInSection(readProjectState(cwd).roadmap, "Next").filter((t) => failureKey(t) !== failureKey(task));
      appendToFile(cwd, "log.md", `## Blocker\n\n- Task: ${task}\n- Blocker: ${blocker}`);
      if (remaining.length === 0) {
        const parked = blockTaskInRoadmap(readProjectState(cwd).roadmap, task, blocker);
        writeRoadmap(cwd, parked);
        appendToFile(cwd, "DECISIONS.md", formatDecisionEntry(`Parked "${task}" in ## Blocked (${blocker}); stopping because no other independent work remains.`));
        return { tasksCompleted: completed, tasksFailed: failed, stoppedFor: "blocked", detail: `Human-only blocker: ${blocker}. No other independent work remains.` };
      }
      options.notify(`Autostudio: blocker on one task (${blocker}); continuing with ${String(remaining.length)} independent task(s).`, "warning");
      const moved = readProjectState(cwd).roadmap;
      writeRoadmap(cwd, blockTaskInRoadmap(moved, task, blocker));
      failed += 1;
      continue;
    }

    if (reportsGoalComplete(result.output) && roadmapIsClear(completeTaskInRoadmap(readProjectState(cwd).roadmap, task))) {
      // Spec mandates a reviewer pass immediately before final goal completion:
      // a worker's own GOAL-COMPLETE claim is never self-certifying.
      const goalReview = await options.dispatch(
        "reviewer",
        `Overall mission:\n${state.mission}\n\nFinal task:\n${task}\n\nWorker claims the overall goal is complete and verified:\n${evalText}\n\nWorkspace: ${cwd}\n\nVerify the claim against the mission and acceptance criteria.`,
      );
      appendToFile(cwd, "log.md", `## Final review\n\n- Verdict: ${shortSummary(goalReview.output.slice(-2000), 400)}`);
      if (!reviewPassed(goalReview.output)) {
        const reason = shortSummary(goalReview.output.slice(-2000), 400);
        appendToFile(cwd, "FAILURES.md", formatFailureEntry(task, `final review rejected goal completion: ${reason}`, "address the review findings, then re-verify the goal"));
        options.notify("Autostudio: final review rejected goal completion — continuing.", "warning");
        failed += 1;
        continue;
      }
      const roadmap = completeTaskInRoadmap(readProjectState(cwd).roadmap, task, "verified by worker");
      writeRoadmap(cwd, roadmap);
      completed += 1;
      writeState(cwd, updateStateField(updateStateField(readProjectState(cwd).state, "Last successful task", task), "Last update", "goal complete"));
      appendToFile(cwd, "DECISIONS.md", formatDecisionEntry(`Goal declared complete: roadmap clear, worker GOAL-COMPLETE confirmed by independent reviewer (${String(completed)} completed, ${String(failed)} failed).`));
      return { tasksCompleted: completed, tasksFailed: failed, stoppedFor: "complete", detail: `Reviewer confirmed GOAL-COMPLETE with a clear roadmap. Completed ${String(completed)} task(s).` };
    }

    const failedNow = looksLikeFailure(result.exitCode, result.output);
    const consecutive = failedNow ? priorFailures + 1 : priorFailures;

    // Honest-pending reports defer the task: still open, not done, not failed
    // (spec: never declare completion without verification; never punish
    // truthful status). The task stays in Next and is re-checked next round.
    if (!failedNow && reportsIncomplete(result.output)) {
      appendToFile(cwd, "log.md", `## Deferred (iteration ${String(iteration)})\n\n- Task: ${task}\n- State: worker reports outcome not ready yet — kept open, will re-check.`);
      options.notify(`Autostudio: still pending, will re-check — ${shortSummary(task, 80)}`, "info");
      continue;
    }

    // Optional fresh-context review for risky results.
    if (!failedNow && needsReview(task, result.output, priorFailures)) {
      const review = await options.dispatch(
        "reviewer",
        `Task:\n${task}\n\nWorker result to verify:\n${evalText}\n\nWorkspace: ${cwd}`,
      );
      appendToFile(cwd, "log.md", `## Review\n\n- Task: ${task}\n- Verdict: ${shortSummary(review.output.slice(-2000), 400)}`);
      if (reviewPassed(review.output)) {
        options.notify(`Autostudio: review passed — "${shortSummary(task, 80)}".`, "info");
      }
      if (!reviewPassed(review.output)) {
        const reason = shortSummary(review.output.slice(-2000), 400);
        appendToFile(cwd, "FAILURES.md", formatFailureEntry(task, `review rejected: ${reason}`, "fix the review findings with a different approach, then re-verify"));
        options.notify(`Autostudio: review rejected "${shortSummary(task, 80)}" — retrying with feedback.`, "warning");
        failed += 1;
        continue;
      }
    }

    if (failedNow) {
      const reason = shortSummary(evalText, 400) || `exit code ${String(result.exitCode)}`;
      const mustChangeStrategy = consecutive >= FAILURE_STRATEGY_LIMIT;
      appendToFile(
        cwd,
        "FAILURES.md",
        formatFailureEntry(task, reason, mustChangeStrategy ? "MANDATORY strategy change: shrink the task, switch approach/role, or re-plan the milestone" : "retry with a different approach"),
      );
      const current = readProjectState(cwd);
      writeState(cwd, updateStateField(current.state, "Known problems", `${task} — failed ${String(consecutive)}x`));
      if (mustChangeStrategy) {
        appendToFile(cwd, "DECISIONS.md", formatDecisionEntry(`Strategy change mandatory for "${task}" (${String(consecutive)} same-task failures): next attempt must shrink the task, switch approach/role, or re-plan the milestone — no repeats.`));
      }
      options.notify(`Autostudio: task failed (${String(consecutive)}x) — ${shortSummary(task, 80)}`, "warning");
      failed += 1;
      continue;
    }

    const after = readProjectState(cwd);
    writeRoadmap(cwd, completeTaskInRoadmap(after.roadmap, task, "done"));
    writeState(
      cwd,
      updateStateField(updateStateField(after.state, "Last successful task", task), "Current milestone", shortSummary(task, 120)),
    );
    completed += 1;
    options.notify(`Autostudio: task done (${String(iteration)}/${String(options.maxTasks)}) — ${shortSummary(task, 100)}`, "info");
  }

  return {
    tasksCompleted: completed,
    tasksFailed: failed,
    stoppedFor: "budget",
    detail: `Task budget (${String(options.maxTasks)}) exhausted with work remaining. Re-run /autostudio start to continue — no human decisions needed unless blocked.`,
  };
}

function parseMaxTasks(args: string): number {
  const match = /--max[= ](\d+)/.exec(args);
  const parsed = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(Math.floor(parsed), MAX_TASKS_HARD_CAP);
  return MAX_TASKS_DEFAULT;
}

function usage(): string {
  return [
    "Autostudio — autonomous manager loop.",
    "",
    "/autostudio <goal> [--max N]        same as start: init .autostudio/ (if needed) and run the loop",
    "/autostudio start \"<goal>\" [--max N]  explicit form of the above",
    "/autostudio task \"<task>\"              run one worker task, no loop",
    "/autostudio status                      show mission / roadmap / state summary",
    "/autostudio stop                        request a graceful stop (STOP file)",
    "",
    "Workers run as fresh Pi Web sessions. Open them from the links in this chat.",
    "The loop only stops for: goal complete, human-only blocker, stop, or budget.",
  ].join("\n");
}

export default function (pi: Pick<ExtensionAPI, "on" | "events" | "registerCommand" | "sendMessage">) {
  let activeDelegation: { dispose(): void } | undefined;
  pi.on("session_shutdown", () => { activeDelegation?.dispose(); activeDelegation = undefined; });
  pi.registerCommand("autostudio", {
    description: "Autonomous manager loop (start/task/status/stop). See /autostudio help.",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const trimmed = args.trim();
      const [sub, ...rest] = trimmed.split(/\s+/);
      const subArgs = rest.join(" ").trim();
      const notify = (message: string, type: "info" | "warning" | "error" = "info") => {
        pi.sendMessage({ customType: "autostudio-progress", content: message, display: true, details: { level: type } });
      };
      const withWorkers = async <T,>(operation: (dispatch: LoopOptions["dispatch"]) => Promise<T>): Promise<T> => {
        if (activeDelegation !== undefined) throw new Error("Autostudio is already running in this session.");
        const socket = process.env["PI_WEB_SESSIOND_SOCKET"];
        if (socket === undefined || socket === "") throw new Error("Autostudio requires Pi Web's session daemon to create visible worker sessions.");
        const host = createSessionHost(daemonRequest(socket), cwd, ctx.sessionManager.getSessionId(), ctx.model);
        const delegation = await createDelegation(pi, ctx, host, {
          worker: WORKER_SYSTEM_PROMPT, reviewer: REVIEWER_SYSTEM_PROMPT,
          researcher: RESEARCHER_SYSTEM_PROMPT, planner: PLANNER_SYSTEM_PROMPT,
        }, notify);
        activeDelegation = delegation;
        const extraFile = process.env["AUTOSTUDIO_WORKER_PROMPT_FILE"];
        const extra = extraFile !== undefined && extraFile !== "" && existsSync(extraFile) ? readFileSync(extraFile, "utf8") : "";
        const conversation = ctx.sessionManager.getBranch().flatMap((entry) => {
          if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
          const content = entry.message.content;
          const text = typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
          return [`${entry.message.role}: ${text}`];
        }).join("\n\n").slice(-20_000);
        try {
          return await operation((role, task) => delegation.dispatch(role, `${extra}\n\nOriginating conversation (context, not a new assignment):\n${conversation}\n\nCurrent assignment:\n${task}`));
        } finally {
          delegation.dispose();
          if (activeDelegation === delegation) activeDelegation = undefined;
        }
      };

      // DWIM: `/autostudio <goal>` without a subcommand starts the loop, so a
      // plain goal never falls through to a silent usage note. Short single
      // tokens are likely typo'd subcommands and still get usage.
      const known = sub !== undefined && isSubcommand(sub);
      if (sub === "start" || (!known && looksLikeGoal(extractGoal(trimmed)))) {
        const goal = extractGoal(sub === "start" ? subArgs : trimmed);
        if (goal === "") {
          notify('Usage: /autostudio start "your goal" [--max N] (or just /autostudio <your goal>)', "error");
          return;
        }
        if (!isInitialized(cwd)) {
          initWorkspace(cwd, goal);
          notify("Autostudio: workspace initialized (.autostudio/).", "info");
        } else {
          clearStop(cwd);
          const stored = readProjectState(cwd).mission;
          if (!stored.includes(goal)) {
            writeMission(cwd, goal);
            appendToFile(cwd, "log.md", `## Loop started\n\nGoal argument: ${goal}\nMission updated: new goal replaced the stored MISSION.md.`);
            appendToFile(cwd, "DECISIONS.md", formatDecisionEntry(`MISSION.md replaced by explicit new goal argument: "${shortSummary(goal, 200)}". Previous mission text preserved in log history only.`));
            notify("Autostudio: new goal detected — MISSION.md updated (recorded in DECISIONS.md).", "warning");
          } else {
            appendToFile(cwd, "log.md", `## Loop started\n\nGoal argument: ${goal}`);
          }
        }
        const maxTasks = parseMaxTasks(args);
        notify(`Autostudio: manager loop started (budget: ${String(maxTasks)} tasks).`, "info");
        const outcome = await withWorkers((dispatch) => runLoop(cwd, { maxTasks, notify, dispatch }));
        appendToFile(cwd, "log.md", `## Loop ended: ${outcome.stoppedFor}\n\n${outcome.detail}`);
        notify(`Autostudio ended (${outcome.stoppedFor}): ${outcome.detail}`, outcome.stoppedFor === "complete" ? "info" : "warning");
        return;
      }

      if (sub === "task") {
        const task = subArgs.replace(/^["']|["']$/g, "");
        if (!task) {
          notify('Usage: /autostudio task "single task description"', "error");
          return;
        }
        if (!isInitialized(cwd)) initWorkspace(cwd, "(ad-hoc single tasks)");
        const mission = readProjectState(cwd).mission;
        const result = await withWorkers((dispatch) => dispatch(selectRoleForTask(task), describeWorkPlan(cwd, mission, task, "single")));
        appendToFile(cwd, "log.md", `## Single task\n\n- Task: ${task}\n- Exit: ${String(result.exitCode)}\n- Truncated: ${result.truncated ? "yes" : "no"}\n- Summary: ${shortSummary(evalSlice(result), 500)}`);
        notify(`Autostudio single task finished (exit ${String(result.exitCode)}). Open the worker session above for its full conversation.`, result.exitCode === 0 ? "info" : "warning");
        return;
      }

      if (sub === "status") {
        if (!isInitialized(cwd)) {
          notify("Autostudio: not initialized here. Run /autostudio start first.", "warning");
          return;
        }
        const state = readProjectState(cwd);
        const next = nextTaskFromRoadmap(state.roadmap);
        const summary = [
          `Mission: ${shortSummary(state.mission.replace(/^# Mission\s*/, ""), 200)}`,
          `Next: ${next ? next.task : "(none — roadmap clear or replanning needed)"}`,
          `Queued: Next=${String(tasksInSection(state.roadmap, "Next").length)} Later=${String(tasksInSection(state.roadmap, "Later").length)} InProgress=${String(tasksInSection(state.roadmap, "In Progress").length)} Blocked=${String(tasksInSection(state.roadmap, "Blocked").length)}`,
          `Stop requested: ${state.stopRequested ? "yes" : "no"}`,
          `State: ${shortSummary(state.state.replace(/^# State\s*/, ""), 300)}`,
        ].join("\n");
        notify(summary, "info");
        return;
      }

      if (sub === "stop") {
        requestStop(cwd);
        notify("Autostudio: stop requested. The running loop will halt after the current worker finishes.", "warning");
        return;
      }

      notify(usage(), "info");
    },
  });
}
