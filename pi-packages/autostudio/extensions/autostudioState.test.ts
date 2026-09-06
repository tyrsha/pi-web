import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTaskToRoadmap,
  appendToFile,
  blockTaskInRoadmap,
  clearStop,
  completeTaskInRoadmap,
  countFailures,
  countFilesChanged,
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
  PLANNER_TASK_LIMIT,
  readProjectState,
  reportsGoalComplete,
  reportsIncomplete,
  requestStop,
  reviewPassed,
  roadmapContainsTask,
  roadmapHasHistory,
  roadmapIsClear,
  selectRoleForTask,
  tasksInSection,
  updateStateField,
  writeMission,
  writeRoadmap,
  writeState,
} from "./autostudioState.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autostudio-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ROADMAP = `# Roadmap

## Completed

- [x] old task — done

## In Progress

(none)

## Next

- [ ] fix login bug
- [ ] add logout endpoint

## Later

- [ ] polish docs
`;

describe("workspace init", () => {
  it("creates all state files without overwriting MISSION", () => {
    expect(isInitialized(dir)).toBe(false);
    initWorkspace(dir, "ship it");
    expect(isInitialized(dir)).toBe(true);
    expect(readFileSync(join(dir, ".autostudio", "MISSION.md"), "utf8")).toContain("ship it");
    initWorkspace(dir, "other goal");
    expect(readFileSync(join(dir, ".autostudio", "MISSION.md"), "utf8")).toContain("ship it");
  });

  it("stop flag round-trips", () => {
    initWorkspace(dir, "goal");
    expect(isStopRequested(dir)).toBe(false);
    requestStop(dir);
    expect(isStopRequested(dir)).toBe(true);
    clearStop(dir);
    expect(isStopRequested(dir)).toBe(false);
  });
});

describe("roadmap selection", () => {
  it("picks Next before Later", () => {
    expect(nextTaskFromRoadmap(ROADMAP)).toEqual({ task: "fix login bug", from: "Next" });
  });

  it("falls back to Later when Next is empty", () => {
    const withoutNext = ROADMAP.replace("- [ ] fix login bug\n- [ ] add logout endpoint", "(none)");
    expect(nextTaskFromRoadmap(withoutNext)).toEqual({ task: "polish docs", from: "Later" });
  });

  it("distinguishes fresh roadmaps from finished ones", () => {
    expect(roadmapHasHistory(ROADMAP)).toBe(true);
    expect(roadmapHasHistory("# Roadmap\n\n## Next\n\n(none)\n")).toBe(false);
  });

  it("returns undefined and clear=true when nothing actionable remains", () => {
    const cleared = completeTaskInRoadmap(completeTaskInRoadmap(completeTaskInRoadmap(ROADMAP, "fix login bug"), "add logout endpoint"), "polish docs");
    expect(nextTaskFromRoadmap(cleared)).toBeUndefined();
    expect(roadmapIsClear(cleared)).toBe(true);
    expect(roadmapIsClear(ROADMAP)).toBe(false);
  });

  it("completes and adds tasks", () => {
    const done = completeTaskInRoadmap(ROADMAP, "fix login bug", "verified");
    expect(tasksInSection(done, "Next")).toEqual(["add logout endpoint"]);
    expect(done).toContain("- [x] fix login bug — verified");
    const added = addTaskToRoadmap(done, "Next", "new thing");
    expect(tasksInSection(added, "Next")[0]).toBe("add logout endpoint");
    expect(tasksInSection(added, "Next")).toContain("new thing");
  });

  it("adds each task exactly once and keeps headers separated", () => {
    const once = addTaskToRoadmap(ROADMAP, "Next", "new thing");
    expect(tasksInSection(once, "Next").filter((t) => t === "new thing")).toHaveLength(1);
    const twice = addTaskToRoadmap(once, "Next", "new thing");
    expect(twice).toBe(once);
    const done = completeTaskInRoadmap(once, "new thing");
    expect(done).toContain("- [x] new thing\n\n## In Progress");
  });
});

describe("failure tracking", () => {
  it("normalizes keys and counts repeats", () => {
    expect(failureKey("Fix Login BUG!!")).toBe("fix login bug");
    const log = formatFailureEntry("Fix login bug", "r1", "s1") + formatFailureEntry("fix LOGIN bug", "r2", "s2");
    expect(countFailures(log, "fix login bug")).toBe(2);
    expect(countFailures(log, "other task")).toBe(0);
  });
});

describe("command parsing", () => {
  it("recognizes known subcommands", () => {
    expect(isSubcommand("start")).toBe(true);
    expect(isSubcommand("status")).toBe(true);
    expect(isSubcommand("")).toBe(false);
    expect(isSubcommand("stauts")).toBe(false);
    expect(isSubcommand("startx")).toBe(false);
  });

  it("extracts goals minus flags and quotes", () => {
    expect(extractGoal('"ship it" --max 5')).toBe("ship it");
    expect(extractGoal("ship it --max=5")).toBe("ship it");
    expect(extractGoal("  --max 3  ")).toBe("");
  });

  it("treats goal-like text as a loop goal, typos as usage", () => {
    expect(looksLikeGoal("블로그 만들기")).toBe(true);
    expect(looksLikeGoal("create hello.txt containing hi")).toBe(true);
    expect(looksLikeGoal("stauts")).toBe(false);
    expect(looksLikeGoal("리팩토링")).toBe(false);
    expect(looksLikeGoal("")).toBe(false);
    expect(looksLikeGoal("averylongsingletokenwithoutspaces")).toBe(true);
  });
});

describe("manager role selection", () => {
  it("routes research-flavored tasks to the researcher", () => {
    expect(selectRoleForTask("Survey candidate libraries and compare options")).toBe("researcher");
    expect(selectRoleForTask("Investigate the failing test root cause")).toBe("researcher");
    expect(selectRoleForTask("Evaluate three approaches")).toBe("researcher");
  });

  it("routes build tasks to the worker", () => {
    expect(selectRoleForTask("Fix login bug and green the suite")).toBe("worker");
    expect(selectRoleForTask("Implement logout endpoint")).toBe("worker");
  });
});

describe("incomplete-report detection", () => {
  it("defers honest still-pending reports", () => {
    expect(reportsIncomplete("status=pending, attempts=0 — has not reached done yet")).toBe(true);
    expect(reportsIncomplete("render still running, will re-check")).toBe(true);
    expect(reportsIncomplete("waiting for the GPU job to finish")).toBe(true);
  });

  it("does not defer completed work or bare mentions", () => {
    expect(reportsIncomplete("## Completed\nall green, verified")).toBe(false);
    expect(reportsIncomplete("Queue verified: 5 pending concepts")).toBe(false);
    expect(reportsIncomplete("TASK-FAILED\nout of ideas")).toBe(false);
  });
});

describe("change-size detection", () => {
  const report = ["## Completed", "done", "", "## Files Changed", "", "- `a.ts` — x", "- `b.ts` — y", "", "## Notes", "n"].join("\n");

  it("counts file bullets in the Files Changed section", () => {
    expect(countFilesChanged(report)).toBe(2);
    expect(countFilesChanged("## Completed\nno files")).toBe(0);
  });

  it("routes big changes through the reviewer", () => {
    const big = ["## Completed", "done", "", "## Files Changed", "", "- `1`", "- `2`", "- `3`", "- `4`", "- `5`", "- `6`"].join("\n");
    expect(needsReview("fix typo", big, 0)).toBe(true);
    expect(needsReview("fix typo", report, 0)).toBe(false);
  });

  it("formats decision entries", () => {
    expect(formatDecisionEntry("parked X")).toContain("### Decision");
    expect(formatDecisionEntry("parked X")).toContain("parked X");
  });
});

describe("heuristics", () => {
  it("detects genuine human-only blockers", () => {
    expect(detectHumanBlocker("Blocked: I need your API key to proceed")).toContain("credential");
    expect(detectHumanBlocker("cannot proceed, payment required for the plan")).toContain("payment");
    expect(detectHumanBlocker("waiting on you to approve production deploy")).toContain("deploy");
  });

  it("does not treat design ambiguity or test failure as blockers", () => {
    expect(detectHumanBlocker("Two library options exist; I chose axios and all tests pass.")).toBeUndefined();
    expect(detectHumanBlocker("Build failed: missing import in auth.ts, retrying.")).toBeUndefined();
  });

  it("does not flag mere mentions of login/deploy in success reports", () => {
    const report =
      "## Completed\nAll green except 3 pre-existing failures: " +
      "src/server/terminals/terminalService.test.ts (2 failures: login-profile PATH tests). " +
      "Full suite: 3631 passed. Production deploy pipeline untouched.";
    expect(detectHumanBlocker(report)).toBeUndefined();
  });

  it("classifies failures and reviews", () => {
    expect(looksLikeFailure(1, "anything")).toBe(true);
    expect(looksLikeFailure(0, "TASK-FAILED\nout of ideas")).toBe(true);
    expect(looksLikeFailure(0, "## Completed\nall green")).toBe(false);
    expect(needsReview("migrate auth schema", "done, all green", 0)).toBe(true);
    expect(needsReview("fix typo", "done but unverified edge", 0)).toBe(true);
    expect(needsReview("fix typo", "done, all green", 0)).toBe(false);
    expect(needsReview("fix typo", "done, all green", 2)).toBe(true);
    expect(reviewPassed("REVIEW: PASS\nsolid")).toBe(true);
    expect(reviewPassed("REVIEW: FAIL\nmissing tests")).toBe(false);
    expect(reviewPassed("looks good to me")).toBe(false);
    expect(reportsGoalComplete("some text\nGOAL-COMPLETE\nmore")).toBe(true);
    expect(reportsGoalComplete("goal-complete-ish")).toBe(false);
  });
});

describe("state files", () => {
  it("updates STATE fields and appends logs", () => {
    initWorkspace(dir, "goal");
    const before = readProjectState(dir);
    expect(before.mission).toContain("goal");
    const updated = updateStateField(before.state, "Tests", "PASS");
    expect(updated).toContain("- **Tests**: PASS");
    writeState(dir, updated);
    appendToFile(dir, "log.md", "## hi");
    const after = readProjectState(dir);
    expect(after.state).toContain("- **Tests**: PASS");
    expect(after.failures).toContain("# Failures");
  });

  it("round-trips mission and roadmap writes", () => {
    initWorkspace(dir, "goal");
    writeMission(dir, "new goal");
    expect(readProjectState(dir).mission).toContain("new goal");
    const withTask = addTaskToRoadmap(readProjectState(dir).roadmap, "Next", "queued work");
    writeRoadmap(dir, withTask);
    expect(tasksInSection(readProjectState(dir).roadmap, "Next")).toContain("queued work");
    // writeRoadmap normalizes the trailing newline.
    expect(readFileSync(join(dir, ".autostudio", "ROADMAP.md"), "utf8").endsWith("\n")).toBe(true);
  });
});

describe("blocked lifecycle (F-01/F-08)", () => {
  it("parks blocked tasks where the picker never dispatches them", () => {
    const parked = blockTaskInRoadmap(ROADMAP, "fix login bug", "credentials/API key required");
    // Original unchecked line is gone from the pickable queue.
    expect(tasksInSection(parked, "Next")).toEqual(["add logout endpoint"]);
    // Completed records the blocker note.
    expect(parked).toContain("- [x] fix login bug — blocked: credentials/API key required");
    // Blocked section holds the parked copy.
    expect(tasksInSection(parked, "Blocked")).toEqual(["fix login bug (blocked: credentials/API key required)"]);
    // The parked copy is never picked while other work remains.
    expect(nextTaskFromRoadmap(parked)).toEqual({ task: "add logout endpoint", from: "Next" });
  });

  it("ignores Blocked and In Progress when picking and when clear", () => {
    const onlyBlocked = `# Roadmap\n\n## Completed\n\n- [x] a — done\n\n## In Progress\n\n(none)\n\n## Next\n\n(none)\n\n## Later\n\n(none)\n\n## Blocked\n\n- [ ] stuck thing (blocked: credentials/API key required)\n`;
    expect(nextTaskFromRoadmap(onlyBlocked)).toBeUndefined();
    expect(roadmapIsClear(onlyBlocked)).toBe(true);
    const withInProgress = onlyBlocked.replace("## In Progress\n\n(none)", "## In Progress\n\n- [ ] running job");
    expect(nextTaskFromRoadmap(withInProgress)).toBeUndefined();
    expect(roadmapIsClear(withInProgress)).toBe(false);
  });

  it("pins the blocked-key equivalence so dedup cannot silently break", () => {
    // The Completed "— blocked:" note and the Blocked "(blocked:)" copy
    // must stay on the same failureKey, or dedup regresses (F-08).
    expect(failureKey("fix login — blocked: credentials/API key required")).toBe(
      failureKey("fix login (blocked: credentials/API key required)"),
    );
    const parked = blockTaskInRoadmap(ROADMAP, "fix login bug", "credentials/API key required");
    // Both copies share one key, so either exact title is "already known".
    expect(roadmapContainsTask(parked, "fix login bug — blocked: credentials/API key required")).toBe(true);
    expect(roadmapContainsTask(parked, "fix login bug (blocked: credentials/API key required)")).toBe(true);
    // Normal add dedups the parked variants; the forced Blocked copy is the
    // only second entry by design.
    expect(addTaskToRoadmap(parked, "Blocked", "fix login bug (blocked: credentials/API key required)")).toBe(parked);
    expect(addTaskToRoadmap(parked, "Next", "fix login bug — blocked: credentials/API key required")).toBe(parked);
  });

  it("matches completion notes exactly (bare re-queue is a fresh key)", () => {
    // F-18 design note: completion notes change the key, so the bare title
    // is a fresh key. Pin the behavior so a future change is deliberate.
    expect(roadmapContainsTask(ROADMAP, "old task — done")).toBe(true);
    expect(roadmapContainsTask(ROADMAP, "old task")).toBe(false);
    expect(roadmapContainsTask(ROADMAP, "missing task")).toBe(false);
    expect(roadmapContainsTask(ROADMAP, "  ")).toBe(false);
    expect(addTaskToRoadmap(ROADMAP, "Next", "old task — done")).toBe(ROADMAP);
  });
});

