# Releases

Not set up yet: no CI runs until it's wanted.

## What's verified

- Engine, SDK and examples: tested on Linux (`bun test`), including running scripts, prompts, stop, schedules and MCP.
- UI: checked in Chromium at desktop and phone widths.
- Tauri shell: compiles on Linux.
- **Not verified:** Windows and macOS builds. Things to check by hand on the first Windows build:
  - the bundled `bun.exe` starts and the window shows scripts
  - Stop ends a script and anything it started (uses `taskkill /T`)
  - "Edit with Claude Code" opens a terminal (Windows Terminal if installed, else `cmd`)
  - Start with Windows, then reboot: the app starts in the tray and schedules run
  - `Ctrl+Shift+Space` toggles the window

## Proposed workflow

Save as `.github/workflows/release.yml` when CI is wanted. It runs only on a version tag, so normal pushes use no Actions minutes. It builds Windows first; the macOS and Linux entries can be dropped to save minutes (macOS minutes cost 10× on private repos).

```yaml
name: release
on:
  push:
    tags: ["v*"]
  workflow_dispatch:

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            target: x86_64-pc-windows-msvc
          - os: macos-latest
            target: aarch64-apple-darwin
          - os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
    runs-on: ${{ matrix.os }}
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}
      - uses: swatinem/rust-cache@v2
        with:
          workspaces: apps/desktop/src-tauri
      - if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev
      - run: bun install
      - run: bun test
      - run: bun scripts/prepare.ts --target ${{ matrix.target }}
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          projectPath: apps/desktop
          tauriScript: bun x tauri
          args: --target ${{ matrix.target }}
          tagName: ${{ github.ref_name }}
          releaseName: Yenae Script ${{ github.ref_name }}
          releaseDraft: true
```

Code signing is left out. Unsigned Windows installers show a SmartScreen warning ("More info → Run anyway"). Unsigned macOS apps need right-click → Open the first time.
