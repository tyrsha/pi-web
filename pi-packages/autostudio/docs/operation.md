# Autostudio operation

## Ownership

The manager stores MISSION, ROADMAP, STATE, DECISIONS and FAILURES under
`.autostudio/` in the **session workspace**. It delegates through the installed
`nicobailon/pi-subagents` package's public RPC and external-job-provider APIs.
Pi Web owns each worker's runtime, transcript and browser streaming. Autostudio
has no worker subprocess launcher, process watchdog or lifecycle polling loop.

Workers are fresh Pi Web tracked subsessions named `Autostudio worker`,
`Autostudio reviewer`, `Autostudio planner`, `Autostudio researcher` or
`Autostudio qa`. They appear
nested under their manager in the session list. The adapter uses the parent-scoped
`POST /sessions/:sessionId/subsessions` daemon endpoint; the daemon resolves and
persists the parent relationship and returns native child-completion notifications.
Tracked children cannot create further child sessions through this endpoint.

The manager passes its mission, assignment and the latest 20,000 characters of
user/assistant text from the originating conversation. Pi Web also loads the
worker workspace's normal project instructions. Set
`AUTOSTUDIO_WORKER_PROMPT_FILE` to prepend an additional operational context file.
The slash loop selects models using the configuration below instead of inheriting
the originating session's model.

## Model routing

By default, `/autostudio start` and `/autostudio task` select:

- **Manager:** `openai-codex/gpt-6-astra`, `medium` thinking. The originating
  session switches to this model and keeps it after the command. Planning and
  independent review also use this tier.
- **Workers:** `openai-codex/gpt-5.6-sol` and `openai-codex/gpt-5.6-terra`, both
  `medium`. Implementation, research and QA sessions alternate in this order.
  They run sequentially, not as concurrent writers. Each command starts with Sol.
- **Failure escalation:** `openai-codex/gpt-6-astra`, `high`. A failed task's next
  attempt uses this tier, with the previous failure log and instructions to
  change approach. The manager stays at Medium.

Create the package-owned `<workspace>/.pi-web/autostudio.json` to override these
settings. This is separate from PI WEB core's `.pi-web/config.json`:

```json
{
  "manager": { "model": "openai-codex/gpt-6-astra", "thinkingLevel": "medium" },
  "workers": [
    { "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "medium" },
    { "model": "openai-codex/gpt-5.6-terra", "thinkingLevel": "medium" }
  ],
  "escalation": { "model": "openai-codex/gpt-6-astra", "thinkingLevel": "high" }
}
```

