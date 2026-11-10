# Releases

The workflow is [`.github/workflows/release.yml`](../.github/workflows/release.yml). It runs only when you ask, so normal pushes use no Actions minutes.

## One-time setup

1. **Make the repository public.** Installed apps check `https://github.com/eyueldk-labs/yenae-script/releases/latest/download/latest.json` for new versions, which only works for a public repository.
2. **Add the signing key.** Settings → Secrets and variables → Actions → New repository secret, named `TAURI_SIGNING_PRIVATE_KEY`, holding the private key (it has no password). Keep a copy somewhere safe: installed apps only accept updates signed with this key, so losing it means everyone reinstalls by hand. The matching public key is `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json`. To make a new pair: `bun x tauri signer generate --ci -p "" -w yenae-updater.key` (then update the pubkey and the secret).

## Make a release

Either:

- **From GitHub:** Actions → release → Run workflow, and type the new version (e.g. `0.2.0`). Leave it empty to use the version in `tauri.conf.json`.
- **With a tag:** `git tag v0.2.0` then `git push origin v0.2.0` (the tag sets the version).

Each release needs a version higher than the last, or installed apps won't see it as an update.

Both build Windows (`.exe` setup) and Linux (`.deb` and `.AppImage`), and publish them straight away as release `v<version>` with `latest.json` (the signed update info). macOS is left out for now.

Two jobs run side by side:

- **test**: typecheck and `bun test` on Linux and Windows.
- **build**: the installers and update files. It doesn't wait for tests, so a test that fails on a new platform still leaves an installer to try; the red test job says what broke.

## Updates

The app checks for a newer release a few seconds after it starts and every six hours. When there is one, a row at the top says "Version 0.2.0 is ready" with **Update and restart**; Settings shows the current version and **Check for updates**. On Windows the update runs the installer quietly and reopens the app; the Linux `.AppImage` replaces itself. The `.deb` doesn't self-update (install the new `.deb`).

## Uninstall

- **Windows:** Settings → Apps → Installed apps → Yenae Script → Uninstall (or Control Panel → Programs). The uninstaller stops the app and its bundled Bun, removes "Start with Windows", and offers to delete app data (history, settings). Your scripts folder (`~/yenae-scripts` by default) is never touched.
- **Linux:** `sudo apt remove yenae-script` for the `.deb`; delete the file for the `.AppImage`.

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
