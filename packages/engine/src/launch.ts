import { dirname } from "node:path";


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

/** Shows a file in the system's file manager (Explorer on Windows), selected where it can. */
export function revealPath(path: string) {
  const cmd =
    process.platform === "win32"
      ? ["explorer.exe", `/select,${path}`]
      : process.platform === "darwin"
        ? ["open", "-R", path]
        : ["xdg-open", dirname(path)];
  Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true } as any);
}
