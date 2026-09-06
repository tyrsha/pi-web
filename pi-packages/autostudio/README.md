# Autostudio

Autostudio delegates fresh-context workers while keeping the manager's progress
in the Pi Web chat. Every worker is a real Pi Web session: open its **Open session**
link while it runs to see its conversation and tool calls.

## Install

```sh
cd /path/to/pi-web/pi-packages/autostudio
npm install --omit=dev --legacy-peer-deps
pi install "$PWD"
```

Reload the extension in an idle session with `/reload`, or open a new session.
No session-daemon restart is needed for these extension changes.

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
