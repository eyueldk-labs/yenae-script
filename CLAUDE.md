# Working on Yenae Script

The owner's standing preferences for any agent working here.

- **Goal over effort.** An AI does the implementation, so effort is not a reason to pick a weaker option. Recommend what best serves the goal; only rule something out when it is unnecessarily complex for a small gain.
- **Ease of use first.** It must be simple for non-technical people: plain words, few knobs, details on request.
- **Concise UI text.** Nothing scrolls sideways (check 1040x700 and 390x844, light and dark).
- **Check UI changes with Playwright screenshots** before calling them done.
- **Self-contained app.** Never rely on anything installed on the user's machine (Bun ships with the app).
- **Windows is the main platform**, Linux second; macOS is not built yet.
- Commit and push to `main`.