describe("planner parsing (F-04)", () => {
  it("extracts only unchecked bullets and caps at the planner limit", () => {
    const output = [
      "# Plan",
      "Some commentary",
      "- [ ] one",
      "- [x] already done",
      "- [ ] two",
      "-",
      "- [ ]   ",
      "- [ ] three",
    ].join("\n");
    expect(parsePlannerTasks(output)).toEqual(["one", "two", "three"]);
    expect(PLANNER_TASK_LIMIT).toBe(7);
  });

  it("caps long planner output and honors an explicit limit", () => {
    const many = Array.from({ length: 9 }, (_, i) => `- [ ] task ${String(i + 1)}`).join("\n");
    const capped = parsePlannerTasks(many);
    expect(capped).toHaveLength(7);
    expect(capped[0]).toBe("task 1");
    expect(parsePlannerTasks(many, 3)).toEqual(["task 1", "task 2", "task 3"]);
  });
});

describe("failure verdict (F-03)", () => {
  it("fails on exit code or explicit worker verdicts only", () => {
    expect(looksLikeFailure(1, "anything")).toBe(true);
    expect(looksLikeFailure(0, "TASK-FAILED\nout of ideas")).toBe(true);
    expect(looksLikeFailure(0, "  TASK-FAILED\nout of ideas")).toBe(true);
    expect(looksLikeFailure(0, "the task could not be completed cleanly")).toBe(true);
  });

  it("does not fail on pasted tool output the worker already handled", () => {
    // F-03 regression: eslint/tsc excerpts with ERROR: lines are a review
    // signal, never a failure verdict.
    expect(looksLikeFailure(0, "eslint output:\nERROR: missing import\nbut build passes")).toBe(false);
    expect(looksLikeFailure(0, "FATAL: something in a pasted log\n## Completed\nall green")).toBe(false);
    expect(looksLikeFailure(0, "## Completed\nall green")).toBe(false);
  });

  it("routes pasted errors and low-confidence output to review", () => {
    // needsReview fires only on line-starting ERROR:/FATAL: markers — the
    // F-03 companion rule to looksLikeFailure ignoring pasted excerpts.
    expect(needsReview("fix typo", "eslint said:\nERROR: missing import\nbut I fixed it", 0)).toBe(true);
    expect(needsReview("fix typo", "FATAL: pasted log excerpt", 0)).toBe(true);
    expect(needsReview("fix typo", "mid-line chatter about ERROR: x", 0)).toBe(false);
    expect(needsReview("fix typo", "done but unverified edge", 0)).toBe(true);
    expect(needsReview("fix typo", "done, all green", 2)).toBe(true);
    expect(needsReview("migrate auth schema", "done, all green", 0)).toBe(true);
    expect(needsReview("review docs wording", "done, all green", 0)).toBe(true);
    expect(needsReview("fix typo", "done, all green", 0)).toBe(false);
  });
});

