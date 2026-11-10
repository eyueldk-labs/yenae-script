# Releases

The workflow is [`.github/workflows/release.yml`](../.github/workflows/release.yml). It runs only when you ask, so normal pushes use no Actions minutes.

## Make an installer

Either:

- **From GitHub:** Actions → release → Run workflow.
- **With a tag:** set `version` in `apps/desktop/src-tauri/tauri.conf.json`, commit, then:

  ```bash
  git tag v0.1.0
  ```

  ```bash
  git push origin v0.1.0
  ```

Both build Windows (`.exe` setup) and Linux (`.deb` and `.AppImage`). macOS is left out for now. The installers land on a **draft** release named `v<version>` (Releases page). Check it, then publish it.

Two jobs run side by side:

- **test**: typecheck and `bun test` on Linux and Windows.
- **build**: the installer. It doesn't wait for tests, so a test that fails on a new platform still leaves an installer to try; the red test job says what broke.

## What's verified

- Engine, SDK and examples: tested on Linux (`bun test`), including running scripts, prompts, stop, schedules and MCP.
- UI: checked in Chromium at desktop and phone widths, light and dark.
- Tauri shell: builds a Linux `.deb` here (bundled Bun and engine included).
- **Not verified:** the Windows build. Things to check by hand on the first Windows build:
  - the bundled `bun.exe` starts and the window shows scripts
  - Browse buttons on file and folder inputs open the Windows picker
  - Stop ends a script and anything it started (uses `taskkill /T`)
  - "Edit with Claude Code" opens a terminal (Windows Terminal if installed, else `cmd`)
  - Start with Windows, then reboot: the app starts in the tray and schedules run
  - the tray tooltip says "1 needs you" when a schedule fails
  - `Ctrl+Shift+Space` shows the window with the cursor in search

Code signing is left out. Unsigned Windows installers show a SmartScreen warning ("More info → Run anyway").
