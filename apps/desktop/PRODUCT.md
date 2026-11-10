# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The UI is a React app in a Tauri 2 webview (WebView2 on Windows, WebKit on macOS and Linux). It is a cross-platform desktop app, not a native-design-language app.

## Users

The owner, a developer who uses Windows day to day. They keep a folder of small TypeScript scripts, often written with a local coding agent (Claude Code, Codex, Gemini CLI, OpenCode), and want to run them without opening a terminal or remembering arguments.

It is built for the owner first. Later it may be shared with other developers, so it should make sense to someone who did not build it, but no feature is added only for them.

## Product Purpose

Yenae Script runs your own scripts through one flow: pick a script, fill in its generated form, run it, watch the live output, then see it in history. Scripts can also run on interval schedules while the app sits in the tray.

It is also where scripts get written. Local agents write and run scripts through its MCP server, and the app can open the user's installed agent in a terminal, in the scripts folder, with the task. Yenae Script has no agent of its own.

Success: a script written once can be run months later by picking it and filling a form, and schedules keep running reliably in the background.

## Positioning

The answer to Script Kit being too complex and not built around "UI, then run script". Here a script's form is generated from its `defineScript` params (text, number, boolean, select, file, folder). Scripts are plain TypeScript files in ordinary npm projects, so agents and editors can work on them directly. While a script runs it can ask questions (`ask.*`) and show tables and markdown (`show.*`) in the app.

Unrelated to the Yenae bot platform. It shares no code, branding or assets with that repository.

## Operating Context

- Opened with `Ctrl+Shift+Space` (`Cmd+Shift+Space` on macOS) or from the tray. Closing the window keeps the app in the tray so schedules keep running. It can start with the OS.
- Used two ways, about equally: as a quick launcher (hotkey, pick, run, glance, hide), and left open next to other work to watch runs, schedules and history.
- The mouse is the main input. Existing shortcuts stay: `Ctrl/Cmd+K` or `/` to search, `Enter` to open the first match, `Escape` to go back.
- Scripts folder default is `~/yenae-scripts`. Each folder with a `package.json` is a project, scripts live in `<project>/scripts/**`, and shared code lives in `lib/`. The engine writes `AGENTS.md`, `CLAUDE.md`, `.mcp.json` and `.yenae/sdk` there for agents.

## Capabilities and Constraints

- Engine: a Bun process that scans the workspace, reads each script's form by importing it in "describe" mode, runs scripts over Bun IPC, stores history in SQLite, runs interval schedules, and serves an HTTP API, WebSocket and MCP at `127.0.0.1:47321` behind a token.
- Run states: running, waiting (for an answer), and finished runs with exit status. Stop ends a script and anything it started.
- Default window is 1040×700. The layout also works down to phone width, and nothing may scroll sideways.
- Follows the system light or dark theme.
- UI text is short and plain.
- Simplicity and reliability come before features.
- Verified on Linux only. Windows and macOS builds have not been run yet.

## Brand Commitments

- Name: Yenae Script.
- Voice: concise and plain; no marketing tone inside the app.

## Evidence on Hand

- Example workspace: `examples/workspace` (`chrome-tools/update-extension.ts` mirrors an unpacked Chrome extension from a zip URL every 10 minutes; `demo/` has hello and disk-usage scripts).
- App icon: `apps/desktop/src-tauri/icons/icon.svg`.
- No users, testimonials, or release yet. Do not invent any.

## Product Principles

1. One flow: pick, fill, run, watch, review. Anything that does not serve it waits.
2. Simple and reliable over clever. A schedule that silently fails is worse than a missing feature.
3. Scripts are plain files. Nothing should lock scripts to the app.
4. Write with agents, run with the app. The app connects to the user's agents and never brings its own.
5. Quiet by default. The app is a tool the user glances at, so it should never get in the way.
