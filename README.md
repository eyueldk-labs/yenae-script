# Yenae Script

A small desktop app for your own TypeScript scripts. Pick a script, fill in its form, run it, and watch the output. Scripts can ask questions while they run, show tables and markdown, and run on a schedule from the tray. Each script is a card that says what it does; star the ones you use most and drag scripts onto each other to make folders. Click one and its form opens beside the list. Anything that needs you, a question waiting for an answer or a schedule that failed, shows at the top in plain words. Local agents (Claude Code, Codex, …) can write and run scripts through its MCP server.

## How scripts are organised

Your scripts folder (default `~/yenae-scripts`, changeable in Settings) holds projects. Each project is one npm package:

```
yenae-scripts/
  chrome-tools/
    package.json        # dependencies for this project's scripts
    scripts/
      update-extension.ts
    lib/mirror.ts       # shared code, not listed
  AGENTS.md             # conventions, read by agents
  .mcp.json             # points agents at the app's MCP server
```

Every `.ts` file under a project's `scripts/` is a script; sub-folders group them in the list. When `package.json` changes, the app runs `bun install` for that project.

```ts
import { defineScript, text, folder, ask, show } from "yenae-script";

export default defineScript({
  name: "Update unpacked extension",
  params: { zipUrl: text(), target: folder() },
  icon: "download",                    // the tile icon (see ICONS in the SDK)
  schedule: { every: "10m" },          // suggested; switched on in the app
  async run({ zipUrl, target }) {
    if (!(await ask.confirm(`Mirror into ${target}?`))) return;
    show.markdown("**Done**");
  },
});
```

A file without `defineScript` runs top to bottom with no form. Favourites, folders and order are kept by the app, not on disk, so arranging never moves a file. The app writes the full API into `AGENTS.md` in your scripts folder (source: `packages/engine/src/workspace.ts`).

## Agents

- **MCP:** the app serves MCP at `http://127.0.0.1:47321/mcp` (token in `.mcp.json`). Tools: `guide`, `list_scripts`, `read_file`, `write_file`, `create_project`, `run_script`, `answer_question`, `get_run`, `stop_run`, `list_runs`, `set_schedule`.
- **Harnesses:** "Write with Claude Code" (or Codex, Gemini CLI, OpenCode, whichever is on PATH) opens it in a terminal in your scripts folder with the task. Yenae Script has no agent of its own.

## Layout

| Path | What |
| --- | --- |
| `packages/sdk` | `yenae-script`, the API scripts import. No dependencies. |
| `packages/engine` | Bun process: finds scripts, runs them, history (SQLite), schedules, HTTP API, MCP. |
| `apps/desktop` | Tauri 2 shell (tray, hotkey, autostart) and the React UI. |
| `examples/workspace` | Example projects, including the Chrome extension updater. |
| `scripts/prepare.ts` | Builds the engine and downloads the pinned Bun that the app ships. |

How it fits together: the Tauri app starts the bundled Bun with the engine and talks to it over `127.0.0.1` with a token. The engine starts each run as `bun runner.js run <script>` in the project folder. Prompts and results go over Bun's IPC channel, so `console.log` stays plain output. To read a script's form, the engine imports it in "describe" mode, which never calls `run`.

## Develop

Needs Bun 1.3+ and, for the desktop shell, Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
bun install
bun run dev:engine        # engine on :47321 using examples/workspace
bun run dev:ui            # UI at http://localhost:1420/?token=<token from .dev-data/settings.json>
bun run app:dev           # the real desktop app
bun test                  # engine, SDK and example tests
bun run app:build         # installer for this OS
```

Hotkey: `Ctrl+Shift+Space` (`Cmd+Shift+Space` on macOS) shows or hides the window. Closing the window keeps the app in the tray so schedules keep running.

## Install, update, uninstall

**[Download for Windows](https://github.com/eyueldk-labs/yenae-script/releases/latest/download/Yenae-Script-Setup.exe)** (or the [download page](https://eyueldk-labs.github.io/yenae-script/); Linux: [AppImage](https://github.com/eyueldk-labs/yenae-script/releases/latest/download/Yenae-Script.AppImage), [.deb](https://github.com/eyueldk-labs/yenae-script/releases/latest/download/yenae-script.deb)). The setup asks you to press Install, then offers to open the app. Updates download by themselves and apply when nothing is running; most are a small bundle that installs in seconds. Uninstall from Windows Settings → Apps. See [docs/release.md](docs/release.md) for making releases.

## Status

Built and tested on Linux. Windows and macOS builds have not been run yet; see [docs/release.md](docs/release.md).
