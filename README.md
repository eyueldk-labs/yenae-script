# Yenae Script

A small desktop app for your own TypeScript scripts. Pick a script, fill in its form, run it, and watch the output. Scripts can ask questions while they run, show tables and markdown, and run on a schedule from the tray. Each script is a card that says what it does; drag scripts onto each other to make groups, and into any order. The tray's right-click menu runs any script, laid out the same way. Click one and its form opens beside the list. Anything that needs you, a question waiting for an answer or a schedule that failed, shows at the top in plain words. Local agents (Claude Code, Codex, …) can write and run scripts through its MCP server.

## How scripts are organised

Your scripts folder (default `~/yenae-scripts`, changeable in Settings) holds packages. Each package is one npm package with one or more scripts; a new script gets a package of its own:

```
yenae-scripts/
  chrome-tools/
    package.json        # npm packages for this package's scripts
    scripts/
      update-extension.ts
    lib/mirror.ts       # shared code, not listed
  AGENTS.md             # conventions, read by agents
  .mcp.json             # points agents at the app's MCP server
```

Every `.ts` file under a package's `scripts/` is a script. When `package.json` changes, the app runs `bun install` for that package.

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

A file without `defineScript` runs top to bottom with no form. Groups and order are kept by the app, not on disk, so arranging never moves a file; a script can be in several groups. The app writes the full API into `AGENTS.md` in your scripts folder (source: `packages/engine/src/workspace.ts`).

## Agents

- **MCP:** the app serves MCP at `http://127.0.0.1:47321/mcp` (token in `.mcp.json`). Settings → **Use with your AI apps** connects Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, VS Code (Copilot) and OpenCode in one click, or shows the steps (`packages/engine/src/ai-clients.ts`). Claude Desktop goes through `.yenae/mcp-bridge.js`, run by the bundled Bun. Tools: `guide`, `list_scripts`, `read_file`, `write_file`, `create_package`, `run_script`, `answer_question`, `get_run`, `stop_run`, `list_runs`, `set_schedule`.
- **Agents:** New script, "Change what it does…" and "Ask Claude to fix it" run the person's own coding agent (Claude Code, Codex, Gemini CLI or OpenCode, whichever is installed) headless in the scripts folder: no terminal window. Its steps and summary stream into the script's panel as a run, Stop ends it, and History keeps it (`packages/engine/src/agents.ts`). Yenae Script has no agent of its own.

## Layout

| Path | What |
| --- | --- |
| `packages/sdk` | `yenae-script`, the API scripts import. No dependencies. |
| `packages/engine` | Bun process: finds scripts, runs them, history (SQLite), schedules, HTTP API, MCP. |
| `apps/desktop` | Tauri 2 shell (tray, hotkey, autostart) and the React UI. |
| `examples/workspace` | Example packages, including the Chrome extension updater. |
| `scripts/prepare.ts` | Builds the engine and downloads the pinned Bun that the app ships. |

How it fits together: the Tauri app starts the bundled Bun with the engine and talks to it over `127.0.0.1` with a token. The engine starts each run as `bun runner.js run <script>` in the package folder. Prompts and results go over Bun's IPC channel, so `console.log` stays plain output. To read a script's form, the engine imports it in "describe" mode, which never calls `run`.

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
