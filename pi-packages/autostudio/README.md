# Autostudio

Autostudio delegates fresh-context workers while keeping the manager's progress
in the Pi Web chat. Every worker is a tracked Pi Web subsession under its manager: open its **Open session**
link while it runs to see its conversation and tool calls.

## Install

```sh
cd /path/to/pi-web/pi-packages/autostudio
npm install --omit=dev --legacy-peer-deps
pi install "$PWD"
```

Reload the extension in an idle session with `/reload`, or open a new session.
Upgrading from independent workers also requires updating and manually restarting
the session daemon; see [operation and limits](docs/operation.md).
For direct `subagent` workflows, also [install or update the supplied role definitions](docs/operation.md#direct-subagent-delegation).

## Use

```text
/autostudio start "your goal" --max 30
/autostudio task "one task to execute and verify"
/autostudio status
/autostudio stop
```

Progress messages persist in the manager's conversation. Worker sessions remain
in the workspace session list after completion; their links also survive a page
reload. Viewing a worker does not launch a second process or write its session
file from another runtime.

See [operation and limits](docs/operation.md).
