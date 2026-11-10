import { existsSync } from "node:fs";
import { join, resolve, relative, sep, isAbsolute } from "node:path";

/** The Bun that runs the engine also runs scripts. In the app it is the bundled sidecar. */
export const BUN = process.execPath;

/** runner.js sits next to the bundled engine; in development we run the .ts source. */
export const RUNNER = existsSync(join(import.meta.dir, "runner.js"))
  ? join(import.meta.dir, "runner.js")
  : join(import.meta.dir, "runner.ts");

/** The SDK source copied into each workspace at .yenae/sdk. */
export const SDK_SOURCE = existsSync(join(import.meta.dir, "sdk", "index.ts"))
  ? join(import.meta.dir, "sdk", "index.ts")
  : join(import.meta.dir, "..", "..", "sdk", "src", "index.ts");

export const toPosix = (p: string) => p.split(sep).join("/");

/** Resolve a workspace-relative path, refusing anything outside the workspace. */
export function insideWorkspace(workspace: string, rel: string): string {
  const abs = resolve(workspace, rel);
  const r = relative(workspace, abs);
  if (r.startsWith("..") || isAbsolute(r)) throw new Error(`Path is outside the workspace: ${rel}`);
  return abs;
}

/** "30s" | "10m" | "2h" | "1d" | "15" (minutes) -> milliseconds. */
export function parseEvery(every: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)?s?\s*$/i.exec(every);
  if (!m) throw new Error(`Can't read interval "${every}". Use e.g. 30s, 10m, 2h, 1d.`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase()[0];
  const ms = n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as "s" | "m" | "h" | "d"];
  if (ms < 10_000) throw new Error("The shortest interval is 10 seconds.");
  return ms;
}
