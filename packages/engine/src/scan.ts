import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, basename, dirname, extname } from "node:path";
import type { ScriptMeta } from "yenae-script";
import { BUN, RUNNER, toPosix } from "./paths";
import type { Store } from "./db";
import { ensureInstalled } from "./install";

export interface Project {
  /** Workspace-relative folder, e.g. "chrome-tools" or "work/reports". */
  id: string;
  dir: string;
  name: string;
  scriptsDir: string;
}

export interface ScriptInfo {
  /** Workspace-relative path: "chrome-tools/scripts/update-extension.ts". */
  id: string;
  project: string;
  /** Sub-folder inside the project's scripts folder, "" at its root. */
  folder: string;
  path: string;
  name: string;
  description?: string;
  params: ScriptMeta["params"];
  schedule?: ScriptMeta["schedule"];
  /** No defineScript: runs as-is, no form. */
  plain: boolean;
  /** The file calls ask.* itself, so a run can stop and wait for an answer. Helpers in lib/ aren't seen. */
  asks: boolean;
  error?: string;
}

const SCRIPT_EXT = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage"]);

export function findProjects(workspace: string, depth = 3): Project[] {
  const out: Project[] = [];
  const walk = (dir: string, d: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (dir !== workspace && entries.some((e) => e.isFile() && e.name === "package.json")) {
      let pkg: any = {};
      try {
        pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {}
      const scriptsDir = join(dir, pkg?.yenae?.scripts ?? "scripts");
      out.push({ id: toPosix(relative(workspace, dir)), dir, name: pkg.name ?? basename(dir), scriptsDir });
      return; // a project doesn't contain other projects
    }
    if (d === 0) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) walk(join(dir, e.name), d - 1);
    }
  };
  walk(workspace, depth);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function findScriptFiles(project: Project): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && e.name !== "lib") walk(p);
      } else if (SCRIPT_EXT.has(extname(e.name)) && !/\.(test|spec|d)\.[mc]?[tj]sx?$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(project.scriptsDir);
  return out.sort();
}

/** "update-extension.ts" -> "Update extension" */
function titleFromFile(file: string) {
  const s = basename(file, extname(file)).replace(/[-_.]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function describe(path: string, cwd: string, timeoutMs = 20_000): Promise<ScriptMeta | null> {
  const proc = Bun.spawn([BUN, RUNNER, "describe", path], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    serialization: "json",
    windowsHide: true,
    env: { ...process.env, YENAE_DESCRIBE: "1" },
    ipc(msg: any) {
      if (msg?.t === "meta") meta = msg.meta;
    },
  } as any);
  let meta: ScriptMeta | null | undefined;
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stderr] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  if (meta === undefined) {
    const msg = stderr.trim().split("\n").slice(-6).join("\n") || `exit code ${code}`;
    throw new Error(msg);
  }
  return meta;
}

/** A tiny concurrency limiter, so a big workspace doesn't spawn 100 processes at once. */
function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
const limit = limiter(4);

export async function scanWorkspace(workspace: string, store: Store): Promise<{ projects: Project[]; scripts: ScriptInfo[] }> {
  const projects = findProjects(workspace);
  const scripts: ScriptInfo[] = [];
  await Promise.all(
    projects.map(async (project) => {
      const files = findScriptFiles(project);
      // Install once per project before describing, so imports resolve.
      let installError: string | undefined;
      if (files.length) {
        try {
          await ensureInstalled(project.dir);
        } catch (e: any) {
          installError = `Install failed: ${e.message}`;
        }
      }
      await Promise.all(
        files.map((path) =>
          limit(async () => {
            const info: ScriptInfo = {
              id: toPosix(relative(workspace, path)),
              project: project.id,
              folder: toPosix(relative(project.scriptsDir, dirname(path))).replace(/^\.$/, ""),
              path,
              name: titleFromFile(path),
              params: {},
              plain: true,
              asks: false,
            };
            let source = "";
            try {
              source = readFileSync(path, "utf8");
            } catch {}
            info.asks = /\bask\s*\.\s*(?:text|select|confirm|file|folder)\s*\(/.test(source);
            if (!/\bdefineScript\s*\(/.test(source)) {
              // Plain script: describing would run it, so read only a leading comment.
              const m = /^\s*(?:\/\/\s*(.+)|\/\*\*?\s*\n?\s*\*?\s*(.+))/.exec(source);
              const d = (m?.[1] ?? m?.[2])?.trim();
              if (d && !d.startsWith("@")) info.description = d.replace(/\*\/$/, "").trim();
              scripts.push(info);
              return;
            }
            info.plain = false;
            const st = statSync(path);
            const lock = ["bun.lock", "bun.lockb", "package.json"]
              .map((f) => join(project.dir, f))
              .filter(existsSync)
              .map((f) => statSync(f).mtimeMs)
              .join(",");
            const stamp = `${st.mtimeMs}:${st.size}:${lock}`;
            let meta: ScriptMeta | null;
            const cached = store.cachedMeta(path, stamp);
            if (cached) meta = cached.meta as ScriptMeta | null;
            else {
              try {
                meta = await describe(path, project.dir);
                store.cacheMeta(path, stamp, meta);
              } catch (e: any) {
                info.error = installError ?? e.message;
                scripts.push(info);
                return;
              }
            }
            if (meta) {
              info.name = meta.name || info.name;
              info.description = meta.description;
              info.params = meta.params ?? {};
              info.schedule = meta.schedule;
            } else info.plain = true;
            scripts.push(info);
          }),
        ),
      );
    }),
  );
  scripts.sort((a, b) => a.id.localeCompare(b.id));
  return { projects, scripts };
}