Omitted top-level keys retain defaults. Supplied targets require both `model`
(exact `provider/model-id`) and `thinkingLevel`. `workers` replaces the entire
pool and must contain 1–16 targets. Thinking levels are `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, or `max`, subject to model support. The project must be
trusted. Invalid files, unknown models and unsupported levels fail visibly rather
than silently inheriting another model. Models need configured provider access.

`/autostudio config` shows the effective configuration without launching work.
Each start/task command reads it again; file edits take effect on the next command,
not during an active run. Every dispatch records its model and thinking level in
chat and `.autostudio/log.md`.

Nonzero exits, explicit task failure and truncated reports trigger escalation on
the next task attempt. Review rejection also escalates the repair. Persisted
`FAILURES.md` preserves task escalation across resumed runs; unrelated tasks still
use the worker pool. A missed/failed planner attempt retries at the escalation
tier. Failed QA queues an escalated repair and a fresh escalated QA attempt.
Honest pending reports and human-only blockers do not trigger escalation.
Stopped, interrupted or timed-out delegation waits request STOP instead of
starting a potentially concurrent replacement; inspect the child before resuming.

`--max` still bounds loop iterations, including escalated retries. If exhausted,
resume to retry. Ad-hoc `/autostudio task` retries a failed result once at the
escalation tier, then returns its outcome. Direct `subagent` calls use the separate
runner options below; they do not run this automatic routing/retry policy.

## Direct `subagent` delegation

The package also supplies `worker`, `autostudio-reviewer` and
`autostudio-researcher` agent definitions in `agents/`. Their external-job runner
uses the same tracked-subsession endpoint when called with `subagent`,
`runs.run`/`runs.all`, or `/run`—no `/autostudio` invocation is required.
Unrelated native or CLI agents are unchanged.

To install these roles, run from the package directory:

```sh
mkdir -p ~/.pi/agent/agents
cp -n agents/worker.md agents/reviewer.md agents/researcher.md ~/.pi/agent/agents/
```

The copy intentionally preserves existing definitions. For an existing role,
retain its prompt and update these frontmatter fields instead:

```yaml
runner: { type: external-job, provider: autostudio-pi-web }
defaultContext: fresh
async: true
```

Reload the extension in an idle session to register the process-wide provider.
It resolves each job's actual originating session through the daemon, not the
session that happened to register the provider. Existing in-flight native jobs
are not interrupted or retroactively converted; the new runner applies to new
launches. A missing provider or parent fails visibly instead of spawning a hidden
CLI worker. Saved job handles can be reattached without an in-memory session map.

These direct calls pass the role prompt and assignment composed by pi-subagents;
they do not add the slash loop's mission/conversation context automatically.
Include the mission and relevant context in the task as usual. Workers inherit
the parent's current model unless `runner.options.model` is set to a
`provider/model-id` in the role definition. This external-job protocol does not
forward ordinary Pi runner model overrides or tool restrictions to the daemon;
use its runner options for model selection, and do not assume native Pi runner
controls apply. For example:

```yaml
runner: { type: external-job, provider: autostudio-pi-web, options: { model: openai-codex/gpt-5.6-luna } }
```

## Viewing work

The manager writes visible, durable custom chat messages through `pi.sendMessage`.
It does not temporarily redirect the notification tray. For `/autostudio`, start messages link to
the real worker session, including while its tools and response are streaming.
Open a link in another tab to watch without leaving the manager conversation.
Reloading a browser page does not terminate either session. Direct `subagent`
workers appear under the originating session in the sidebar; their handles are
also available in pi-subagents run results. Native completion reports return to
the parent chat.

## Installation and runtime

Install this package's dependencies before installing its local source path into
Pi. Its manifest loads pi-subagents and Autostudio together. Existing idle sessions
can load changes with `/reload`; new sessions load the installed version directly.
The tracked-worker endpoint requires an updated session daemon, including support
for the optional `thinkingLevel` creation field. This applies the child's level
before its first prompt without changing the parent. When upgrading from an older
endpoint, manually restart the daemon after updating it, then reload Autostudio.
The adapter does not drop an unsupported thinking override as a fallback.
Extension-only updates after that do not otherwise need a daemon restart.

The visible-session adapter currently requires a local Pi Web session daemon and
its inherited `PI_WEB_SESSIOND_SOCKET`, with session spawning and tracked
subsessions enabled. An older or disabled endpoint fails visibly; Autostudio never
falls back to independent workers. Standalone TUI-only worker execution and
TCP-only daemon connections are not supported by this adapter. Old
`AUTOSTUDIO_PI_BIN`, `AUTOSTUDIO_EPHEMERAL`, `.autostudio/workers/` log files and
`.autostudio/worker-sessions/` files are no longer the execution/viewing mechanism.

## Required acceptance QA

`/autostudio start` follows implementation → final QA → independent final review
→ completion report. A clear roadmap or worker `GOAL-COMPLETE` marker is not
completion evidence. Resuming an already-clear roadmap also runs fresh QA; a
previous pass is never reused. Blocked roadmap tasks prevent mission completion.

The separate QA session must actually use the current deliverable:

- **Games:** start the game, exercise player controls and meaningful progression,
  and verify end conditions and restart where applicable. Loading the canvas,
  compiling the game or taking a title-screen screenshot is insufficient.
- **Web/apps:** use a real browser to exercise critical user journeys and assert
  resulting state, including persistence and error/recovery paths where relevant.
- **API/CLI/library projects:** execute end-to-end through the public interface
  with representative inputs and verify outputs and side effects in a safe test
  environment. Mock-only unit tests and health checks do not substitute for E2E.
- **Non-executable artifacts:** open/render/use the delivered artifact in its
  intended consumer and check mission acceptance criteria.

QA uses available browser/automation tools directly; it does not require or
invoke the `/gstack qa` guided workflow. The QA agent returns a structured JSON
report with project kind, environment, scenarios, actual steps, expected/observed
outcomes, evidence references, limitations and a structured blocker category
(environment versus human-only credentials/approval/payment/account/user input).
The current verification status resets on each run, so a prior pass is never
shown as current while fresh work or QA is pending. Empty, malformed,
truncated, failed or incomplete execution reports cannot pass. Any required
unexecuted scenario or remaining verification gap prevents a pass. An independent
reviewer checks the project classification, mission coverage and evidence before
completion is reported; this is an agent-evidence gate, not cryptographic proof
that a reported interaction occurred.

Every attempt and final review is retained in `.autostudio/QA.md`. Screenshots,
traces and other QA artifacts belong in a visible directory such as `output/qa/`.
The completion chat report includes scenario outcomes and evidence references.
Failed QA or rejected final review queues a repair task with the recorded
findings, then runs fresh QA after repair. Missing local tools are repair work;
human-only credentials or approvals park a blocked task instead. Resolve parked
tasks in the roadmap before resuming. Stop/budget exhaustion leaves the mission
incomplete, including when implementation finished but final QA did not run.

`/autostudio task` and direct `subagent` calls remain single-task operations; they
do not run the manager's mission-completion gate. Use `/autostudio start` for the
full implementation/QA/repair/report loop.

## Limits

- Workers execute sequentially. The loop-iteration budget defaults to 30 and is
  capped at 200. Planning, task attempts and final QA attempts consume iterations;
  associated reviews run within that iteration.
- `/autostudio stop` requests stopping after the current worker. Use the worker
  session's Stop action if you need to stop that worker immediately. For direct
  external-job runs, stopping or timing out pi-subagents' waiter does not abort
  the daemon-owned child either; verify the child is idle before replacing it.
- Reloading the manager disposes its completion listeners; it does not terminate
  daemon-owned workers. Inspect any existing worker before restarting a task.
- Task-result classification remains heuristic. The final QA gate validates
  report structure and explicit verdicts; the independent reviewer evaluates
  evidence and mission coverage. A completed delegation alone is not proof of
  an external business outcome such as an Immich upload.
- No git rollback/checkpoint is performed. Preserve your work before long runs.
