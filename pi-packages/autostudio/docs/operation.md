# Autostudio operation

## Ownership

The manager stores MISSION, ROADMAP, STATE, DECISIONS and FAILURES under
`.autostudio/` in the **session workspace**. It delegates through the installed
`nicobailon/pi-subagents` package's public RPC and external-job-provider APIs.
Pi Web owns each worker's runtime, transcript and browser streaming. Autostudio
has no worker subprocess launcher, process watchdog or lifecycle polling loop.

Workers are fresh Pi Web tracked subsessions named `Autostudio worker`,
`Autostudio reviewer`, `Autostudio planner` or `Autostudio researcher`. They appear
nested under their manager in the session list. The adapter uses the parent-scoped
`POST /sessions/:sessionId/subsessions` daemon endpoint; the daemon resolves and
persists the parent relationship and returns native child-completion notifications.
Tracked children cannot create further child sessions through this endpoint.

The manager passes its mission, assignment and the latest 20,000 characters of
user/assistant text from the originating conversation. Pi Web also loads the
worker workspace's normal project instructions. Set
`AUTOSTUDIO_WORKER_PROMPT_FILE` to prepend an additional operational context file.
The adapter uses the manager's model when creating a worker.

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
The tracked-worker endpoint requires an updated session daemon. When upgrading
from independent workers, manually restart the daemon after updating it, then
reload Autostudio. Extension-only updates do not otherwise need a daemon restart.

The visible-session adapter currently requires a local Pi Web session daemon and
its inherited `PI_WEB_SESSIOND_SOCKET`, with session spawning and tracked
subsessions enabled. An older or disabled endpoint fails visibly; Autostudio never
falls back to independent workers. Standalone TUI-only worker execution and
TCP-only daemon connections are not supported by this adapter. Old
`AUTOSTUDIO_PI_BIN`, `AUTOSTUDIO_EPHEMERAL`, `.autostudio/workers/` log files and
`.autostudio/worker-sessions/` files are no longer the execution/viewing mechanism.

## Limits

- Workers execute sequentially. The task budget defaults to 30 and is capped at 200.
- `/autostudio stop` requests stopping after the current worker. Use the worker
  session's Stop action if you need to stop that worker immediately. For direct
  external-job runs, stopping or timing out pi-subagents' waiter does not abort
  the daemon-owned child either; verify the child is idle before replacing it.
- Reloading the manager disposes its completion listeners; it does not terminate
  daemon-owned workers. Inspect any existing worker before restarting a task.
- Task success and mission completion policy remain heuristic. A completed
  delegation is not independent proof of a business outcome such as an Immich
  upload. Verify external outcomes before trusting a goal-completion claim.
- No git rollback/checkpoint is performed. Preserve your work before long runs.