describe("blocker position sensitivity (F-07)", () => {
  it("still sees an early credential request when logs follow", () => {
    const filler = Array.from({ length: 200 }, () => "filler log line with test output").join("\n");
    const output = `The deploy step needs your API key to proceed and I am blocked.\n${filler}`;
    expect(detectHumanBlocker(output)).toContain("credential");
  });

  it("ignores mere mentions without blocker language", () => {
    expect(detectHumanBlocker("The dashboard renders nicely with no external deps.")).toBeUndefined();
    expect(detectHumanBlocker("Two library options exist; I chose axios and all tests pass.")).toBeUndefined();
    expect(detectHumanBlocker("Build failed: missing import in auth.ts, retrying.")).toBeUndefined();
  });
});

describe("roadmap editing edge cases (F-09)", () => {
  it("drops stale placeholders when the first bullet lands", () => {
    initWorkspace(dir, "goal");
    const fresh = readProjectState(dir).roadmap;
    expect(fresh).toContain("(none — the manager will plan the first tasks)");
    const withTask = addTaskToRoadmap(fresh, "Next", "first task");
    expect(tasksInSection(withTask, "Next")).toEqual(["first task"]);
    expect(withTask).not.toContain("(none — the manager will plan the first tasks)");
  });

  it("creates a missing section and forces duplicates only on request", () => {
    const created = addTaskToRoadmap(ROADMAP, "In Progress", "running job");
    expect(tasksInSection(created, "In Progress")).toEqual(["running job"]);
    const once = addTaskToRoadmap(ROADMAP, "Next", "brand new");
    expect(addTaskToRoadmap(once, "Next", "brand new")).toBe(once);
    const forced = addTaskToRoadmap(once, "Next", "brand new", { force: true });
    expect(tasksInSection(forced, "Next").filter((t) => t === "brand new")).toHaveLength(2);
  });

  it("leaves the roadmap alone for unknown completions", () => {
    expect(completeTaskInRoadmap(ROADMAP, "no such task")).toBe(ROADMAP);
  });

  it("creates Completed when the section is missing", () => {
    const noCompleted = `# Roadmap\n\n## Next\n\n- [ ] solo task\n`;
    const done = completeTaskInRoadmap(noCompleted, "solo task", "done");
    expect(done).toContain("- [x] solo task — done");
    expect(done).toContain("## Completed");
  });
});

