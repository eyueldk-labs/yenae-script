import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUN } from "./paths";

const inflight = new Map<string, Promise<void>>();

/**
 * Run `bun install` in a project when package.json changed since the last install,
 * or node_modules is missing. Each project is its own npm package.
 */
export function ensureInstalled(projectDir: string, log?: (line: string) => void): Promise<void> {
  const existing = inflight.get(projectDir);
  if (existing) return existing;
  const p = doInstall(projectDir, log).finally(() => inflight.delete(projectDir));
  inflight.set(projectDir, p);
  return p;
}

async function doInstall(projectDir: string, log?: (line: string) => void) {
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
  if (!hasDeps) return;
  const stampPath = join(projectDir, "node_modules", ".yenae-installed");
  const want = stamp(projectDir, pkg);
  if (existsSync(stampPath) && readFileSync(stampPath, "utf8") === want) return;

  log?.("Installing packages…");
  const proc = Bun.spawn([BUN, "install"], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
  } as any);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error((err || out).trim().split("\n").slice(-5).join("\n") || `bun install exited ${code}`);
  // bun install may rewrite the lockfile; stamp what's on disk now.
  writeFileSync(stampPath, stamp(projectDir, pkg));
  log?.("Packages installed.");
}

/**
 * What the install depends on: package.json, the lockfile, and the files of local
 * `file:` dependencies (like the workspace's copy of the SDK), which bun copies.
 */
function stamp(projectDir: string, pkg: any): string {
  const mtime = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  const parts = [mtime(join(projectDir, "package.json")), mtime(join(projectDir, "bun.lock")), mtime(join(projectDir, "bun.lockb"))];
  for (const spec of Object.values({ ...pkg.dependencies, ...pkg.devDependencies }) as string[]) {
    if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
    const dir = resolve(projectDir, spec.slice(5));
    try {
      for (const f of readdirSync(dir)) parts.push(mtime(join(dir, f)));
    } catch {}
  }
  return parts.join(":");
}
