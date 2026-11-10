# Releases

The workflow is [`.github/workflows/release.yml`](../.github/workflows/release.yml). It runs only when you ask, so normal pushes use no Actions minutes.

## One-time setup

1. **Make the repository public.** Installed apps check `https://github.com/eyueldk-labs/yenae-script/releases/latest/download/latest.json` for new versions, which only works for a public repository.
2. **Add the signing key.** Settings → Secrets and variables → Actions → New repository secret, named `TAURI_SIGNING_PRIVATE_KEY`, holding the private key (it has no password). Keep a copy somewhere safe: installed apps only accept updates signed with this key, so losing it means everyone reinstalls by hand. The matching public key is `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json`. To make a new pair: `bun x tauri signer generate --ci -p "" -w yenae-updater.key` (then update the pubkey and the secret).

## Make a release

- **From GitHub:** Actions → release → Run workflow. Type the new version (e.g. `0.2.0`) and what's new in plain words, lines separated by `|` (e.g. `Faster start | Clearer error messages`). Left empty, the notes are the commit titles since the last release.
- **With a tag:** `git tag v0.2.0` then `git push origin v0.2.0` (notes from commit titles).

Each release needs a higher version than the last. The notes show in the app once, as "Updated to 0.2.0 · What's new", so write them for the people using it.

The workflow:

1. **prepare** opens a draft release `v<version>` with the notes.
2. **test** runs typecheck and `bun test` on Linux and Windows (it doesn't block the builds; a red test says what broke).
3. **build** makes the Windows `.exe` setup and the Linux `.AppImage` and `.deb`, signed for the updater, into the draft.
4. **publish** builds the small update (engine + interface, `yenae-bundle-<version>.zip`, about 230 KB), signs it, writes `bundle.json`, adds fixed-name copies of the installers, and publishes the release. Nothing is visible to installed apps until this last step.

## Updates

Installed apps check a few seconds after they start and every six hours. There are two kinds:

- **Small** (most releases): `bundle.json` lists the release's bundle under `bundle-<shell id>`. The shell ID (`scripts/shell-id.ts`) is a fingerprint of everything a bundle can't replace: the Rust shell, its config, icons, installer files and the bundled Bun. An app whose shell matches downloads the bundle, checks its signature, unpacks it into its data folder, restarts the engine from it and reloads the window from it. No installer runs.
- **Full**: when the shell changed, the app downloads the signed installer (`latest.json`) and runs it quietly; the app reopens as it was (in the tray or with its window).

Either way, updates download in the background and apply only when no script is running and no schedule is due in the next five minutes: by themselves while the window is hidden, or when "Restart to update" is pressed. If a new version's engine or window doesn't start, the app goes back to the version before and never tries that one again. After an update the app shows "Updated to X · What's new" once.

To test updates locally, a debug build (`bun x tauri build --debug --no-bundle`) accepts `YENAE_BUNDLE_FEED=http://127.0.0.1:8787/bundle.json` and `YENAE_CHECK_SECS=10`.

## Download links

These always get the newest release:

- Windows: `https://github.com/eyueldk-labs/yenae-script/releases/latest/download/Yenae-Script-Setup.exe`
- Linux: `.../latest/download/Yenae-Script.AppImage` and `.../latest/download/yenae-script.deb`

The download page (`site/`) is published to GitHub Pages by `.github/workflows/pages.yml` whenever it changes.

## Install and uninstall

- **Windows:** the setup is one click: it installs for the current user, adds Start menu and desktop shortcuts, and opens the app. A new scripts folder starts with two example scripts. Uninstall from Settings → Apps → Installed apps → Yenae Script; the uninstaller stops the app and its bundled Bun, removes "Start with Windows", and offers to delete app data (history, settings). Your scripts folder is never touched.
- **Linux:** `sudo apt remove yenae-script` for the `.deb`; delete the file for the `.AppImage`.
- The installer is a copy of Tauri's NSIS template with the welcome, folder and finish pages removed (`apps/desktop/src-tauri/windows/installer.nsi`). Refresh it from Tauri when upgrading `@tauri-apps/cli`.

## What's verified

- Engine, SDK and examples: tested on Linux (`bun test`), including running scripts, prompts, stop, schedules and MCP.
- UI: checked in Chromium at desktop and phone widths, light and dark.
- Tauri shell: builds a Linux `.deb` and `.AppImage` here (bundled Bun and engine included).
- Small updates: tested end to end in a Linux debug build on a virtual display (applies by itself while hidden, "Restart to update" while open, rollback from a broken bundle, interface served from the bundle).
- Windows: v0.1.0 built and installed; engine tests pass on Windows CI.
- **Not verified yet on Windows** (check by hand):
  - the one-click installer opens the app when done
  - a full update installs quietly and reopens the app
  - uninstall removes "Start with Windows" and stops the bundled Bun
  - the bundled `bun.exe` starts and the window shows scripts
  - Browse buttons on file and folder inputs open the Windows picker
  - Stop ends a script and anything it started (uses `taskkill /T`)
  - "Edit with Claude Code" opens a terminal (Windows Terminal if installed, else `cmd`)
  - Start with Windows, then reboot: the app starts in the tray and schedules run
  - the tray tooltip says "1 needs you" when a schedule fails
  - `Ctrl+Shift+Space` shows the window with the cursor in search

Code signing is left out. Unsigned Windows installers show a SmartScreen warning ("More info → Run anyway").