describe("state field safety (F-16)", () => {
  it("treats regex characters in field names literally", () => {
    const base = "# State\n\n- **Tests (unit)**: old\n";
    expect(updateStateField(base, "Tests (unit)", "new")).toContain("- **Tests (unit)**: new");
    // A regex-char field must not accidentally rewrite a sibling field.
    const sibling = "# State\n\n- **Tests unit**: keep\n";
    const appended = updateStateField(sibling, "Tests (unit)", "new");
    expect(appended).toContain("- **Tests unit**: keep");
    expect(appended).toContain("- **Tests (unit)**: new");
  });
});

describe("verdict markers", () => {
  it("lets an explicit FAIL win over PASS", () => {
    expect(reviewPassed("REVIEW: PASS\nsolid")).toBe(true);
    expect(reviewPassed("REVIEW: FAIL\nmissing tests")).toBe(false);
    expect(reviewPassed("REVIEW: FAIL\nbad\nREVIEW: PASS\nlater")).toBe(false);
    expect(reviewPassed("looks good to me")).toBe(false);
  });

  it("matches goal markers strictly", () => {
    expect(reportsGoalComplete("some text\nGOAL-COMPLETE\nmore")).toBe(true);
    expect(reportsGoalComplete("  GOAL-COMPLETE  \n")).toBe(true);
    expect(reportsGoalComplete("goal-complete-ish")).toBe(false);
    expect(reportsGoalComplete("GOAL-COMPLETE: almost")).toBe(false);
  });

  it("normalizes failure keys and handles empty input", () => {
    expect(failureKey("Fix Login BUG!!")).toBe("fix login bug");
    expect(failureKey("  ")).toBe("");
    expect(countFailures("", "fix login")).toBe(0);
    expect(countFailures(formatFailureEntry("t", "r", "s"), "  ")).toBe(0);
  });
});
