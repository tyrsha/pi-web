# Autostudio operation

## Ownership

The manager stores MISSION, ROADMAP, STATE, DECISIONS and FAILURES under
`.autostudio/` in the **session workspace**. It delegates through the installed
`nicobailon/pi-subagents` package's public RPC and external-job-provider APIs.
Pi Web owns each worker's runtime, transcript and browser streaming. Autostudio
has no worker subprocess launcher, process watchdog or lifecycle polling loop.

Workers are fresh, independently visible Pi Web sessions named `Autostudio worker`,
`Autostudio reviewer`, `Autostudio planner` or `Autostudio researcher`. They are
not Pi Web tracked-subsessions: the external-job adapter uses the existing public
session API, while pi-subagents owns delegation and completion correlation.

The manager passes its mission, assignment and the latest 20,000 characters of
user/assistant text from the originating conversation. Pi Web also loads the
worker workspace's normal project instructions. Set
`AUTOSTUDIO_WORKER_PROMPT_FILE` to prepend an additional operational context file.
The adapter uses the manager's model when creating a worker.

## Viewing work

The manager writes visible, durable custom chat messages through `pi.sendMessage`.
It does not temporarily redirect the notification tray. Start messages link to
the real worker session, including while its tools and response are streaming.
Open a link in another tab to watch without leaving the manager conversation.
Reloading a browser page does not terminate either session.

## Installation and runtime

Install this package's dependencies before installing its local source path into
Pi. Its manifest loads pi-subagents and Autostudio together. Existing idle sessions
can load changes with `/reload`; new sessions load the installed version directly.
Do not restart the hosting session daemon merely to update this extension.

The visible-session adapter currently requires a local Pi Web session daemon and
its inherited `PI_WEB_SESSIOND_SOCKET`. Standalone TUI-only worker execution and
TCP-only daemon connections are not supported by this adapter. Old
`AUTOSTUDIO_PI_BIN`, `AUTOSTUDIO_EPHEMERAL`, `.autostudio/workers/` log files and
`.autostudio/worker-sessions/` files are no longer the execution/viewing mechanism.

## Limits

- Workers execute sequentially. The task budget defaults to 30 and is capped at 200.
- `/autostudio stop` requests stopping after the current worker. Use the worker
  session's Stop action if you need to stop that worker immediately.
- Reloading the manager disposes its completion listeners; it does not terminate
  daemon-owned workers. Inspect any existing worker before restarting a task.
- Task success and mission completion policy remain heuristic. A completed
  delegation is not independent proof of a business outcome such as an Immich
  upload. Verify external outcomes before trusting a goal-completion claim.
- No git rollback/checkpoint is performed. Preserve your work before long runs.
