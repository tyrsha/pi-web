# Agent Notes

This project is expected to run locally using split systemd user services:

- `pi-web-sessiond.service` runs `npm run start:sessiond` in non-autoreload, non-auto-restart mode.
- `pi-web-ui-dev.service` runs the web/API and Vite UI in dev autoreload mode with `npm run dev:web` and `npm run dev:client`.

When working on this project, assume the session runtime owner is long-lived and separate from the autoreloading UI/API process. Browser disconnects and UI/API restarts should not stop active Pi sessions.

If you make changes that affect `src/server/sessiond.ts`, session runtime ownership, the session daemon protocol, or any code path only loaded by the session daemon, inform the user that a manual restart of the session daemon is needed.

Changes to the web/API/UI side generally only require the `pi-web-ui-dev.service` autoreload/restart path.

## Documentation boundaries

`README.md` is a concise landing page and quick start. Keep it focused on what PI WEB is, basic requirements, the shortest supported install path, essential commands, the core model, and links to detailed documentation.

Put installation variants, troubleshooting, configuration details, operational behavior, architecture, edge cases, and exhaustive explanations under `docs/`. Avoid duplicating detailed documentation in the README; link to its canonical location instead.

Use `.agents/skills/documentation-guide/SKILL.md` whenever writing, modifying, reviewing, or planning user-facing documentation.

## Testing guidance

Project-specific testing rules live in `.agents/skills/testing-guide/SKILL.md`.

Use that skill whenever writing, modifying, reviewing, or planning tests, closing coverage gaps, triaging test failures, or creating test helpers/harnesses. Keep detailed testing conventions there rather than growing this top-level orientation file.

## Verification reporting

Never report failed, incomplete, or skipped verification as passing. Identify any expected check that was not run and why, and do not mask a non-zero result. If a command intentionally probes a failure path or captures an exit for inspection, state that purpose and interpret the result.

## Client application URL convention

- Build PI WEB-owned browser paths as application-relative references without a leading slash, for example `api/...` and `pi-web-plugins/...`.
- Encode every dynamic path segment with `encodeURIComponent`; encode query values, using `URLSearchParams` for multi-field queries.
- Resolve each reference exactly once at the browser boundary: ordinary JSON HTTP paths go to `request()`, direct browser APIs receive URLs from helpers backed by `resolveAppUrl()`, and WebSockets use `resolveAppWebSocketUrl()`.
- Name helpers returning unresolved application references with a `Path` suffix and helpers returning browser-ready absolute values with a `Url` suffix.
- Plugin module references must go through `resolvePluginModuleUrl()`. Its leading-slash handling is the documented rolling-compatibility exception; do not introduce other leading-root app references.
- Pre-JavaScript HTML assets use Vite `%BASE_URL%`; PWA manifest references stay `./`-relative. External links, data URLs, and module-relative plugin assets are not application paths.
- To assess deviations, search production client code for raw `fetch`, `WebSocket`, `XMLHttpRequest`, URL-bearing DOM attributes, and leading `/api` or `/pi-web-plugins` literals. Every app-owned result must follow one of the boundaries above.
- Published nested deployments require a canonical trailing slash; the reverse proxy must redirect a slashless prefix before serving the app.

## Configuration conventions

- `$PI_WEB_DATA_DIR` (`~/.pi-web` by default) contains PI WEB-managed state such as `projects.json` and `machines.json`; do not treat it as the user-editable config API.
- Global user/machine config lives at `$PI_WEB_CONFIG` or `~/.config/pi-web/config.json`.
- Project-local PI WEB core config should use one commit-able file: `<project>/.pi-web/config.json`.
- Core features should add keys to these config files, not create one project file per feature.
- Plugins may own separate project config files, such as `.pi-web/tasks.json`.

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
