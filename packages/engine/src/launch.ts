import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Local agent harnesses we can hand a task to. We don't build our own agent:
 * we open the user's harness in a terminal, in the workspace, with a prompt.
 */
export const HARNESSES = [
  { id: "claude", name: "Claude Code", bin: "claude" },
  { id: "codex", name: "Codex", bin: "codex" },
  { id: "gemini", name: "Gemini CLI", bin: "gemini" },
  { id: "opencode", name: "OpenCode", bin: "opencode" },
] as const;

export function detectHarnesses() {
  return HARNESSES.filter((h) => Bun.which(h.bin)).map(({ id, name }) => ({ id, name }));
}

/**
 * Open a terminal in `cwd` running the harness with a prompt. The prompt is written to a
 * file and the harness is told to read it, which avoids shell-quoting on every platform.
 */
export function launchHarness(harnessId: string, cwd: string, prompt: string) {
  const h = HARNESSES.find((x) => x.id === harnessId);
  if (!h || !Bun.which(h.bin)) throw new Error(`${h?.name ?? harnessId} isn't installed or isn't on PATH.`);
  const dir = join(cwd, ".yenae", "tasks");
  mkdirSync(dir, { recursive: true });
  const name = `task-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  writeFileSync(join(dir, name), prompt);
  const short = `Read .yenae/tasks/${name} and do what it asks.`;
  openTerminal(cwd, [h.bin, short]);
}

function openTerminal(cwd: string, argv: string[]) {
  const quoted = argv.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, "")}"` : a)).join(" ");
  if (process.platform === "win32") {
    const wt = Bun.which("wt");
    const cmd = wt
      ? [wt, "-d", cwd, "cmd", "/k", quoted]
      : ["cmd.exe", "/c", "start", "Yenae Script", "/D", cwd, "cmd", "/k", quoted];
    Bun.spawn(cmd, { cwd, stdio: ["ignore", "ignore", "ignore"] });
  } else if (process.platform === "darwin") {
    const script = `cd ${JSON.stringify(cwd)} && ${quoted}`;
    Bun.spawn(["osascript", "-e", `tell application "Terminal" to do script ${JSON.stringify(script)}`, "-e", 'tell application "Terminal" to activate'], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } else {
    const term = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"].find((t) => Bun.which(t));
    if (!term) throw new Error("No terminal found.");
    const args = term === "gnome-terminal" ? ["--", ...argv] : ["-e", quoted];
    Bun.spawn([term, ...args], { cwd, stdio: ["ignore", "ignore", "ignore"] });
  }
}

/** Open a file in VS Code if it's installed, else in the OS default app. */
export function openInEditor(workspace: string, file: string) {
  const code = Bun.which("code") ?? Bun.which("cursor");
  if (code) {
    Bun.spawn([code, workspace, "--goto", file], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true } as any);
    return;
  }
  openPath(file);
}

export function openPath(path: string) {
  const cmd =
    process.platform === "win32"
      ? ["cmd.exe", "/c", "start", "", path]
      : process.platform === "darwin"
        ? ["open", path]
        : ["xdg-open", path];
  Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true } as any);
}
